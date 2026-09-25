"""Render the 2980x4470 sign for Vanyan's Auto Detail.

    python make_sign.py

"Lacquer Silence": one lacquered navy field, one sculptural emblem, one photographic
passage, engraved type. Everything is drawn at full size and composited in one pass so
the gradients stay smooth and nothing is scaled up afterwards.
"""
import os

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SKILL_FONTS = (r"C:\Users\Greg\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin"
               r"\81c10efa-400b-451e-a6e1-92f8c0adc5ab\db0af1dd-065e-4f4c-a1db-c4c6cf3da904"
               r"\skills\canvas-design\canvas-fonts")
WIN_FONTS = r"C:\Windows\Fonts"

W, H = 2980, 4470
MARGIN = 300

NAVY_TOP = (9, 16, 28)
NAVY_MID = (12, 22, 38)
NAVY_BOT = (6, 10, 18)
SILVER = (214, 224, 236)
SILVER_DIM = (132, 148, 168)
BLUE = (91, 160, 255)
LANCZOS = Image.Resampling.LANCZOS


def bahn(size, style="Bold"):
    f = ImageFont.truetype(os.path.join(WIN_FONTS, "bahnschrift.ttf"), size)
    f.set_variation_by_name(style)
    return f


def mono(size, bold=False):
    name = "GeistMono-Bold.ttf" if bold else "GeistMono-Regular.ttf"
    return ImageFont.truetype(os.path.join(SKILL_FONTS, name), size)


def tracked(draw, text, font, cx, baseline, track, fill):
    """Letter-spaced text, centred on cx, sitting on the given baseline."""
    widths = [font.getlength(c) for c in text]
    total = sum(widths) + track * (len(text) - 1)
    x = cx - total / 2
    for c, w in zip(text, widths):
        draw.text((x, baseline), c, font=font, fill=fill, anchor="ls")
        x += w + track


def tracked_mask(text, font, track, pad=10):
    """Letter-spaced text on its own mask, so it can be filled with a gradient."""
    widths = [font.getlength(c) for c in text]
    total = int(sum(widths) + track * (len(text) - 1)) + pad * 2
    asc, desc = font.getmetrics()
    m = Image.new("L", (total, asc + desc + pad * 2), 0)
    d = ImageDraw.Draw(m)
    x = pad
    for c, w in zip(text, widths):
        d.text((x, pad), c, font=font, fill=255)
        x += w + track
    return m


def vertical_gradient(size, top, bottom):
    w, h = size
    ramp = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    arr = np.zeros((h, w, 3), dtype=np.float32)
    for i in range(3):
        arr[:, :, i] = top[i] * (1 - ramp) + bottom[i] * ramp
    return Image.fromarray(arr.astype(np.uint8))


