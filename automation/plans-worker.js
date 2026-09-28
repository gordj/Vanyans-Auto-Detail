/**
 * Vanyan's Auto Detail: nonstop maintenance plans.
 *
 * Cal.com caps a repeating booking at 32 visits, so plans can't repeat forever there.
 * This Cloudflare Worker keeps each member booked a few visits ahead at their standing
 * slot for as long as their Stripe plan is active, and clears their calendar when it ends.
 *
 * Every hour (cron):
 *   1. Read every booking on the three plan event types from Cal.com.
 *   2. Group them by member email. The member's most recent booking that THEY made
 *      (not one this worker made) is their standing slot: day of week, time, cadence.
 *   3. Ask Stripe whether that email has a live plan.
 *        live   -> make sure every visit in the next 5 weeks (and at least the next 2) is booked
 *        ended  -> cancel all of that member's future plan visits
 *        none   -> change nothing, email the owner (probably a different email at checkout)
 *   4. A visit the member cancelled or moved is never re-booked (any booking at that time,
 *      whatever its status, counts as handled). If the slot is taken by another job, book
 *      nothing and email the owner. Nobody is ever moved to a time they didn't pick.
 *   5. Email the owner a short summary of anything new.
 *
 * Settings (Cloudflare dashboard > this worker > Settings):
 *   CAL_API_KEY   secret   Cal.com > Settings > Developer > API keys
 *   STRIPE_KEY    secret   Stripe restricted key: Customers Read, Subscriptions Read
 *   DRY_RUN       text     "1" = report only, change nothing (default). "0" = live.
 *   STATE         KV       remembers the last run, each member's standing slot, and which alerts were sent
 *   MAILER        email    send_email binding, destination vanyansdetailing@gmail.com
 *   BUDGET        text     optional. Outside requests per run, default 40. Use 900 on Workers Paid.
 */
import { EmailMessage } from "cloudflare:email";

const TZ = "America/Los_Angeles";
const CAL = "https://api.cal.com/v2";
const PLANS = {
  7208693: { weeks: 1, name: "Weekly" },
  7208694: { weeks: 2, name: "Every two weeks" },
  7208695: { weeks: 4, name: "Monthly" },
};
const HORIZON_MS = 35 * 86400e3;     // keep every visit in the next 5 weeks booked
const MIN_AHEAD = 2;                 // and never fewer than the next 2 visits
const NOTICE_MS = 17 * 3600e3;       // same as the Cal.com minimum notice
const SAME_SLOT_MS = 30 * 60e3;      // two bookings this close are the same visit
const LIVE = new Set(["active", "trialing", "past_due"]);        // past_due: Stripe is still retrying
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);
const OWNER = "vanyansdetailing@gmail.com";
const SENDER = "plans@vanyansautodetail.com";
const LOOKBACK_MS = 14 * 86400e3;    // after the first run, only read bookings from the last 2 weeks on
const STALE_MS = 6 * 3600e3;         // warn if a member has gone this long without being checked
const DEFAULT_BUDGET = 40;           // outside requests per run (Workers Free allows 50)

