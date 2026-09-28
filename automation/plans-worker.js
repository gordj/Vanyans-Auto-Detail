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
let sharedBudget = false;
class BudgetError extends Error {}
export function resetBudget(limit = DEFAULT_BUDGET) {
  used = 0;
  budget = limit;
}
function spend() {
  if (used >= budget) throw new BudgetError("request budget used up");
  used++;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const last = env.STATE ? await env.STATE.get("last-run") : null;
      const g = env.STATE ? await env.STATE.get("last-google") : null;
      const body = last ? JSON.parse(last) : { note: "not run yet" };
      if (g) body.google = JSON.parse(g);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return new Response("Not found", { status: 404 });
  },
};

// Every scheduled run: Google Calendar plan visits (holds, reminders, plan endings), then the older
// Cal.com booking sync unless CAL_SYNC is "0". They share one request budget per invocation.
export async function runAll(env, now = Date.now()) {
  used = 0;
  budget = Number(env.BUDGET) || DEFAULT_BUDGET;
  sharedBudget = true;
  try {
    if (googleReady(env)) await runGoogle(env, now);
    if (env.CAL_SYNC !== "0") await run(env, now);
  } finally {
    sharedBudget = false;
  }
}

export async function run(env, now = Date.now()) {
  const dry = env.DRY_RUN !== "0";
  if (!sharedBudget) {
    used = 0;
    budget = Number(env.BUDGET) || DEFAULT_BUDGET;
  }
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

/* ------------------------------------------------------------------ Google Calendar plan visits
 * Each member is ONE never-ending recurring Google Calendar event (RRULE with no COUNT/UNTIL).
 * Flow: the site asks /api/slots, then /api/hold (creates the event marked "hold", blocking the slot
 * for 30 minutes) and sends the client to the Stripe Payment Link with client_reference_id = event id.
 * Stripe calls /api/stripe-webhook when paid: the hold becomes "confirmed" and one confirmation email
 * goes out. Cron: expired holds are deleted, an SMS reminder goes out 24 h before every visit, and a
 * series is stopped (UNTIL) when the Stripe subscription ends.
 *
 * Extra settings: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN (secrets),
 * CALENDAR_ID (optional, default "primary"), STRIPE_WEBHOOK_SECRET, TWILIO_SID / TWILIO_TOKEN /
 * TWILIO_FROM, RESEND_KEY (+ optional RESEND_FROM), EMPLOYEE_EMAILS (optional, comma separated),
 * CAL_SYNC ("0" turns the old Cal.com plan sync off).
 */

const PLAN_KEYS = {
  weekly: { weeks: 1, name: "Weekly" },
  biweekly: { weeks: 2, name: "Every two weeks" },
  monthly: { weeks: 4, name: "Monthly" },
};
const PAY_LINKS = {
  monthly: "https://buy.stripe.com/14AfZaaZXeOM1pO6mUdnW00",
  biweekly: "https://buy.stripe.com/7sY7sEd853649Wk8v2dnW01",
  weekly: "https://buy.stripe.com/fZudR2d85220fgE3aIdnW02",
};
const PORTAL_URL = "https://billing.stripe.com/p/login/14AfZaaZXeOM1pO6mUdnW00";
const PHONE = "818-660-5845";
const GCAL = "https://www.googleapis.com/calendar/v3";
const DAY = 86400e3;
const VISIT_MS = 90 * 60e3;          // every plan visit is 90 minutes
const BUFFER_MS = 30 * 60e3;         // plus 30 minutes to get to the next job
const OFFER_DAYS = 21;               // first visits offered: the next 3 weeks
const CHECK_DAYS = 84;               // a slot must stay free 12 weeks ahead (covers every 1/2/4-week overlap)
const HOLD_MS = 30 * 60e3;
const MAX_HOLDS = 10;                // stops someone filling the calendar with unpaid holds
const RECHECK_MS = 55 * 60e3;        // how often each member's Stripe plan is re-checked
const ALLOWED_ORIGINS = new Set([
  "https://vanyansautodetail.com", "https://www.vanyansautodetail.com", "http://localhost:8080",
]);

const googleReady = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
const pad2 = (n) => String(n).padStart(2, "0");
const calendarId = (env) => env.CALENDAR_ID || "primary";
const calPath = (env, rest = "") => `/calendars/${encodeURIComponent(calendarId(env))}${rest}`;

async function googleToken(env) {
  const cached = await kvJson(env, "gtoken", null);
  if (cached && cached.exp > Date.now() + 120e3) return cached.token;
  spend();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token",
    }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed (${res.status}): ${j.error || ""}`);
  await kvPut(env, "gtoken", { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

async function gcal(env, path, { method = "GET", body, query } = {}) {
  const token = await googleToken(env);
  spend();
  const qs = query && query.length
    ? "?" + query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  const res = await fetch(GCAL + path + qs, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google Calendar ${method} ${path.split("?")[0]} failed (${res.status}): ` +
      JSON.stringify(json.error || json).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return json;
}

