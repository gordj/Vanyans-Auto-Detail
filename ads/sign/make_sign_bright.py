"""Render the bright sidewalk version of the 2980x4470 sign.

    python make_sign_bright.py

Built to be read from across a driveway: a blue header carrying the mark, one bright
photograph, a white panel with the phone number and what you get, and a navy footer
with a QR code that opens the booking page.
"""
import os

import numpy as np
import segno
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SKILL_FONTS = (r"C:\Users\Greg\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin"
               r"\81c10efa-400b-451e-a6e1-92f8c0adc5ab\db0af1dd-065e-4f4c-a1db-c4c6cf3da904"
               r"\skills\canvas-design\canvas-fonts")
WIN_FONTS = r"C:\Windows\Fonts"

W, H = 2980, 4470
PAD = 190                      # side margin for text inside panels

NAVY = (11, 21, 36)
NAVY_2 = (18, 34, 58)
BLUE = (27, 109, 224)
BLUE_HOT = (59, 135, 245)
GOLD = (242, 179, 61)
WHITE = (255, 255, 255)
PAPER = (247, 248, 250)
INK = (16, 26, 40)
GREY = (104, 120, 140)

BOOK_URL = "https://vanyansautodetail.com/book"
LANCZOS = Image.Resampling.LANCZOS

BANDS = {"header": (0, 1120), "photo": (1120, 2520), "panel": (2520, 3830), "foot": (3830, H)}


def bahn(size, style="Bold"):
    f = ImageFont.truetype(os.path.join(WIN_FONTS, "bahnschrift.ttf"), size)
    f.set_variation_by_name(style)
    return f


def mono(size, bold=False):
    return ImageFont.truetype(os.path.join(SKILL_FONTS, "GeistMono-Bold.ttf" if bold
                                           else "GeistMono-Regular.ttf"), size)


def tracked(draw, text, font, x, baseline, track, fill, center_on=None):
    widths = [font.getlength(c) for c in text]
    total = sum(widths) + track * (len(text) - 1)
    if center_on is not None:
        x = center_on - total / 2
    for c, w in zip(text, widths):
        draw.text((x, baseline), c, font=font, fill=fill, anchor="ls")
        x += w + track
    return total


def vgrad(size, top, bottom):
    w, h = size
    ramp = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    arr = np.zeros((h, w, 3), dtype=np.float32)
    for i in range(3):
        arr[:, :, i] = top[i] * (1 - ramp) + bottom[i] * ramp
    return Image.fromarray(arr.astype(np.uint8))


