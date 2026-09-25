"""Draw the Vanyan's Auto Detail mark and export every size the business uses.

    python make_logo.py

The mark is a V cut from two blades: a silver blade for the finish and a blue
blade for the brand, tucked behind it with a clean gap, like light on a panel.
Everything is drawn once on a large master canvas and scaled down, so edges
stay crisp at every size from a 30px nav icon to print.

Writes into brand/:
    vanyans-mark.png          transparent mark, 2048px
    vanyans-icon.png          mark on the navy tile, 2048px
    vanyans-avatar.png        1080px, Instagram and Facebook profile picture
    vanyans-lockup-dark.png   mark and wordmark on navy
    vanyans-lockup-light.png  mark and wordmark on off white
    preview.png               everything on one sheet
and replaces site/img/logo.jpg (the old emblem is kept as brand/logo-old.jpg).
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_IMG = os.path.normpath(os.path.join(HERE, "..", "site", "img"))
FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
LANCZOS = Image.Resampling.LANCZOS

NAVY = (11, 21, 36)
NAVY_LIFT = (24, 44, 72)
OFFWHITE = (247, 246, 243)
BLUE = (27, 109, 224)
SILVER = ((255, 255, 255), (168, 182, 200))
INKBLADE = ((34, 52, 78), (11, 21, 36))
BLUEBLADE = ((96, 164, 255), (27, 109, 224))

S = 4000  # master canvas

# blade outlines on a 1000 unit square
LEFT = [(228, 250), (362, 250), (538, 756), (466, 756)]
RIGHT = [(652, 250), (772, 250), (520, 800), (440, 800)]
GAP = 26
TOP, BOTTOM, MID = 250, 756, 503


def tf(pts, scale):
    return [(((x - 500) * scale + 500) * S / 1000, ((y - MID) * scale + 500) * S / 1000) for x, y in pts]


def yline(y, scale):
    return int(((y - MID) * scale + 500) * S / 1000)


def gradient(top, bot, y0, y1):
    im = Image.new("RGB", (S, S), bot)
    im.paste(top, (0, 0, S, y0))
    ramp = Image.linear_gradient("L").resize((S, y1 - y0))
    im.paste(Image.composite(Image.new("RGB", ramp.size, bot), Image.new("RGB", ramp.size, top), ramp), (0, y0))
    return im


def mark(scale=1.12, left_colors=SILVER):
    left = Image.new("L", (S, S), 0)
    ImageDraw.Draw(left).polygon(tf(LEFT, scale), fill=255)

    right = Image.new("L", (S, S), 0)
    rd = ImageDraw.Draw(right)
    rd.polygon(tf(RIGHT, scale), fill=255)
    rd.rectangle((0, yline(BOTTOM, scale), S, S), fill=0)  # shares the white blade's flat foot
    # never let blue show on the far side of the white blade
    rd.polygon(tf([(0, 0), (275, 0), (623, 1000), (0, 1000)], scale), fill=0)

    # carve the gap: the left blade grown by GAP on every side
    gap = Image.new("L", (S, S), 0)
    gw = int(GAP * scale * S / 1000)
    ImageDraw.Draw(gap).polygon(tf(LEFT, scale), fill=255, outline=255, width=gw * 2)
    right = ImageChops.subtract(right, gap)

    y0, y1 = yline(TOP, scale), yline(BOTTOM, scale)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(gradient(*BLUEBLADE, y0, y1), (0, 0), right)
    out.paste(gradient(*left_colors, y0, y1), (0, 0), left)
    return out


def tile(m):
    bg = Image.new("RGB", (S, S), NAVY)
    g = int(S * 1.5)
    lift = ImageChops.invert(Image.radial_gradient("L")).point(lambda v: int(v * v / 255 * 0.85))
    mask = Image.new("L", (S, S), 0)
    mask.paste(lift.resize((g, g), LANCZOS), ((S - g) // 2, int(S * 0.36) - g // 2))
    bg = Image.composite(Image.new("RGB", (S, S), NAVY_LIFT), bg, mask).convert("RGBA")

    small = m.getchannel("A").resize((500, 500), LANCZOS).filter(ImageFilter.GaussianBlur(22))
    glow = Image.new("RGBA", (S, S), BLUE + (0,))
    glow.putalpha(small.point(lambda v: int(v * 0.38)).resize((S, S), LANCZOS))
    bg.alpha_composite(glow)
    bg.alpha_composite(m)
    return bg


def bahn(size, style):
    f = ImageFont.truetype(os.path.join(FONTS, "bahnschrift.ttf"), size)
    f.set_variation_by_name(style)
    return f


def tracked(draw, xy, text, font, fill, track):
    x, y = xy
    for c in text:
        draw.text((x, y), c, font=font, fill=fill, anchor="ls")
        x += font.getlength(c) + track
    return x - track


def track_len(text, font, track):
    return sum(font.getlength(c) + track for c in text) - track


def lockup(dark=True):
    m = mark(1.0, SILVER if dark else INKBLADE)
    m = m.crop(m.getbbox())
    mh = 640
    m = m.resize((round(m.width * mh / m.height), mh), LANCZOS)

    name_f, sub_f = bahn(300, "Bold"), bahn(100, "SemiLight")
    name, sub = "VANYAN\u2019S", "AUTO DETAIL"
    name_w = track_len(name, name_f, 18)
    sub_w = track_len(sub, sub_f, 56)
    pad, between = 200, 120
    W, H = int(pad * 2 + m.width + between + max(name_w, sub_w)), 1000

    im = Image.new("RGBA", (W, H), (NAVY if dark else OFFWHITE) + (255,))
    im.alpha_composite(m, (pad, (H - mh) // 2))
    d = ImageDraw.Draw(im)
    x = pad + m.width + between
    tracked(d, (x, H // 2 + 70), name, name_f, (245, 247, 250) if dark else NAVY, 18)
    tracked(d, (x + 6, H // 2 + 70 + 150), sub, sub_f, BLUE if not dark else (96, 164, 255), 56)
    return im


def main():
    m = mark()
    icon = tile(m)

    m.resize((2048, 2048), LANCZOS).save(os.path.join(HERE, "vanyans-mark.png"))
    icon.resize((2048, 2048), LANCZOS).save(os.path.join(HERE, "vanyans-icon.png"))
    icon.resize((1080, 1080), LANCZOS).save(os.path.join(HERE, "vanyans-avatar.png"))
    icon.convert("RGB").resize((512, 512), LANCZOS).save(os.path.join(SITE_IMG, "logo.jpg"), quality=93)

    dark, light = lockup(True), lockup(False)
    dark.save(os.path.join(HERE, "vanyans-lockup-dark.png"))
    light.save(os.path.join(HERE, "vanyans-lockup-light.png"))

    # one sheet to judge it at real sizes
    sheet = Image.new("RGB", (2000, 2100), (228, 226, 220))
    sheet.paste(icon.resize((600, 600), LANCZOS), (60, 60))
    av = icon.resize((420, 420), LANCZOS)
    circle = Image.new("L", av.size, 0)
    ImageDraw.Draw(circle).ellipse((0, 0, 419, 419), fill=255)
    sheet.paste(av, (720, 60), circle)
    for i, s in enumerate((96, 60, 30, 16)):
        sheet.paste(icon.resize((s, s), LANCZOS), (1200 + sum((96, 60, 30, 16)[:i]) + 30 * i, 60))
    dk = dark.resize((1880, round(dark.height * 1880 / dark.width)), LANCZOS)
    sheet.paste(dk, (60, 720))
    lt = light.resize((940, round(light.height * 940 / light.width)), LANCZOS)
    sheet.paste(lt, (60, 720 + dk.height + 40))
    sheet.save(os.path.join(HERE, "preview.png"))
    print("done")


if __name__ == "__main__":
    main()