async function gcalDelete(env, id) {
  try {
    await gcal(env, calPath(env, `/events/${encodeURIComponent(id)}`), { method: "DELETE", query: [["sendUpdates", "none"]] });
  } catch (e) {
    if (e.status !== 404 && e.status !== 410) throw e; // already gone is fine
  }
}

const localIso = (ms) => {
  const p = localParts(ms);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}:00`;
};

/** Same weekday and wall-clock time every `weeks` weeks for `days` days (handles daylight saving). */
export function seriesTimes(anchorMs, weeks, days) {
  const a = localParts(anchorMs);
  const step = 7 * weeks;
  const out = [];
  for (let k = 0; k * step <= days; k++) {
    const d = new Date(Date.UTC(a.y, a.m - 1, a.d + k * step));
    out.push(zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), a.hh, a.mm));
  }
  return out;
}

/** First-visit start times offered: every 30 min from 9:00 to 3:30 PM, next 3 weeks, 17 h notice. */
export function candidateStarts(now) {
  const p = localParts(now);
  const out = [];
  for (let k = 0; k <= OFFER_DAYS; k++) {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + k));
    for (let mins = 9 * 60; mins <= 15 * 60 + 30; mins += 30) {
      const t = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(mins / 60), mins % 60);
      if (t >= now + NOTICE_MS) out.push(t);
    }
  }
  return out;
}

const FREEBUSY_CHUNK_MS = 55 * DAY; // Google rejects a single query over ~3 months ("timeRangeTooLong")

async function freeBusy(env, fromMs, toMs) {
  const busy = [];
  for (let chunkStart = fromMs; chunkStart < toMs; chunkStart += FREEBUSY_CHUNK_MS) {
    const chunkEnd = Math.min(chunkStart + FREEBUSY_CHUNK_MS, toMs);
    const j = await gcal(env, "/freeBusy", {
      method: "POST",
      body: { timeMin: new Date(chunkStart).toISOString(), timeMax: new Date(chunkEnd).toISOString(), timeZone: TZ, items: [{ id: calendarId(env) }] },
    });
    const c = Object.values(j.calendars || {})[0];
    if (c?.errors?.length) throw new Error("Google FreeBusy error: " + JSON.stringify(c.errors).slice(0, 200));
    // busy time is padded with the travel buffer so visits never sit back to back
    for (const b of c?.busy || []) busy.push({ s: Date.parse(b.start), e: Date.parse(b.end) + BUFFER_MS });
  }
  return busy;
}

/** First-visit times that stay free for the next 12 weeks of that plan's schedule. */
export async function freeStarts(env, planKey, now) {
  const weeks = PLAN_KEYS[planKey].weeks;
  const busy = await freeBusy(env, now, now + (OFFER_DAYS + CHECK_DAYS + 2) * DAY);
  return candidateStarts(now).filter((t0) =>
    seriesTimes(t0, weeks, CHECK_DAYS).every((t) => !busy.some((b) => t < b.e && t + VISIT_MS + BUFFER_MS > b.s)));
}

/** Deletes holds older than 30 minutes; returns how many holds are still live. */
export async function cleanupHolds(env, now) {
  const j = await gcal(env, calPath(env, "/events"), {
    query: [["privateExtendedProperty", "vanyans=1"], ["privateExtendedProperty", "status=hold"], ["maxResults", "250"]],
  });
  let live = 0;
  for (const e of j.items || []) {
    if (e.status === "cancelled") continue;
    const at = Number(e.extendedProperties?.private?.holdAt || 0);
    if (now - at > HOLD_MS) await gcalDelete(env, e.id);
    else live++;
  }
  return live;
}

const clean = (v, max) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

const smsReady = (env) => !!(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM);

// smsOn: text reminders are switched on, so the client must agree to them. Until Twilio is set up
// nobody is asked, and nobody is promised texts.
export function validateHold(b, smsOn = true) {
  const plan = clean(b.plan, 20);
  if (!PLAN_KEYS[plan]) return { error: "Choose a plan." };
  if (clean(b.website, 50)) return { error: "Could not save that." }; // hidden field: bots fill it in
  const name = clean(b.name, 80);
  const email = clean(b.email, 120).toLowerCase();
  let digits = clean(b.phone, 30).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  const address = clean(b.address, 200);
  const vehicle = clean(b.vehicle, 80);
  const start = Date.parse(clean(b.start, 40));
  if (name.length < 2) return { error: "Enter your name." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email." };
  if (digits.length !== 10) return { error: "Enter a 10-digit mobile number." };
  if (address.length < 8) return { error: "Enter the address where the car is parked." };
  if (vehicle.length < 2) return { error: "Enter your vehicle." };
  if (smsOn && b.smsConsent !== true) return { error: "Please agree to the text reminders to continue." };
  if (!Number.isFinite(start)) return { error: "Pick a time." };
  return { value: { plan, name, email, phone: "+1" + digits, address, vehicle, start, sms: smsOn && b.smsConsent === true } };
}

function planEvent(planKey, t0, v, now, hold) {
  const plan = PLAN_KEYS[planKey];
  const body = {
    summary: `${hold ? "HOLD - " : ""}${plan.name} plan - ${v.name}`,
    location: v.address,
    description: `Phone: ${v.phone}\nEmail: ${v.email}\nVehicle: ${v.vehicle}\nPlan: ${plan.name} (never-ending, ends when the Stripe plan ends)\nText reminders: ${v.sms ? "yes (client agreed)" : "no"}`,
    start: { dateTime: localIso(t0), timeZone: TZ },
    end: { dateTime: localIso(t0 + VISIT_MS), timeZone: TZ },
    recurrence: [`RRULE:FREQ=WEEKLY;INTERVAL=${plan.weeks}`],
    extendedProperties: { private: {
      vanyans: "1", plan: planKey, status: hold ? "hold" : "confirmed", name: v.name, email: v.email,
      phone: v.phone, vehicle: v.vehicle, sms: v.sms ? "1" : "0", smsAt: v.sms ? new Date(now).toISOString() : "", holdAt: String(now),
    } },
  };
  return body;
}

const randomId = () => "v" + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function createHold(env, input, now = Date.now()) {
  const checked = validateHold(input, smsReady(env));
  if (checked.error) return { status: 400, body: { error: checked.error } };
  const v = checked.value;
  const live = await cleanupHolds(env, now);
  if (live >= MAX_HOLDS) return { status: 429, body: { error: "Lots of people are booking right now. Try again in a few minutes." } };
  const free = await freeStarts(env, v.plan, now);
  if (!free.includes(v.start)) return { status: 409, body: { error: "That time was just taken. Please pick another." } };

  const body = planEvent(v.plan, v.start, v, now, true);
  body.id = randomId();
  const emp = String(env.EMPLOYEE_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (emp.length) body.attendees = emp.map((email) => ({ email }));
  const mine = await gcal(env, calPath(env, "/events"), { method: "POST", body, query: [["sendUpdates", "none"]] });

  // two people picking the same slot in the same second: the earlier hold keeps it
  const others = await gcal(env, calPath(env, "/events"), {
    query: [["singleEvents", "true"], ["timeMin", new Date(v.start - BUFFER_MS).toISOString()],
      ["timeMax", new Date(v.start + VISIT_MS + BUFFER_MS).toISOString()], ["privateExtendedProperty", "vanyans=1"]],
  });
  const myCreated = Date.parse(mine.created || new Date(now).toISOString());
  const lost = (others.items || []).some((o) => {
    if (o.status === "cancelled" || String(o.id).startsWith(body.id)) return false;
    const oc = Date.parse(o.created || 0);
    return oc < myCreated || (oc === myCreated && String(o.id) < body.id);
  });
  if (lost) {
    await gcalDelete(env, body.id);
    return { status: 409, body: { error: "That time was just taken. Please pick another." } };
  }
  const url = `${PAY_LINKS[v.plan]}?client_reference_id=${encodeURIComponent(body.id)}&prefilled_email=${encodeURIComponent(v.email)}`;
  return { status: 200, body: { holdId: body.id, checkoutUrl: url, expiresAt: new Date(now + HOLD_MS).toISOString() } };
}

/* ---- Stripe webhook */

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyStripeSignature(raw, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(header || "").split(",").map((s) => s.trim().split("="));
  const t = parts.find((p) => p[0] === "t")?.[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!secret || !t || !sigs.length || Math.abs(nowSec - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s, hex));
}

export async function handleWebhook(env, raw, sigHeader, now = Date.now()) {
  if (!(await verifyStripeSignature(raw, sigHeader, env.STRIPE_WEBHOOK_SECRET, Math.floor(now / 1000)))) {
    return { status: 400, body: { error: "bad signature" } };
  }
  let ev;
  try { ev = JSON.parse(raw); } catch { return { status: 400, body: { error: "bad body" } }; }
  if (ev.type !== "checkout.session.completed") return { status: 200, body: { ignored: ev.type } };
  const s = ev.data?.object || {};
  const id = s.client_reference_id;
  if (!id || !/^v[0-9a-f]{24}$/.test(id)) return { status: 200, body: { ignored: "not a scheduled plan" } };
  if (!["paid", "no_payment_required"].includes(s.payment_status)) return { status: 200, body: { ignored: "not paid yet" } };

  let e;
  try {
    e = await gcal(env, calPath(env, `/events/${encodeURIComponent(id)}`));
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) throw err;
    await sendMail(env, "Plan paid but the time slot was released",
      `A client paid for a scheduled plan (Stripe session ${s.id}, ${s.customer_details?.email || "no email"}) but their held time ` +
      `had already expired. Call or text them to pick a time. Nothing was booked.`);
    return { status: 200, body: { warning: "hold expired" } };
  }
  const pr = e.extendedProperties?.private || {};
  if (pr.status === "confirmed" || e.status === "cancelled") return { status: 200, body: { already: true } };

  const planKey = pr.plan;
  const patch = {
    summary: `${PLAN_KEYS[planKey]?.name || "Plan"} plan - ${pr.name}`,
    extendedProperties: { private: { ...pr, status: "confirmed", stripeCustomer: s.customer || "", stripeSub: s.subscription || "", paidAt: new Date(now).toISOString() } },
  };
  await gcal(env, calPath(env, `/events/${encodeURIComponent(id)}`), { method: "PATCH", body: patch, query: [["sendUpdates", "none"]] });

  const firstMs = zonedFromLocal(e.start?.dateTime);
  const key = "conf:" + id;
  if (!(await kvGet(env, key))) {
    await kvPut(env, key, "1");
    await sendClientMail(env, pr.email, "You're booked with Vanyan's Auto Detail",
      confirmationText(PLAN_KEYS[planKey]?.name || "Plan", pr.name, firstMs, e.location, pr.sms === "1"));
    await sendMail(env, "New plan member",
      `${pr.name} (${pr.email}, ${pr.phone}) started the ${PLAN_KEYS[planKey]?.name} plan.\nFirst visit: ${fmt(firstMs)}\n${e.location || ""}\nVehicle: ${pr.vehicle}`);
  }
  return { status: 200, body: { confirmed: id } };
}

/** "2026-10-09T09:00:00" (Los Angeles wall time) -> UTC ms. */
function zonedFromLocal(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]) : 0;
}

function confirmationText(planName, name, firstMs, address, sms) {
  return [
    `Hi ${name},`,
    "",
    `You're booked. Your ${planName.toLowerCase()} plan is set up and your car will be detailed at the same time on every visit.`,
    "",
    `First visit: ${fmt(firstMs)}`,
    address ? `Where: ${address}` : "",
    "",
    sms
      ? "We'll text you a reminder 24 hours before each visit (reply STOP to opt out). This is the only email you'll get about scheduling."
      : "This is the only email you'll get about scheduling. Your visit repeats automatically at the same day and time.",
    `To skip or move a visit, call or text ${PHONE}.`,
    `Update your card, switch plans or cancel anytime: ${PORTAL_URL}`,
    "",
    "Vanyan's Auto Detail",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