def base_field():
    """Deep lacquer: a long gradient, a soft pool of light behind the emblem."""
    split = int(H * 0.42)
    field = Image.new("RGB", (W, H))
    field.paste(vertical_gradient((W, split), NAVY_TOP, NAVY_MID), (0, 0))
    field.paste(vertical_gradient((W, H - split), NAVY_MID, NAVY_BOT), (0, split))

    glow = Image.new("L", (W, H), 0)
    g = ImageChops.invert(Image.radial_gradient("L")).point(lambda v: int((v / 255) ** 2.2 * 190))
    gw = int(W * 1.55)
    glow.paste(g.resize((gw, gw), LANCZOS), ((W - gw) // 2, int(H * 0.20) - gw // 2))
    return Image.composite(Image.new("RGB", (W, H), (26, 46, 78)), field,
                           glow.point(lambda v: int(v * 0.5)))


def photo_passage(band_h=1560):
    """The finished car, bled into the field and pulled toward the palette."""
    src = Image.open(os.path.join(ROOT, "site", "img", "work", "finished.jpg")).convert("RGB")
    img = src.resize((W, round(src.height * W / src.width)), LANCZOS)
    top = max(0, int(img.height * 0.16))
    img = img.crop((0, top, W, min(img.height, top + band_h)))
    if img.height != band_h:
        img = img.resize((W, band_h), LANCZOS)

    arr = np.asarray(img).astype(np.float32)
    grey = arr @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    arr = grey[:, :, None] * 0.55 + arr * 0.45
    arr = arr * np.array([0.88, 0.96, 1.12], dtype=np.float32)
    arr = np.clip((arr - 8) * 1.13, 0, 255)
    img = Image.fromarray(arr.astype(np.uint8))

    mask = Image.new("L", (W, band_h), 255)
    md = ImageDraw.Draw(mask)
    fade_top, fade_bot = 520, 620
    for i in range(fade_top):
        md.line((0, i, W, i), fill=int(255 * (i / fade_top) ** 1.5))
    for i in range(fade_bot):
        y = band_h - 1 - i
        md.line((0, y, W, y), fill=int(255 * (i / fade_bot) ** 1.4))
    side = Image.new("L", (W, band_h), 255)
    sd = ImageDraw.Draw(side)
    for i in range(170):
        v = int(255 * (i / 170) ** 1.2)
        sd.line((i, 0, i, band_h), fill=v)
        sd.line((W - 1 - i, 0, W - 1 - i, band_h), fill=v)
    return img, ImageChops.multiply(mask, side)


def emblem(width):
    mark = Image.open(os.path.join(ROOT, "brand", "vanyans-mark.png")).convert("RGBA")
    mark = mark.crop(mark.getbbox())
    return mark.resize((width, round(mark.height * width / mark.width)), LANCZOS)


def calibration(draw):
    """Instrument ticks down both margins: the pulse that rewards a closer look."""
    x_l, x_r = 168, W - 168
    for i, y in enumerate(range(MARGIN + 40, H - MARGIN - 39, 74)):
        major = i % 5 == 0
        ln, a = (54, 46) if major else (26, 26)
        draw.line((x_l, y, x_l + ln, y), fill=SILVER_DIM + (a,), width=2)
        draw.line((x_r - ln, y, x_r, y), fill=SILVER_DIM + (a,), width=2)


def corner_marks(draw, arm=56, a=40):
    for cx, cy in ((MARGIN, MARGIN), (W - MARGIN, MARGIN),
                   (MARGIN, H - MARGIN), (W - MARGIN, H - MARGIN)):
        draw.line((cx - arm, cy, cx + arm, cy), fill=SILVER_DIM + (a,), width=2)
        draw.line((cx, cy - arm, cx, cy + arm), fill=SILVER_DIM + (a,), width=2)


def main():
    field = base_field()
    band, band_mask = photo_passage()
    field.paste(band, (0, 2090), band_mask)

    canvas = field.convert("RGBA")
    ink = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ink)

    mk = emblem(760)
    mx, my = (W - mk.width) // 2, 560
    bloom = Image.new("RGBA", (W, H), BLUE + (0,))
    ba = Image.new("L", (W, H), 0)
    ba.paste(mk.getchannel("A"), (mx, my))
    bloom.putalpha(ba.filter(ImageFilter.GaussianBlur(90)).point(lambda v: int(v * 0.42)))
    canvas.alpha_composite(bloom)
    canvas.alpha_composite(mk, (mx, my))

    wm = tracked_mask("VANYAN\u2019S", bahn(196, "Bold"), 26)
    word = Image.new("RGBA", wm.size, (0, 0, 0, 0))
    word.paste(vertical_gradient(wm.size, (255, 255, 255), (150, 168, 190)), (0, 0), wm)
    canvas.alpha_composite(word, ((W - word.width) // 2, 1548))

    tracked(d, "AUTO DETAIL", mono(58), W / 2, 1880, 44, BLUE + (230,))

    rule_y = 1988
    d.line((W / 2 - 520, rule_y, W / 2 + 520, rule_y), fill=SILVER_DIM + (70,), width=2)
    for x in (W / 2 - 520, W / 2 + 520):
        d.line((x, rule_y - 12, x, rule_y + 12), fill=SILVER_DIM + (90,), width=2)

    tracked(d, "MOBILE DETAILING  ·  LOS ANGELES", mono(48), W / 2, 3726, 30, SILVER_DIM + (200,))
    tracked(d, "FULL DETAIL FROM $185", bahn(112, "SemiLight"), W / 2, 3892, 12, SILVER + (245,))
    d.line((W / 2 - 300, 3972, W / 2 + 300, 3972), fill=SILVER_DIM + (55,), width=2)
    tracked(d, "VANYANSAUTODETAIL.COM", bahn(92, "SemiBold"), W / 2, 4082, 16, (255, 255, 255, 235))
    tracked(d, "818.660.5845", mono(62), W / 2, 4170, 26, BLUE + (225,))

    calibration(d)
    corner_marks(d)
    canvas.alpha_composite(ink)
    out = canvas.convert("RGB")

    vig = ImageChops.invert(Image.radial_gradient("L")).resize((W, H), LANCZOS)
    vig = vig.point(lambda v: int(255 - (255 - v) * 0.24))
    out = Image.fromarray((np.asarray(out).astype(np.float32)
                           * (np.asarray(vig).astype(np.float32)[:, :, None] / 255)).astype(np.uint8))
    grain = np.random.default_rng(7).normal(0, 1.7, (H, W, 1)).astype(np.float32)
    out = Image.fromarray(np.clip(np.asarray(out).astype(np.float32) + grain, 0, 255).astype(np.uint8))

    path = os.path.join(HERE, "vanyans-sign-2980x4470.png")
    out.save(path)
    out.resize((W // 4, H // 4), LANCZOS).save(os.path.join(HERE, "_review.jpg"), quality=92)
    print(path, out.size, "%.1f MB" % (os.path.getsize(path) / 1e6))


if __name__ == "__main__":
    main()
