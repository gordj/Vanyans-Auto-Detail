# Turning on text reminders (Twilio)

The scheduler already knows how to send them. It texts each client **24 hours before every visit**, only if they
ticked the consent box on /reserve. All that is missing is a Twilio account and three secrets.
Until the secrets exist, the consent box is hidden and nobody is promised texts.

## 1. Twilio account (done by the owner; needs a card and a phone)
1. Sign up at twilio.com and verify your email and phone.
2. Add a payment method and a small balance (US$20 is plenty for months at this volume).

## 2. A number that is allowed to send
US carriers block texts from unregistered numbers. Pick ONE:

- **Toll-free number (simplest for a very small business).** Buy a toll-free number, then submit Twilio's
  *Toll-Free Verification* form. Review usually takes a few business days.
- **Local number (e.g. 818).** Buy it, then register for A2P 10DLC: first your *Brand* (sole proprietor or business),
  then a *Campaign*. Review usually takes days to a couple of weeks.

Use these answers on the registration forms (they match what the website really does):

| Question | Answer |
|---|---|
| Use case | Account notifications / appointment reminders |
| What messages? | One reminder text 24 hours before each scheduled detailing visit. Nothing promotional. |
| Sample message | `Vanyan's Auto Detail: reminder, your detail is Mon, Nov 2, 9:00 AM. To skip or move it call or text 818-660-5845. Reply STOP to opt out.` |
| How do people opt in? | Customer ticks an unchecked box on https://vanyansautodetail.com/reserve: "Text me a reminder 24 hours before each visit. Message and data rates may apply. Reply STOP to opt out." with links to the Terms & Texting and Privacy pages. |
| Privacy policy URL | https://vanyansautodetail.com/privacy |
| Terms / messaging terms URL | https://vanyansautodetail.com/terms |
| Message volume | Under 100 per month |
| Does it include links, phone numbers? | A phone number (818-660-5845). No links. |

## 3. Add three secrets to the Worker
Cloudflare > Workers & Pages > `vanyans-plans` > Settings > Variables and Secrets > Add, type **Secret**:

| Name | Value |
|---|---|
| `TWILIO_SID` | Account SID (starts with `AC`) from the Twilio console home page |
| `TWILIO_TOKEN` | Auth Token from the same page |
| `TWILIO_FROM` | The number you bought, as `+1XXXXXXXXXX` |

Never paste these into chat or commit them to git. Deploy again if Cloudflare asks.

## 4. Check it
1. Open https://vanyans-plans.gordjalayan.workers.dev/api/slots?plan=weekly and look for `"sms":true`.
   (`false` means a secret is missing or misspelled.)
2. https://vanyansautodetail.com/reserve now shows the "Text me a reminder" checkbox.
3. Book a visit for yourself at least ~25 hours ahead with the box ticked. The hourly run texts you inside the
   24-hour window. Replying STOP is handled by Twilio and the Worker skips that client from then on.

Texts are logged in the private status report at `https://vanyans-plans.gordjalayan.workers.dev/health?key=YOUR_HEALTH_KEY`
(set a `HEALTH_KEY` secret first; without it /health only says whether the last run worked). They are never emailed to the owner.
