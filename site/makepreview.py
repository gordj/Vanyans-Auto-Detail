"""Build preview.html from template.html.

preview.html is the single file version used for sharing and for quick looks
without a server. It differs from dist/ in one way only: the images are inlined
as base64 rather than referenced, so the file stands alone.

It reads the same square.json that build.ps1 reads, so the preview and the real
site always agree about booking and subscription links.

    python makepreview.py
"""
import base64
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

IMAGES = {
    "HERO": "hero.jpg",
    "BEFORE": "before.jpg",
    "AFTER": "after.jpg",
    "LOGO": "logo.jpg",
    "CINEFOAM": "cine-foam.jpg",
    "CINECLEAN": "cine-clean.jpg",
}

# What each control does until Square is switched on. Kept in step with the
# same fallbacks in build.ps1 so a half configured Square never ships a dead
# button on either output.
TEXT = "sms:+18186605845?&body=Hi%2C%20I%20would%20like%20to%20start%20a%20{}%20plan."
FALLBACKS = {
    "SQ_BOOK": "#/book",
    "SQ_MONTHLY": TEXT.format("monthly"),
    "SQ_BIWEEKLY": TEXT.format("every%20two%20weeks"),
    "SQ_WEEKLY": TEXT.format("weekly"),
    "SQ_MEMBER": (
        '<div class="sq-fallback"><p>Your plan is active. '
        'Call or text <a href="tel:+18186605845">818.660.5845</a> '
        "and we will set your standing slot.</p></div>"
    ),
    "SQ_EMBED": (
        '<div class="sq-fallback"><p>Online booking is being switched on. '
        'Call or text <a href="tel:+18186605845">818.660.5845</a> '
        "and we will put you straight in the book.</p></div>"
    ),
}


def book_button(url):
    return (
        '<div class="sq-cta">'
        '<a class="btn btn-primary gloss" target="_top" rel="nofollow" href="'
        + url + '">Book now</a></div>'
    )


def square_values():
    path = os.path.join(ROOT, "square.json")
    if not os.path.exists(path):
        print("square.json not found, using fallbacks")
        return dict(FALLBACKS)
    cfg = json.load(io.open(path, encoding="utf-8"))
    plans = cfg.get("plans") or {}
    got = {
        "SQ_BOOK": cfg.get("bookingUrl"),
        "SQ_EMBED": cfg.get("embedHtml"),
        "SQ_MEMBER": cfg.get("memberEmbedHtml"),
        "SQ_MONTHLY": plans.get("monthly"),
        "SQ_BIWEEKLY": plans.get("biweekly"),
        "SQ_WEEKLY": plans.get("weekly"),
    }
    # A real widget wins; failing that our own button to Square still books.
    # The member slot never falls back to the public URL, because a member sent
    # there is shown the price their subscription already covers.
    if not got["SQ_EMBED"] and got["SQ_BOOK"]:
        got["SQ_EMBED"] = book_button(got["SQ_BOOK"])

    # Cal.com replaces Square for booking once cal.link is set (same rule as build.ps1).
    cal = cfg.get("cal") or {}
    embed = io.open(os.path.join(ROOT, "cal-embed.html"), encoding="utf-8").read()
    if cal.get("link"):
        got["SQ_EMBED"] = embed.replace("__CALLINK__", cal["link"]).replace("__NS__", "book")
    got["CAL_PLAN_BASE"] = (cal.get("memberLink") or "vanyans-auto.detail/plan-{plan}").replace("{plan}", "")
    if cal.get("memberLink"):
        got["SQ_MEMBER"] = embed.replace("__CALLINK__", cal["memberLink"]).replace("__NS__", "member")

    out, live = {}, []
    for k, v in got.items():
        if v:
            out[k], _ = v, live.append(k)
        else:
            out[k] = FALLBACKS[k]
    print("square.json: %s live, rest on fallback" % (", ".join(live) if live else "nothing"))
    return out


def main():
    src = io.open(os.path.join(ROOT, "template.html"), encoding="utf-8").read()

    for token, value in square_values().items():
        src = src.replace("{{%s}}" % token, value)

    for token, name in IMAGES.items():
        path = os.path.join(ROOT, "img", name)
        data = base64.b64encode(open(path, "rb").read()).decode()
        src = src.replace("{{%s}}" % token, "data:image/jpeg;base64," + data)

    # plain img/ paths (the work gallery) get inlined the same way
    mime = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "webp"}

    def inline(match):
        path = os.path.join(ROOT, match.group(2).replace("/", os.sep))
        kind = mime[match.group(3).lower()]
        data = base64.b64encode(open(path, "rb").read()).decode()
        return '%s="data:image/%s;base64,%s"' % (match.group(1), kind, data)
    src = re.sub(r'\b(src|data-src)="(img/[^"]+\.(jpg|jpeg|png|webp))"', inline, src)

    left = [t for t in list(IMAGES) + list(FALLBACKS) if "{{%s}}" % t in src]
    if left:
        sys.exit("tokens left unreplaced: %s" % ", ".join(left))

    out = os.path.join(ROOT, "preview.html")
    io.open(out, "w", encoding="utf-8", newline="").write(src)
    print("preview.html  %.1f MB" % (os.path.getsize(out) / 1e6))


if __name__ == "__main__":
    main()