async function sendClientMail(env, to, subject, text) {
  if (!env.RESEND_KEY) {
    console.log("client mail not sent (no RESEND_KEY):", to, subject);
    return;
  }
  spend();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM || "Vanyan's Auto Detail <plans@vanyansautodetail.com>", to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`Email to client failed (${res.status})`);
}

/* ---- SMS reminders, plan endings */

async function sendSms(env, to, text) {
  spend();
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text }).toString(),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(`Twilio text failed (${res.status}): ${j.message || ""}`);
    err.code = j.code;
    throw err;
  }
}

export async function sendReminders(env, now, dry, report) {
  const j = await gcal(env, calPath(env, "/events"), {
    query: [["singleEvents", "true"], ["orderBy", "startTime"], ["timeMin", new Date(now).toISOString()],
      ["timeMax", new Date(now + 24 * 3600e3).toISOString()], ["privateExtendedProperty", "vanyans=1"],
      ["privateExtendedProperty", "status=confirmed"], ["maxResults", "250"]],
  });
  for (const e of j.items || []) {
    if (e.status === "cancelled") continue;
    const pr = e.extendedProperties?.private || {};
    if (pr.sms !== "1" || !pr.phone) continue;
    const key = "sms:" + e.id;
    if (await kvGet(env, key)) continue;
    const when = fmt(zonedFromLocal(e.start?.dateTime));
    if (!dry) {
      try {
        await sendSms(env, pr.phone,
          `Vanyan's Auto Detail: reminder, your detail is ${when}. To skip or move it call or text ${PHONE}. Reply STOP to opt out.`);
      } catch (err) {
        if (err instanceof BudgetError) throw err;
        if (err.code === 21610) { // they replied STOP: never try this one again
          if (env.STATE) await env.STATE.put(key, "optout", { expirationTtl: 3 * 86400 });
          continue;
        }
        report.warnings.push(item(`sms:${e.id}`, `Could not text ${pr.name} for ${when}: ${errText(err)}`));
        continue;
      }
      if (env.STATE) await env.STATE.put(key, "1", { expirationTtl: 3 * 86400 });
    }
    report.booked.push(item(`remind:${e.id}`, `${pr.name}: reminder text for ${when}${dry ? " (test mode, not sent)" : ""}`));
  }
}

