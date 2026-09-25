# Connecting the site to Square

The website side is already built and waiting. Everything below happens inside your
Square account, which needs a login, so it has to be done by you. When you finish,
you paste five values into `square.json`, run the build, and the site is live on Square.

Work in this order. Each step produces something the next one needs.

---

## 1. Square Appointments: services, staff, availability

Dashboard > **Appointments**.

**Services.** Create one service per thing a customer can book. Match the site exactly so
prices never disagree in two places:

| Service | Car | SUV or truck | Big van or 3 row | Time |
| --- | --- | --- | --- | --- |
| Maintenance, outside only | $165 | $205 | $245 | 1 hr |
| Maintenance | $185 | $225 | $270 | 1 hr 30 |
| Premium Detail | $265 | $315 | $375 | 3 hr |
| Signature Detail | $385 | $455 | $535 | 5 hr |

Square handles the size tiers with **service variations**, one per vehicle class.
Set that up rather than making twelve separate services.

Add one more service, **Plan visit**, at **$0**, duration 1 hr 30, and turn its
**Online Booking Visibility OFF**. This is what plan members book. It is $0 because their
card is already charged by the subscription, and it is hidden so no stranger can book a free
detail. Members still reach it, through an Advanced Widget in section 3.

**Staff.** Add one bookable calendar, not two. Square treats every staff member as a
separate lane that can take its own job at the same time, and you run two techs on one car.
Two members would let two customers book the same slot. Keep the crew as a single calendar.
Employee shifts stay in Connecteam, which Square neither needs nor touches.

**Availability.** Set business hours to 9 to 5. Your site says you take work outside those
hours at double rate, and Square cannot express that, so leave the after hours work as a
phone arrangement rather than trying to model it in the calendar.

**Travel.** Turn on the mobile or travelling service setting and set the radius. Square
measures it from the location address, 10652 Penrose St., Sun Valley, CA 91352, not from
Burbank. At 60 miles that is a wide circle, and Square will not know that a Santa Clarita job
and a Beverly Hills job cannot sit back to back, so keep buffer time generous.

---

## 2. Square subscriptions: the three plans

Dashboard > **Payments** > **Subscriptions**, or **Payment Links**.

Create three plans. These have to match the site:

| Plan | Amount | Billing |
| --- | --- | --- |
| Monthly | $155 | every 4 weeks |
| Every two weeks | $135 | every 2 weeks |
| Weekly | $115 | every week |

For each one, create a **checkout link**. You get a URL like `https://square.link/u/AbC123`.

On every link, turn on **Redirect to a website after checkout** and set it to:

```
https://YOURDOMAIN/welcome.html
```

That redirect is what makes it feel like one flow. Without it a customer finishes on a bare
Square receipt page and is left wondering whether anything is actually booked.

---

## 3. Booking link and embed code

Dashboard > **Appointments** > **Online Booking** > **Channels** >
**Add your booking flow to an existing site**.

Take three things:

- **Get URL** gives you the booking site link.
- **Get embed code** gives you the public booking widget. This goes on `book.html` and shows
  your paid services to one off customers.
- **Advanced Widgets**, on the same screen, lets you build a widget limited to specific
  services. Build one scoped to **Plan visit only**. This goes on `welcome.html`, the page a
  member lands on straight after paying, so they pick their own slot from live availability
  without ever seeing a price.

---

## 4. Paste the five values

Open `square.json` and fill in:

```json
{
  "bookingUrl":      "the Get URL link",
  "embedHtml":       "the public embed snippet",
  "memberEmbedHtml": "the Advanced Widget snippet, Plan visit only",
  "plans": {
    "monthly":  "https://square.link/u/...",
    "biweekly": "https://square.link/u/...",
    "weekly":   "https://square.link/u/..."
  }
}
```

Then rebuild:

```
powershell -ExecutionPolicy Bypass -File build.ps1
python makepreview.py
```

Any value you leave blank falls back to the call and text flow the site used before, so a
half finished setup never puts a dead button in front of a customer.

---

## 5. Check it end to end

Use a real card and refund yourself afterwards. A test that does not take a payment does
not prove the redirect works.

1. Home page, click **Start every two weeks**.
2. Square takes the payment and creates the customer.
3. You land on `welcome.html` and it confirms the plan is active.
4. Book the **Plan visit** slot on that page. It should show no price.
5. Check Square: one customer, one active subscription, one appointment, card on file.
6. Open that appointment and tick **Repeat**, then set the cadence.
7. Separately, open the public booking page and confirm **Plan visit does not appear**.
8. Refund the payment, cancel the test subscription, delete the test series.

---

## Three things that will bite you

**Recurring payment and recurring appointment are separate in Square, and this is the one
manual step in the system.** The subscription bills the card on its own schedule and never
touches the calendar. Square also does not let a customer book a repeating series themselves,
only you can create one. So when a new member enrols:

1. The member books their own first slot on `welcome.html`.
2. You open that appointment in the dashboard.
3. You tick **Repeat** and set weekly, every 2 weeks, or every 4 weeks.

About a minute, once per member, and then it runs on its own. Closing that gap automatically
would mean building against Square's API, which is the custom development you ruled out.
For monthly plans, keep the start date between the 1st and the 28th so it never lands on a
date that some months do not have.

**The embed hands off to Square.** Square's own documentation says a customer who picks a
service in the embedded widget may be sent to Square's site to finish. The embed is genuine
Square code on your page, so the start of the flow is branded like your site, but you cannot
keep the entire transaction inside your own page without building a custom system on
Square's API. Everything up to that handoff looks like your site.

**The price builder still texts you.** The "Your price, in two selections" tool on the book
page sends you a text rather than booking. It is useful for people who do not know what they
need, but any job that arrives that way is not in Square until you enter it, which breaks the
single source of truth. Once Square booking is running, either delete that tool or treat
every text as something you immediately put into Square yourself.

---

## What stays in Square from then on

Appointments, customer records, cards on file, payments, subscriptions and availability all
live in Square. The website holds no customer data and no payment data, and there is no
database, no backend and no third party service in the middle. The site's only job is to
show the plans clearly and hand people to Square at the right moment.