// Outside requests (Cal.com + Stripe) made by the current run. When the budget is spent the run
// stops cleanly and the members it did not reach go first next time.
let used = 0;
let budget = DEFAULT_BUDGET;
class BudgetError extends Error {}
function spend() {
  if (used >= budget) throw new BudgetError("request budget used up");
  used++;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const last = env.STATE ? await env.STATE.get("last-run") : null;
      return new Response(last || '{"note":"not run yet"}', { headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  },
};

export async function run(env, now = Date.now()) {
  const dry = env.DRY_RUN !== "0";
  used = 0;
  budget = Number(env.BUDGET) || DEFAULT_BUDGET;
  const report = { at: new Date(now).toISOString(), dry, members: 0, deferred: 0, booked: [], cancelled: [], conflicts: [], warnings: [] };
  try {
    if (!env.CAL_API_KEY || !env.STRIPE_KEY) throw new Error("CAL_API_KEY or STRIPE_KEY is not set");
    const known = new Set(await kvJson(env, "members", []));
    const knownBefore = JSON.stringify([...known].sort());
    const checked = await kvJson(env, "checked", {});
    const firstRun = !(await kvGet(env, "bootstrapped"));
    // First run reads all history once to learn every member's standing slot. After that, only recent
    // bookings are read; standing slots come from KV, so the read never grows with the years.
    const bookings = await listPlanBookings(env, firstRun ? null : now - LOOKBACK_MS, report);
    const byEmail = new Map();
    for (const b of bookings) {
      const email = String(b.attendees?.[0]?.email || "").toLowerCase();
      if (!email) continue;
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(b);
    }
    const emails = [...new Set([...byEmail.keys(), ...known])];
    emails.sort((a, b) => (checked[a] || 0) - (checked[b] || 0)); // least recently checked first
    let stopped = false;
    for (const email of emails) {
      report.members++;
      if (stopped) { report.deferred++; continue; }
      try {
        await syncMember(env, email, byEmail.get(email) || [], now, dry, report, known);
        checked[email] = now;
      } catch (e) {
        if (e instanceof BudgetError) { stopped = true; report.deferred++; continue; }
        report.warnings.push(item(`error:${email}:${now}`, `${email}: ${errText(e)}`));
      }
    }
    for (const email of emails) {
      if (checked[email] && now - checked[email] > STALE_MS && known.has(email)) {
        report.warnings.push(item(`stale:${email}`,
          `${email} has not been checked for over 6 hours (too many members for one run). ` +
          `Set BUDGET higher (Workers Paid) or check the worker.`));
      }
    }
    if (!dry) {
      if (JSON.stringify([...known].sort()) !== knownBefore) await kvPut(env, "members", [...known]);
      await kvPut(env, "checked", checked);
      if (firstRun && !stopped && !report.warnings.some((w) => w.key === "truncated")) await kvPut(env, "bootstrapped", "1");
    }
  } catch (e) {
    report.error = errText(e);
  }
  if (env.STATE) await env.STATE.put("last-run", JSON.stringify(publicReport(report)));
  await notify(env, report);
  return report;
}

/**
 * The member's standing slot: their newest own booking (not one this worker made, and not a
 * visit they merely moved). It is remembered in KV, so cancelling that booking, or the history
 * scrolling out of the recent-bookings window, never erases it.
 */
async function standingSlot(env, email, list) {
  const stored = await kvJson(env, "anchor:" + email, null);
  const top = list
    .filter((b) => !isAuto(b) && !b.rescheduledFromUid && isLive(b))
    .sort((a, b) => Date.parse(b.createdAt || b.start) - Date.parse(a.createdAt || a.start))[0];
  if (top && (!stored || Date.parse(top.createdAt || top.start) > Date.parse(stored.createdAt))) {
    const a = top.attendees?.[0] || {};
    return {
      fresh: true,
      slot: {
        uid: top.uid, typeId: eventTypeId(top), start: top.start, createdAt: top.createdAt || top.start,
        email, name: a.name || "Member", tz: a.timeZone || TZ,
        phone: a.phoneNumber || top.bookingFieldsResponses?.attendeePhoneNumber || null,
        address: addressOf(top),
      },
    };
  }
  return { fresh: false, slot: stored };
}

async function syncMember(env, email, list, now, dry, report, known) {
  const status = await stripeStatus(env, email);
  if (status === "none") {
    report.warnings.push(item(`nostripe:${email}`,
      `${email} booked a plan visit, but no Stripe plan uses this email. Nothing was changed. ` +
      `Check which email they paid with.`));
    return;
  }
  if (status === "pending") return; // first payment still processing: wait for the next run

  const future = list.filter((b) => isLive(b) && Date.parse(b.start) > now);

  if (status === "ended") {
    for (const b of future) {
      if (!dry) await calCancel(env, b.uid, "Maintenance plan ended");
      report.cancelled.push(item(`cancel:${b.uid}`, `${email}: removed ${fmt(Date.parse(b.start))} (plan ended)`));
    }
    known.delete(email); // nothing left to look after; stops paying Stripe requests for old members
    return;
  }

  // live plan
  const { fresh, slot: anchor } = await standingSlot(env, email, list);
  if (!anchor) return; // no slot known and none to learn from: don't invent one
  const plan = PLANS[anchor.typeId];
  if (!plan) return;
  if (fresh && !dry) await kvPut(env, "anchor:" + email, anchor); // written only when it changes
  known.add(email);

  const series = occurrences(Date.parse(anchor.start), plan.weeks, now);

  // automated visits that no longer line up with the member's current slot (they picked a new one).
  // A visit the member moved themselves is left alone.
  for (const b of future.filter((x) => isAuto(x) && !x.rescheduledFromUid)) {
    const t = Date.parse(b.start);
    if (!series.all.some((s) => Math.abs(s - t) < SAME_SLOT_MS)) {
      if (!dry) await calCancel(env, b.uid, "Standing slot changed");
      report.cancelled.push(item(`moved:${b.uid}`, `${email}: removed ${fmt(t)} (they picked a new standing time)`));
    }
  }

  for (const t of series.targets) {
    const handled = list.some((b) => Math.abs(Date.parse(b.start) - t) < SAME_SLOT_MS);
    if (handled) continue; // booked already, or cancelled/moved by the member: leave it
    const free = await calSlotFree(env, anchor.typeId, t);
    if (!free) {
      report.conflicts.push(item(`conflict:${email}:${t}`,
        `${email} (${plan.name}): ${fmt(t)} is already taken, so it was NOT booked. ` +
        `Book them another time or give them a call.`));
      continue;
    }
    if (!dry) await calBook(env, anchor, t);
    report.booked.push(item(`book:${email}:${t}`, `${email} (${plan.name}): booked ${fmt(t)}`));
  }
}

/* ------------------------------------------------------------------ schedule math */

/** Visits at the anchor's local weekday and time, every `weeks` weeks, in Los Angeles time. */
export function occurrences(anchorMs, weeks, now) {
  const a = localParts(anchorMs);
  const stepDays = 7 * weeks;
  const stepMs = stepDays * 86400e3;
  const startK = Math.max(0, Math.floor((now - anchorMs) / stepMs) - 1);
  const all = [];
  const targets = [];
  for (let k = startK; k < startK + 400; k++) {
    const d = new Date(Date.UTC(a.y, a.m - 1, a.d + k * stepDays));
    const t = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), a.hh, a.mm);
    if (t > now + HORIZON_MS + stepMs * (MIN_AHEAD + 1)) break;
    all.push(t);
    if (t <= now + NOTICE_MS) continue;
    if (t <= now + HORIZON_MS || targets.length < MIN_AHEAD) targets.push(t);
  }
  return { all, targets };
}

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function localParts(ms) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second };
}