def header(canvas):
    y0, y1 = BANDS["header"]
    h = y1 - y0
    band = vgrad((W, h), BLUE_HOT, BLUE).convert("RGBA")

    # diagonal gloss, the sheen of a wet panel
    gloss = Image.new("L", (W * 2, h * 2), 0)
    gd = ImageDraw.Draw(gloss)
    for i in range(-2, 9):
        x = i * 420
        gd.polygon([(x, 0), (x + 150, 0), (x + 150 - h * 2, h * 2), (x - h * 2, h * 2)], fill=26)
    gloss = gloss.resize((W, h), LANCZOS).filter(ImageFilter.GaussianBlur(14))
    sheen = Image.new("RGBA", (W, h), WHITE + (0,))
    sheen.putalpha(gloss)
    band.alpha_composite(sheen)

    mark = Image.open(os.path.join(ROOT, "brand", "vanyans-icon.png")).convert("RGBA")
    size = 440
    tile = mark.resize((size, size), LANCZOS)
    rounded = Image.new("L", (size, size), 0)
    ImageDraw.Draw(rounded).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.22), fill=255)
    tile.putalpha(rounded)
    shadow = Image.new("RGBA", (W, h), (0, 0, 0, 0))
    sm = Image.new("L", (W, h), 0)
    sm.paste(rounded, ((W - size) // 2, 120))
    shadow.putalpha(sm.filter(ImageFilter.GaussianBlur(26)).point(lambda v: int(v * 0.35)))
    band.alpha_composite(shadow)
    band.alpha_composite(tile, ((W - size) // 2, 108))

    d = ImageDraw.Draw(band)
    tracked(d, "VANYAN\u2019S", bahn(226, "Bold"), 0, 870, 22, WHITE, center_on=W / 2)
    tracked(d, "AUTO DETAIL", mono(74), 0, 986, 52, (255, 236, 196, 255), center_on=W / 2)
    canvas.paste(band.convert("RGB"), (0, y0))


def photo(canvas):
    y0, y1 = BANDS["photo"]
    h = y1 - y0
    src = Image.open(os.path.join(ROOT, "site", "img", "cine-foam.jpg")).convert("RGB")
    scale = max(W / src.width, h / src.height)
    img = src.resize((round(src.width * scale), round(src.height * scale)), LANCZOS)
    top = max(0, int(img.height * 0.06))
    img = img.crop(((img.width - W) // 2, top, (img.width - W) // 2 + W, top + h))

    arr = np.asarray(img).astype(np.float32)
    arr = np.clip((arr - 6) * 1.12, 0, 255)                       # open it up
    arr = arr * np.array([0.98, 1.0, 1.05], dtype=np.float32)     # a touch cooler
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).convert("RGBA")

    # blend the top edge into the blue header so the bands read as one object
    fade = Image.new("L", (W, h), 255)
    fd = ImageDraw.Draw(fade)
    for i in range(190):
        fd.line((0, i, W, i), fill=int(255 * (i / 190) ** 1.3))
    base = Image.new("RGB", (W, h), BLUE)
    base.paste(img.convert("RGB"), (0, 0), fade)
    canvas.paste(base, (0, y0))


def check(draw, cx, cy, r, color):
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    draw.line((cx - r * 0.42, cy + r * 0.04, cx - r * 0.10, cy + r * 0.38), fill=WHITE, width=int(r * 0.22))
    draw.line((cx - r * 0.12, cy + r * 0.38, cx + r * 0.46, cy - r * 0.34), fill=WHITE, width=int(r * 0.22))


def panel(canvas):
    y0, y1 = BANDS["panel"]
    h = y1 - y0
    band = Image.new("RGB", (W, h), PAPER)
    d = ImageDraw.Draw(band)

    # phone number: the loudest thing on the sign after the photo
    tracked(d, "CALL OR TEXT", mono(56), 0, 150, 40, (GREY), center_on=W / 2)
    tracked(d, "818.660.5845", bahn(252, "Bold"), 0, 390, 6, INK, center_on=W / 2)
    d.rounded_rectangle((W / 2 - 300, 452, W / 2 + 300, 466), radius=7, fill=GOLD)

    items = [
        "Full interior and exterior detail",
        "Hand wash, wax, wheels and glass",
        "Ceramic coating available",
        "We come to you, 7 days a week",
    ]
    f = bahn(86, "SemiBold")
    y = 610
    for t in items:
        check(d, PAD + 46, y - 26, 44, BLUE)
        d.text((PAD + 136, y), t, font=f, fill=INK, anchor="ls")
        y += 126

    # price tag
    tag_f = bahn(92, "SemiBold")
    label = "FULL DETAIL FROM $185"
    tw = sum(tag_f.getlength(c) for c in label) + 10 * (len(label) - 1)
    tag_w, tag_h = tw + 150, 170
    tx, ty = (W - tag_w) / 2, h - 232
    d.rounded_rectangle((tx, ty, tx + tag_w, ty + tag_h), radius=tag_h / 2, fill=GOLD)
    tracked(d, label, tag_f, 0, ty + tag_h / 2 + 32, 10, INK, center_on=W / 2)
    canvas.paste(band, (0, y0))


def qr_image(target_px):
    """Scan reliability comes from whole-pixel modules: size to an exact multiple."""
    qr = segno.make(BOOK_URL, error="h")
    modules = qr.symbol_size(scale=1, border=2)[0]
    k = max(1, round(target_px / modules))
    tmp = os.path.join(HERE, "_qr.png")
    qr.save(tmp, scale=k, border=2, dark="#0B1524", light="#FFFFFF")
    img = Image.open(tmp).convert("RGB")
    os.remove(tmp)
    print("qr: %d modules, scale %d, %dpx -> %s" % (modules, k, img.width, BOOK_URL))
    return img


def foot(canvas):
    y0, y1 = BANDS["foot"]
    h = y1 - y0
    band = vgrad((W, h), NAVY_2, NAVY)
    d = ImageDraw.Draw(band)

    qr = qr_image(470)
    qr_px = qr.width
    qx, qy = W - PAD - qr_px, (h - qr_px) // 2
    plate = 34
    d.rounded_rectangle((qx - plate, qy - plate, qx + qr_px + plate, qy + qr_px + plate),
                        radius=44, fill=WHITE)
    band.paste(qr, (qx, qy))

    tracked(d, "SCAN TO BOOK", bahn(104, "Bold"), PAD, qy + 140, 12, WHITE)
    tracked(d, "VANYANSAUTODETAIL.COM", bahn(78, "SemiBold"), PAD, qy + 262, 10, BLUE_HOT + (255,))

    # instagram glyph, then the handle
    gx, gy, gs = PAD + 6, qy + 330, 74
    d.rounded_rectangle((gx, gy, gx + gs, gy + gs), radius=24, outline=WHITE, width=7)
    d.ellipse((gx + 22, gy + 22, gx + gs - 22, gy + gs - 22), outline=WHITE, width=7)
    d.ellipse((gx + gs - 28, gy + 14, gx + gs - 16, gy + 26), fill=WHITE)
    d.text((gx + gs + 34, gy + gs - 8), "@vanyansautodetail", font=bahn(72, "SemiBold"), fill=WHITE, anchor="ls")

    canvas.paste(band, (0, y0))


def main():
    canvas = Image.new("RGB", (W, H), PAPER)
    header(canvas)
    photo(canvas)
    panel(canvas)
    foot(canvas)

    out = canvas
    path = os.path.join(HERE, "vanyans-sign-bright-2980x4470.png")
    out.save(path)
    out.resize((W // 4, H // 4), LANCZOS).save(os.path.join(HERE, "_review_bright.jpg"), quality=92)
    print(path, out.size, "%.1f MB" % (os.path.getsize(path) / 1e6))


if __name__ == "__main__":
    main()
