"""Render the A-frame sign, 2980x4470 (20 x 30 inches at 149 dpi).

    python make_sign_aframe.py

Laid out like the sidewalk signs that work: logo block, phone number, what you get,
book now with a big QR, handles along the bottom. Black ground, gold and cyan accents.
"""
import os

import numpy as np
import segno
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
SKILL_FONTS = (r"C:\Users\Greg\AppData\Roaming\Claude\local-agent-mode-sessions\skills-plugin"
               r"\81c10efa-400b-451e-a6e1-92f8c0adc5ab\db0af1dd-065e-4f4c-a1db-c4c6cf3da904"
               r"\skills\canvas-design\canvas-fonts")
WIN_FONTS = r"C:\Windows\Fonts"

W, H = 2980, 4470
PAD = 170

BLACK = (7, 9, 13)
BLACK_2 = (15, 20, 30)
GOLD = (247, 184, 49)
CYAN = (86, 205, 255)
BLUE_HOT = (59, 135, 245)
WHITE = (255, 255, 255)
LANCZOS = Image.Resampling.LANCZOS

BOOK_URL = "https://vanyansautodetail.com/book"


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


def logo_block(canvas, band_h=1520):
    """The car sits behind the mark, the way the example carries a car inside its badge."""
    src = Image.open(os.path.join(ROOT, "site", "img", "cine-foam.jpg")).convert("RGB")
    scale = max(W / src.width, band_h / src.height)
    img = src.resize((round(src.width * scale), round(src.height * scale)), LANCZOS)
    img = img.crop(((img.width - W) // 2, 0, (img.width - W) // 2 + W, band_h))
    arr = np.asarray(img).astype(np.float32) * 0.30
    img = Image.fromarray(arr.astype(np.uint8))

    fade = Image.new("L", (W, band_h), 255)
    fd = ImageDraw.Draw(fade)
    for i in range(420):
        y = band_h - 1 - i
        fd.line((0, y, W, y), fill=int(255 * (i / 420) ** 1.25))
    base = Image.new("RGB", (W, band_h), BLACK)
    base.paste(img, (0, 0), fade)
    canvas.paste(base, (0, 0))

    pool = Image.new("L", (W, band_h), 0)
    g = ImageChops.invert(Image.radial_gradient("L")).point(lambda v: int((v / 255) ** 1.6 * 235))
    gw = int(W * 1.15)
    pool.paste(g.resize((gw, gw), LANCZOS), ((W - gw) // 2, 330 - gw // 2))
    base = Image.composite(Image.new("RGB", (W, band_h), BLACK), base, pool)
    canvas.paste(base, (0, 0))

    layer = Image.new("RGBA", (W, band_h), (0, 0, 0, 0))
    mark = Image.open(os.path.join(ROOT, "brand", "vanyans-mark.png")).convert("RGBA")
    mark = mark.crop(mark.getbbox())
    mw = 520
    mark = mark.resize((mw, round(mark.height * mw / mark.width)), LANCZOS)
    mx, my = (W - mw) // 2, 150
    bloom = Image.new("RGBA", (W, band_h), BLUE_HOT + (0,))
    ba = Image.new("L", (W, band_h), 0)
    ba.paste(mark.getchannel("A"), (mx, my))
    bloom.putalpha(ba.filter(ImageFilter.GaussianBlur(70)).point(lambda v: int(v * 0.5)))
    layer.alpha_composite(bloom)
    layer.alpha_composite(mark, (mx, my))

    d = ImageDraw.Draw(layer)
    tracked(d, "VANYAN\u2019S", bahn(236, "Bold"), 0, 1210, 22, WHITE, center_on=W / 2)
    tracked(d, "AUTO DETAIL", mono(76), 0, 1330, 54, GOLD + (255,), center_on=W / 2)

    out = Image.alpha_composite(canvas.crop((0, 0, W, band_h)).convert("RGBA"), layer)
    canvas.paste(out.convert("RGB"), (0, 0))


def qr_image(target_px):
    qr = segno.make(BOOK_URL, error="h")
    modules = qr.symbol_size(scale=1, border=2)[0]
    k = max(1, round(target_px / modules))
    tmp = os.path.join(HERE, "_qr_af.png")
    qr.save(tmp, scale=k, border=2, dark="#07090D", light="#FFFFFF")
    img = Image.open(tmp).convert("RGB")
    os.remove(tmp)
    print("qr: %d modules, scale %d, %dpx" % (modules, k, img.width))
    return img


def social_icon(d, kind, x, y, s):
    """Simple outlined glyphs, drawn to match at a glance from across a driveway."""
    d.ellipse((x, y, x + s, y + s), fill=WHITE)
    c = BLACK
    if kind == "instagram":
        m = s * 0.22
        d.rounded_rectangle((x + m, y + m, x + s - m, y + s - m), radius=s * 0.16,
                            outline=c, width=int(s * 0.075))
        r = s * 0.15
        cx, cy = x + s / 2, y + s / 2
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=c, width=int(s * 0.075))
        d.ellipse((x + s - m - s * 0.14, y + m + s * 0.05, x + s - m - s * 0.04, y + m + s * 0.15), fill=c)
    elif kind == "facebook":
        f = bahn(int(s * 0.72), "Bold")
        d.text((x + s / 2, y + s / 2), "f", font=f, fill=c, anchor="mm")


def main():
    canvas = Image.new("RGB", (W, H), BLACK)
    canvas.paste(vgrad((W, H - 1520), BLACK, BLACK_2), (0, 1520))
    logo_block(canvas)
    d = ImageDraw.Draw(canvas)

    # phone, the loudest line on the sign
    tracked(d, "818.660.5845", bahn(268, "Bold"), 0, 1790, 8, GOLD, center_on=W / 2)
    d.rounded_rectangle((PAD, 1880, W - PAD, 1888), radius=4, fill=(60, 70, 88))

    # what you get
    items = ["Full interior & exterior detail",
             "Hand wash, wax, wheels & glass",
             "Ceramic coating available",
             "We come to you, 7 days a week"]
    f = bahn(88, "SemiBold")
    y = 2060
    for t in items:
        d.ellipse((PAD + 16, y - 46, PAD + 46, y - 16), fill=GOLD)
        d.text((PAD + 96, y), t, font=f, fill=CYAN, anchor="ls")
        y += 152

    # book now + the code that does it
    qr = qr_image(920)
    qp = 46
    qx = W - PAD - qr.width - qp
    qy = 2740
    d.rounded_rectangle((qx - qp, qy - qp, qx + qr.width + qp, qy + qr.width + qp),
                        radius=40, fill=WHITE)
    canvas.paste(qr, (qx, qy))

    tracked(d, "BOOK NOW!", bahn(176, "Bold"), 0, 2650, 6, WHITE,
            center_on=qx + qr.width / 2)

    # the price fills the gap the bullets leave, and gives the eye a reason to stay
    tag_f = bahn(104, "Bold")
    label = "FULL DETAIL FROM $185"
    tw = sum(tag_f.getlength(c) for c in label) + 8 * (len(label) - 1)
    tag_w, tag_h = tw + 130, 190
    tx, ty = PAD, 2700
    d.rounded_rectangle((tx, ty, tx + tag_w, ty + tag_h), radius=tag_h / 2, fill=GOLD)
    tracked(d, label, tag_f, 0, ty + tag_h / 2 + 36, 8, BLACK, center_on=tx + tag_w / 2)

    scan_f = bahn(120, "SemiBold")
    sx = PAD + 40
    tracked(d, "SCAN ME", scan_f, sx, 3290, 14, GOLD)
    ax0, ax1, ay = sx + 40, qx - qp - 70, 3390
    d.line((ax0, ay, ax1, ay), fill=GOLD, width=14)
    d.polygon([(ax1 + 60, ay), (ax1 - 10, ay - 46), (ax1 - 10, ay + 46)], fill=GOLD)

    # handles
    s = 128
    rows = [("instagram", "@vanyansautodetail"), ("facebook", "Vanyan\u2019s Auto Detail")]
    ry = 3560
    for kind, handle in rows:
        social_icon(d, kind, PAD + 20, ry, s)
        d.text((PAD + 20 + s + 56, ry + s * 0.74), handle, font=bahn(92, "SemiBold"),
               fill=WHITE, anchor="ls")
        ry += s + 70

    tracked(d, "VANYANSAUTODETAIL.COM", bahn(96, "Bold"), 0, 4300, 14, BLUE_HOT, center_on=W / 2)

    path = os.path.join(HERE, "vanyans-aframe-20x30.png")
    canvas.save(path)
    canvas.resize((W // 4, H // 4), LANCZOS).save(os.path.join(HERE, "_review_aframe.jpg"), quality=92)
    print(path, canvas.size, "%.1f MB" % (os.path.getsize(path) / 1e6))


if __name__ == "__main__":
    main()