async function customerStatus(env, customerId) {
  const subs = await stripe(env, `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=20`);
  let any = false, live = false, ended = true;
  for (const s of subs.data || []) {
    any = true;
    if (LIVE.has(s.status)) live = true;
    if (!ENDED.has(s.status)) ended = false;
  }
  if (live) return "live";
  if (!any) return "none";
  return ended ? "ended" : "pending";
}

const untilStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export async function endPlans(env, now, dry, report) {
  const j = await gcal(env, calPath(env, "/events"), {
    query: [["privateExtendedProperty", "vanyans=1"], ["privateExtendedProperty", "status=confirmed"], ["maxResults", "250"]],
  });
  const checked = await kvJson(env, "gchecked", {});
  const events = (j.items || []).filter((e) => e.status !== "cancelled")
    .sort((a, b) => (checked[a.id] || 0) - (checked[b.id] || 0));
  for (const e of events) {
    if (now - (checked[e.id] || 0) < RECHECK_MS) continue;
    const pr = e.extendedProperties?.private || {};
    let status;
    try {
      status = pr.stripeCustomer ? await customerStatus(env, pr.stripeCustomer) : await stripeStatus(env, pr.email || "");
    } catch (err) {
      if (err instanceof BudgetError) break;
      report.warnings.push(item(`gerr:${e.id}:${now}`, `${pr.name}: ${errText(err)}`));
      continue;
    }
    checked[e.id] = now;
    if (status === "ended") {
      if (!dry) {
        const rule = (e.recurrence || []).find((r) => r.startsWith("RRULE:")) || "RRULE:FREQ=WEEKLY";
        const stopped = rule.replace(/;UNTIL=[^;]*/g, "") + `;UNTIL=${untilStamp(now)}`;
        await gcal(env, calPath(env, `/events/${encodeURIComponent(e.id)}`), {
          method: "PATCH", query: [["sendUpdates", "none"]],
          body: { recurrence: [stopped], extendedProperties: { private: { ...pr, status: "ended", endedAt: new Date(now).toISOString() } } },
        });
      }
      report.cancelled.push(item(`gend:${e.id}`, `${pr.name}: plan ended, future visits removed${dry ? " (test mode)" : ""}`));
    } else if (status === "none") {
      report.warnings.push(item(`gnostripe:${e.id}`, `${pr.name} (${pr.email}) has no Stripe plan. Their visits were left alone.`));
    }
  }
  if (!dry) await kvPut(env, "gchecked", checked);
}

