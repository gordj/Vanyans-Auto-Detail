# Google Calendar plans: owner setup checklist

The code is written and tested (`automation/test-google.html`, 48 checks, plus the older 29 in `test.html`).
It needs these accounts and keys before it can go live. Enter every key yourself in Cloudflare
(Workers & Pages > vanyans-plans > Settings > Variables and Secrets > Add, type **Secret**). Never paste a key into chat.

Do steps 1 to 5 now. Text reminders (Twilio, "Later" at the bottom) are optional and can be added any time: until
then the reserve page has no text-reminder checkbox, the confirmation email makes no promise of texts, and nothing is texted.

## 1. Google Calendar access (about 15 minutes)

1. Go to console.cloud.google.com, sign in as **vanyansdetailing@gmail.com**, create a project named "Vanyans plans".
2. APIs & Services > Library > search **Google Calendar API** > Enable.
3. APIs & Services > OAuth consent screen: User type **External**, app name "Vanyans plans", your email as support and
   developer contact. Add the scope `.../auth/calendar`. Add yourself as a test user.
4. **Publish the app** (OAuth consent screen > Publish app > Production). If you leave it in "Testing", Google
   expires the token after 7 days and scheduling silently stops. Google shows an "unverified app" warning only to you.
5. APIs & Services > Credentials > Create credentials > OAuth client ID > type **Web application**. Under Authorized
   redirect URIs add `https://developers.google.com/oauthplayground`. Copy the client ID and client secret.
6. Open developers.google.com/oauthplayground. Click the gear icon, tick **Use your own OAuth credentials**, paste the
   client ID and secret. In Step 1 enter the scope `https://www.googleapis.com/auth/calendar`, Authorize APIs, sign in
   as vanyansdetailing@gmail.com. In Step 2 click **Exchange authorization code for tokens** and copy the **refresh token**.
7. Add three Cloudflare secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
8. Optional: add variable `CALENDAR_ID` if plan visits should go on a separate calendar (default is the main one).
   Optional: `EMPLOYEE_EMAILS` (comma separated) puts each visit on those people's calendars too. Otherwise share the
   calendar with employees in Google Calendar > Settings and sharing.

## 2. Confirmation email to clients: Resend (about 10 minutes)

The current Cloudflare email binding can only send to addresses you verified, so it cannot email clients.

1. Create an account at resend.com, add the domain `vanyansautodetail.com`, add the DNS records it shows in Cloudflare
   (DNS > Records), wait for "Verified".
2. Create an API key (sending access only). Add secret `RESEND_KEY`. Optional variable `RESEND_FROM`
   (default `Vanyan's Auto Detail <plans@vanyansautodetail.com>`).

## 3. Stripe webhook (about 5 minutes)

1. Stripe Dashboard > Developers > Webhooks > Add endpoint.
   URL: `https://vanyans-plans.gordjalayan.workers.dev/api/stripe-webhook`. Event: **checkout.session.completed** only.
2. Copy the **signing secret** (starts with whsec_). Add secret `STRIPE_WEBHOOK_SECRET`.
3. The existing restricted Stripe key (`STRIPE_KEY`) stays as is (Customers Read, Subscriptions Read).

## 4. Deploy the worker

Paste `automation/plans-worker.js` into Cloudflare > Workers > vanyans-plans > Edit code (Ctrl+A, delete, paste),
then Deploy. Keep `DRY_RUN` at `0`. Set the cron to every 30 minutes (`*/30 * * * *`) and delete the 5-minute and
"15 minutes past the hour" triggers. Texts go out within 30 minutes of the 24-hour mark, unpaid holds are cleaned up
the moment anyone opens the reserve page, and Cloudflare's free storage (about 1,000 writes a day) is safe at this pace.

## 5. Try it, then switch the site over

1. Open `https://vanyansautodetail.com/reserve` (unlisted test page). Pick a time, fill the form, check out with a
   fresh 100%-off promo code (ask Claude for a new one), and confirm: the event appears in Google Calendar with no end
   date and one confirmation email arrives.
2. Cancel the test subscription in Stripe and confirm the series gets an end date within about an hour.
3. Tell Claude to cut over: the homepage plan buttons go to `/reserve`, the Cal.com plan sync is switched off
   (`CAL_SYNC` = `0`), and the old plan events are retired. One-time services stay on Cal.com.

Rollback: `git checkout cal-com-worker-v1` and redeploy that worker.

## Later: text reminders with Twilio (registration takes days, so start it a week ahead)

Google Voice numbers cannot send automated texts (against Google's terms), so this needs its own sending number.

1. Create an account at twilio.com and buy a local number (818 or 213), about $1.15 a month. Your Google number stays
   your business line; reminders already tell people to call or text 818-660-5845.
2. US business texting requires **A2P 10DLC registration** (Messaging > Regulatory Compliance). Sole proprietor (no EIN):
   about $4 brand fee, $15 campaign vetting, $2 a month. Campaign type "Customer care / appointment reminders". Sample
   message: "Vanyan's Auto Detail: reminder, your detail is Thu, Oct 1, 9:00 AM. To skip or move it call or text 818-660-5845.
   Reply STOP to opt out." Opt-in: clients tick a required checkbox on the reserve page before checkout.
3. On the new number set an automatic reply for incoming texts: "This number only sends reminders. Call or text
   818-660-5845." Twilio handles STOP replies by itself.
4. Add secrets `TWILIO_SID`, `TWILIO_TOKEN`, and variable `TWILIO_FROM` (like +18185550199). From then on the reserve
   page shows the consent checkbox and reminders go out 24 hours before each visit. Members who signed up before this
   never agreed to texts, so they are not texted; they can be asked to re-book their consent later.
