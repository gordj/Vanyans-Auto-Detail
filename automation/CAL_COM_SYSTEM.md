# Cal.com + Worker plan scheduling (saved version 1, 2026-09-28)

This is the scheduling system as it stood before trying Google Calendar recurring events.
Git tag: `cal-com-worker-v1` (restore with `git checkout cal-com-worker-v1`, or `git checkout cal-com-worker-v1 -- site automation`).

## How it works

1. Visitor picks a plan on the site (Monthly $155 / Every two weeks $135 / Weekly $115) and pays with the
   Stripe Payment Link (collects phone, service address, vehicle). Stripe redirects to
   `/welcome?plan=weekly|biweekly|monthly`.
2. `/welcome` (and `/schedule`) embed the hidden Cal.com event `plan-weekly` / `plan-biweekly` / `plan-monthly`
   (Cal.com user `vanyans-auto.detail`; embed file `site/cal-embed.html`, config in `site/square.json`).
   The member books ONE starting visit. Cal.com writes it to Google Calendar `vanyansdetailing@gmail.com`.
3. Cloudflare Worker `vanyans-plans` (`automation/plans-worker.js`, cron) keeps each member booked 5 weeks ahead
   at their standing weekday/time for as long as their Stripe subscription is live, and removes future visits when it ends.

## Settings that matter

- Cal.com plan events (hidden, no repeat box, unlimited booking window): weekly 7208693, biweekly 7208694, monthly 7208695.
  Minimum notice 1020 min (17 h), 90 min long, attendee address location, phone + vehicle required.
- Worker `vanyans-plans` (Cloudflare account 0bda88cc5df40f33cac9f78a994c1199):
  secrets `CAL_API_KEY`, `STRIPE_KEY` (restricted: Customers Read, Subscriptions Read); variable `DRY_RUN` = `0` (live);
  optional `BUDGET` (default 40 outside requests per run; raise to 900 on Workers Paid); KV `STATE` (vanyans-plans-state);
  email binding `MAILER` -> vanyansdetailing@gmail.com.
- Cron: keep `15 * * * *` (hourly). A 5-minute trigger was added only for testing; free KV allows ~1,000 writes/day.
- Status page: https://vanyans-plans.gordjalayan.workers.dev/health (times are UTC; Pacific is 7 h behind until Nov 1).
- Code deploys by pasting `automation/plans-worker.js` into Cloudflare > Workers > vanyans-plans > Edit code > Deploy.

## Worker behavior (hardened 2026-09-28)

- Standing slot is remembered in KV (`anchor:<email>`), so cancelling the first booking does not end the series.
- A visit the member moves (`rescheduledFromUid`) is left alone and never becomes the new standing slot.
- After the first run only bookings from the last 14 days are read; each run stops at the request budget and resumes
  with the least-recently-checked members next time.
- Stripe email must match the booking email, otherwise the owner is emailed and nothing is booked.

## Tests

`automation/test.html` (launch config `plans-test`, port 8091): 29 checks against a fake Cal.com and Stripe. All pass.

## Verified live (2026-09-28)

A fresh test signup with promo `VANTEST2` was booked by the worker four visits ahead within one run.
Rolling-forward check is due Friday 2026-10-02 after 10:15 AM Pacific (Nov 6 should appear).