async function runGoogle(env, now) {
  const dry = env.DRY_RUN !== "0";
  const report = { at: new Date(now).toISOString(), dry, booked: [], cancelled: [], conflicts: [], warnings: [], error: null };
  try {
    const live = await cleanupHolds(env, now);
    report.holds = live;
    if (smsReady(env)) await sendReminders(env, now, dry, report); // no Twilio yet: texting is simply off
    await endPlans(env, now, dry, report);
  } catch (e) {
    if (!(e instanceof BudgetError)) report.error = errText(e);
  }
  if (env.STATE) await env.STATE.put("last-google", JSON.stringify(publicReport({ ...report, members: 0 })));
  // reminder texts are logged in /health but never emailed; only endings and problems reach the owner
  await notify(env, { ...report, booked: [] });
  return report;
}

/* ---- public routes */

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const h = { "vary": "origin" };
  if (ALLOWED_ORIGINS.has(origin)) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type";
  }
  return h;
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...corsHeaders(request) } });
}

export async function handleApi(request, env, url) {
  used = 0;
  budget = 45;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
    try {
      const r = await handleWebhook(env, await request.text(), request.headers.get("stripe-signature"));
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: errText(e) }), { status: 500, headers: { "content-type": "application/json" } });
    }
  }
  if (!googleReady(env)) return json(request, 503, { error: "Online scheduling is not turned on yet. Call or text " + PHONE + "." });
  try {
    if (url.pathname === "/api/slots" && request.method === "GET") {
      const plan = url.searchParams.get("plan") || "";
      if (!PLAN_KEYS[plan]) return json(request, 400, { error: "Choose a plan." });
      const now = Date.now();
      await cleanupHolds(env, now);
      const starts = await freeStarts(env, plan, now);
      const days = new Map();
      for (const t of starts) {
        const p = localParts(t);
        const key = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
        if (!days.has(key)) days.set(key, { date: key, label: new Date(t).toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }), times: [] });
        days.get(key).times.push({ start: new Date(t).toISOString(), label: new Date(t).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) });
      }
      return json(request, 200, { plan, sms: smsReady(env), days: [...days.values()] });
    }
    if (url.pathname === "/api/hold" && request.method === "POST") {
      let input;
      try { input = await request.json(); } catch { return json(request, 400, { error: "Bad request." }); }
      const r = await createHold(env, input);
      return json(request, r.status, r.body);
    }
  } catch (e) {
    console.log("api error", errText(e));
    return json(request, 500, { error: "Something went wrong. Please call or text " + PHONE + "." });
  }
  return json(request, 404, { error: "Not found" });
}