/** Wall-clock time in Los Angeles -> UTC milliseconds (handles daylight saving). */
export function zonedToUtc(y, m, d, hh, mm) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const p = localParts(t);
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - t;
    const next = wall - offset;
    if (next === t) break;
    t = next;
  }
  return t;
}

export function fmt(ms) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/* ------------------------------------------------------------------ Cal.com */

async function cal(env, path, { method = "GET", body, version }) {
  spend();
  const res = await fetch(CAL + path, {
    method,
    headers: {
      authorization: `Bearer ${env.CAL_API_KEY}`,
      "cal-api-version": version,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === "error") {
    throw new Error(`Cal.com ${method} ${path.split("?")[0]} failed (${res.status}): ` +
      JSON.stringify(json.error || json).slice(0, 300));
  }
  return json;
}

async function listPlanBookings(env, afterMs, report) {
  const ids = Object.keys(PLANS).join(",");
  const out = [];
  let cursor = null;
  let more = false;
  const PAGES = 20; // 2,000 bookings; the recent-only read stays far below this
  for (let page = 0; page < PAGES; page++) {
    const q = `/bookings?eventTypeIds=${ids}&limit=100` +
      (afterMs ? `&afterStart=${encodeURIComponent(new Date(afterMs).toISOString())}` : "") +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const j = await cal(env, q, { version: "2026-05-01" });
    const rows = Array.isArray(j.data) ? j.data : (j.data?.bookings || []);
    out.push(...rows);
    const p = j.pagination || j.data?.pagination || j;
    cursor = p.nextCursor || null;
    more = !!cursor && p.hasMore !== false && rows.length > 0;
    if (!more) break;
  }
  if (more) {
    report.warnings.push(item("truncated",
      "The plan booking list hit its size limit, so some bookings were not read. Tell your developer."));
  }
  return out;
}

async function calSlotFree(env, typeId, t) {
  const day = 86400e3;
  const start = new Date(t - day).toISOString().slice(0, 10);
  const end = new Date(t + day).toISOString().slice(0, 10);
  const j = await cal(env, `/slots?eventTypeId=${typeId}&start=${start}&end=${end}&timeZone=UTC`, { version: "2024-09-04" });
  const map = j.data || {};
  for (const list of Object.values(map)) {
    for (const s of list || []) {
      const st = typeof s === "string" ? s : s.start;
      if (Math.abs(Date.parse(st) - t) < 60e3) return true;
    }
  }
  return false;
}

async function calBook(env, anchor, t) {
  const body = {
    start: new Date(t).toISOString(),
    eventTypeId: anchor.typeId,
    attendee: { name: anchor.name || "Member", email: anchor.email, timeZone: anchor.tz || TZ, language: "en" },
    metadata: { auto: "1", anchor: String(anchor.uid) },
  };
  if (anchor.phone) {
    body.attendee.phoneNumber = anchor.phone;
    body.bookingFieldsResponses = { attendeePhoneNumber: anchor.phone };
  }
  if (anchor.address) body.location = { type: "attendeeAddress", address: anchor.address };
  await cal(env, "/bookings", { method: "POST", body, version: "2026-02-25" });
}

async function calCancel(env, uid, reason) {
  await cal(env, `/bookings/${encodeURIComponent(uid)}/cancel`, {
    method: "POST", body: { cancellationReason: reason }, version: "2026-02-25",
  });
}

const eventTypeId = (b) => Number(b.eventType?.id ?? b.eventTypeId);
const isAuto = (b) => String(b.metadata?.auto || "") === "1";
const isLive = (b) => !["cancelled", "canceled", "rejected"].includes(String(b.status || "").toLowerCase());

function addressOf(b) {
  if (typeof b.location === "string" && b.location && !/^https?:/.test(b.location)) return b.location;
  const r = b.bookingFieldsResponses?.location;
  if (!r) return null;
  if (typeof r === "string") return r;
  return r.optionValue || r.value?.optionValue || (typeof r.value === "string" ? r.value : null);
}

/* ------------------------------------------------------------------ Stripe */

async function stripe(env, path) {
  spend();
  const res = await fetch("https://api.stripe.com" + path, { headers: { authorization: `Bearer ${env.STRIPE_KEY}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${path.split("?")[0]} failed (${res.status}): ${json.error?.message || ""}`);
  return json;
}

/** "live", "ended", "pending" or "none" for everything Stripe has under this email. */
async function stripeStatus(env, email) {
  const q = encodeURIComponent(`email:'${email.replace(/'/g, "\\'")}'`);
  const customers = await stripe(env, `/v1/customers/search?query=${q}&limit=10`);
  let any = false, live = false, ended = true;
  for (const c of customers.data || []) {
    const subs = await stripe(env, `/v1/subscriptions?customer=${c.id}&status=all&limit=20`);
    for (const s of subs.data || []) {
      any = true;
      if (LIVE.has(s.status)) live = true;
      if (!ENDED.has(s.status)) ended = false;
    }
  }
  if (live) return "live";
  if (!any) return "none";
  return ended ? "ended" : "pending";
}

/* ------------------------------------------------------------------ reporting */

const item = (key, text) => ({ key, text });

async function kvGet(env, key) {
  return env.STATE ? await env.STATE.get(key) : null;
}
async function kvPut(env, key, value) {
  if (env.STATE) await env.STATE.put(key, typeof value === "string" ? value : JSON.stringify(value));
}
async function kvJson(env, key, fallback) {
  const s = await kvGet(env, key);
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
const errText = (e) => String((e && e.message) || e).slice(0, 400);

function publicReport(r) {
  const mask = (s) => s.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g, "$1***@");
  const m = (list) => list.map((x) => mask(x.text));
  return { at: r.at, dry: r.dry, members: r.members, deferred: r.deferred, booked: m(r.booked), cancelled: m(r.cancelled),
    conflicts: m(r.conflicts), warnings: m(r.warnings), error: r.error || null };
}

async function notify(env, r) {
  const prefix = r.dry ? "dry:" : "live:";
  const sections = [
    ["Booked", r.booked], ["Removed", r.cancelled], ["Needs you", r.conflicts], ["Heads up", r.warnings],
  ];
  const fresh = [];
  for (const [title, list] of sections) {
    const lines = [];
    for (const x of list) {
      const key = "seen:" + prefix + x.key;
      if (env.STATE && (await env.STATE.get(key))) continue;
      if (env.STATE) await env.STATE.put(key, "1", { expirationTtl: 60 * 86400 });
      lines.push("- " + x.text);
    }
    if (lines.length) fresh.push(title + ":\n" + lines.join("\n"));
  }
  if (r.error) {
    const key = "seen:" + prefix + "error:" + r.error.slice(0, 120);
    if (!(env.STATE && (await env.STATE.get(key)))) {
      if (env.STATE) await env.STATE.put(key, "1", { expirationTtl: 86400 });
      fresh.push("Problem:\n- " + r.error);
    }
  }
  if (!fresh.length) return;
  const head = r.dry
    ? "TEST MODE: nothing below was actually changed. This is what the plan scheduler WOULD do.\n\n"
    : "";
  const subject = (r.dry ? "[Test] " : "") + "Maintenance plan calendar update";
  await sendMail(env, subject, head + fresh.join("\n\n") + "\n\nVanyan's Auto Detail plan scheduler");
}

async function sendMail(env, subject, text) {
  if (!env.MAILER) {
    console.log(subject + "\n" + text);
    return;
  }
  const raw = [
    `From: Vanyan's Plans <${SENDER}>`,
    `To: ${OWNER}`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@vanyansautodetail.com>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
  await env.MAILER.send(new EmailMessage(SENDER, OWNER, raw));
}
