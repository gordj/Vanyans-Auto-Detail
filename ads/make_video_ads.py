"""Render Meta video ads for Vanyan's Auto Detail from the real job photos.

    python make_video_ads.py                 # every ad, both formats
    python make_video_ads.py reveal          # only the named ads
    python make_video_ads.py --stills DIR    # contact sheets instead of video

Each ad renders twice into ads/video/:
    <name>_9x16.mp4   Reels and Stories
    <name>_4x5.mp4    Feed

All text stays inside Meta's safe zones, so the Reels caption, profile row and
buttons never cover it. Photos only come from site/img, nothing stock.
"""
import math
import os
import subprocess
import sys

import imageio_ffmpeg
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.normpath(os.path.join(HERE, "..", "site", "img"))
OUT = os.path.join(HERE, "video")
FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
FPS = 30

NAVY = (11, 21, 36)
INK = (4, 8, 16)
BLUE = (27, 109, 224)
HOT = (59, 135, 245)
WHITE = (255, 255, 255)
SOFT = (196, 206, 220)

BICUBIC = Image.Resampling.BICUBIC
LANCZOS = Image.Resampling.LANCZOS

FORMATS = {
    # top and bottom bound the band text may occupy
    "9x16": dict(size=(1080, 1920), top=300, bottom=1240, margin=84, scale=1.0),
    "4x5": dict(size=(1080, 1350), top=96, bottom=1250, margin=84, scale=0.88),
}


# ---------------------------------------------------------------- helpers

def ease(p):
    p = max(0.0, min(1.0, p))
    return 0.5 - 0.5 * math.cos(math.pi * p)


def out_cubic(p):
    p = max(0.0, min(1.0, p))
    return 1 - (1 - p) ** 3


def fade(img, o):
    if o >= 0.999:
        return img
    out = img.copy()
    out.putalpha(img.getchannel("A").point(lambda v: int(v * o)))
    return out


_fonts = {}


def font(kind, size):
    key = (kind, size)
    if key not in _fonts:
        if kind in ("display", "label", "light"):
            f = ImageFont.truetype(os.path.join(FONTS, "bahnschrift.ttf"), size)
            f.set_variation_by_name({"display": "Bold", "label": "SemiBold", "light": "SemiLight"}[kind])
        else:
            # Segoe carries Armenian and Cyrillic, Bahnschrift does not
            name = "segoeuib.ttf" if kind == "intl" else "segoeui.ttf"
            f = ImageFont.truetype(os.path.join(FONTS, name), size)
        _fonts[key] = f
    return _fonts[key]


BEST = os.path.normpath(os.path.join(HERE, "..", "shots", "best"))
_src, _factor = {}, {}


def source(name, blur=0):
    """Load a photo once. "best:" names come from the shortlist in shots/best.

    Small web photos are upscaled 2x so pans resample from real detail; full
    camera frames are already bigger than the video and are used as they are.
    """
    key = (name, blur)
    if key not in _src:
        if blur:
            im = source(name).filter(ImageFilter.GaussianBlur(blur))
        else:
            path = os.path.join(BEST, name[5:]) if name.startswith("best:") else os.path.join(IMG, name)
            im = Image.open(path).convert("RGB")
            f = 2 if max(im.size) < 2000 else 1
            if f > 1:
                im = im.resize((im.width * f, im.height * f), LANCZOS)
                im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=45, threshold=2))
            _factor[name] = f
        _src[key] = im
    return _src[key]


_ov = {}


def overlay(fmt, size, strength):
    """Vignette, a top scrim so headlines read, and a bottom scrim under Reels UI."""
    key = (fmt, strength)
    if key not in _ov:
        W, H = size
        lin = Image.linear_gradient("L").resize((W, H), BICUBIC)
        a = Image.radial_gradient("L").resize((W, H), BICUBIC).point(
            lambda v: int(max(0, v - 100) / 155 * 130))
        if strength:
            top = lin.point(lambda v: min(255, int(230 * strength * max(0.0, 1 - (v / 255) / 0.6) ** 1.4)))
            a = ImageChops.lighter(a, top)
        if fmt == "9x16":
            bot = lin.point(lambda v: int(150 * max(0.0, (v / 255 - 0.74) / 0.26) ** 1.5))
            a = ImageChops.lighter(a, bot)
        ov = Image.new("RGBA", (W, H), INK + (255,))
        ov.putalpha(a)
        _ov[key] = ov
    return _ov[key]


_strips = {}


def strip(H):
    """The blue light line that leads a wipe, same move as the site hero."""
    if H not in _strips:
        w = 160
        col = Image.new("L", (w, 1))
        for x in range(w):
            d = abs(x - w / 2)
            col.putpixel((x, 0), min(255, int(235 * math.exp(-(d / 24) ** 2))))
        im = Image.new("RGBA", (w, H), HOT + (0,))
        im.putalpha(col.resize((w, H)))
        ImageDraw.Draw(im).rectangle((w // 2 - 2, 0, w // 2 + 2, H), fill=(235, 244, 255, 255))
        _strips[H] = im
    return _strips[H]


# ---------------------------------------------------------------- backgrounds

class Shot:
    """A slow camera move over one photo: (cx, cy, zoom) from a to b.

    Centre is in original photo pixels and gets clamped so the frame never
    leaves the photo. f9x16= / f4x5= override the move for one format.
    """

    def __init__(self, name, a, b, dim=0.0, blur=0, gain=1.0, spot=None, **per):
        self.name, self.a, self.b, self.dim, self.blur, self.gain, self.per = name, a, b, dim, blur, gain, per
        # spot=(x, y, radius, strength) as fractions of the frame: light the subject,
        # sink everything around it (used to lose a busy background)
        self.spot = spot

    def __call__(self, fmt, size, p):
        a, b = self.per.get("f" + fmt, (self.a, self.b))
        W, H = size
        asp = W / H
        im = source(self.name, self.blur)
        f = _factor[self.name]
        sw, sh = im.width / f, im.height / f
        k = ease(p)
        cx, cy, z = (a[i] + (b[i] - a[i]) * k for i in range(3))
        h = min(sh, sw / asp) / z
        w = h * asp
        x0 = min(max(cx - w / 2, 0), sw - w)
        y0 = min(max(cy - h / 2, 0), sh - h)
        fr = im.transform(size, Image.Transform.EXTENT,
                          (x0 * f, y0 * f, (x0 + w) * f, (y0 + h) * f), BICUBIC)
        if self.gain != 1.0:
            fr = ImageEnhance.Brightness(fr).enhance(self.gain)
        if self.dim:
            fr = Image.blend(fr, Image.new("RGB", size, NAVY), self.dim)
        if self.spot:
            fr = Image.composite(Image.new("RGB", size, INK), fr, spotmask(size, self.spot))
        return fr


_spots = {}


def spotmask(size, spot):
    key = (size, spot)
    if key not in _spots:
        W, H = size
        x, y, r, strength = spot
        d = int(max(W, H) * r * 2)
        ring = Image.radial_gradient("L").resize((d, d), BICUBIC).point(
            lambda v: int(min(255, max(0, (v - 90) / 165 * 255)) * strength))
        m = Image.new("L", size, int(255 * strength))
        m.paste(ring, (int(W * x) - d // 2, int(H * y) - d // 2))
        _spots[key] = m
    return _spots[key]


class EndBg:
    def __init__(self):
        self.cache = {}

    def __call__(self, fmt, size, p):
        if size not in self.cache:
            W, H = size
            base = Shot("cine-clean.jpg", (960, 540, 1.0), (960, 540, 1.0))(fmt, size, 0)
            base = base.filter(ImageFilter.GaussianBlur(40))
            base = Image.blend(base, Image.new("RGB", size, NAVY), 0.8).convert("RGBA")
            # soft blue light behind the logo
            g = int(W * 1.3)
            glow = ImageChops.invert(Image.radial_gradient("L")).point(lambda v: int(v * v / 255 * 0.5))
            layer = Image.new("RGBA", (g, g), BLUE + (0,))
            layer.putalpha(glow.resize((g, g), BICUBIC))
            full = Image.new("RGBA", size, (0, 0, 0, 0))
            full.paste(layer, ((W - g) // 2, int(H * 0.33) - g // 2), layer)
            base.alpha_composite(full)
            self.cache[size] = base.convert("RGB")
        return self.cache[size].copy()


END = EndBg()


# ---------------------------------------------------------------- elements

class El:
    """A pre-rendered layer that rises and fades in at its delay."""

    def __init__(self, img, pad, gap=0, delay=0.0, align="left", rise=38):
        self.img, self.pad, self.gap, self.delay, self.align, self.rise = img, pad, gap, delay, align, rise
        self.h = img.height - 2 * pad

    def draw(self, frame, y, t, spec):
        lt = t - self.delay
        if lt <= 0:
            return
        p = out_cubic(lt / 0.6)
        if self.align == "left":
            x = spec["margin"] - self.pad
        else:
            x = (frame.width - self.img.width) // 2
        yy = int(round(y - self.pad + (1 - p) * self.rise))
        frame.alpha_composite(fade(self.img, p), (max(0, x), max(0, yy)))


def seg_len(s, f, track):
    return f.getlength(s) if not track else sum(f.getlength(c) + track for c in s)


def text_img(lines, kind, size, max_w, color, lead, track, align, shadow):
    lines = [[(l, color)] if isinstance(l, str) else l for l in lines]
    while True:
        f = font(kind, size)
        widths = [sum(seg_len(s, f, track) for s, _ in l) for l in lines]
        if max(widths) <= max_w or size <= 28:
            break
        size -= 3
    asc, desc = f.getmetrics()
    lh = round(size * lead)
    pad = 44
    W = int(math.ceil(max(widths))) + pad * 2
    H = lh * (len(lines) - 1) + asc + desc + pad * 2
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    y = pad
    for l, lw in zip(lines, widths):
        x = pad if align == "left" else pad + (W - 2 * pad - lw) / 2
        for s, col in l:
            if track:
                for c in s:
                    d.text((x, y), c, font=f, fill=col)
                    x += f.getlength(c) + track
            else:
                d.text((x, y), s, font=f, fill=col)
                x += f.getlength(s)
        y += lh
    if shadow:
        a = lay.getchannel("A").filter(ImageFilter.GaussianBlur(16)).point(lambda v: int(v * shadow))
        out = Image.new("RGBA", lay.size, INK + (0,))
        out.putalpha(a)
        out.alpha_composite(lay)
        lay = out
    return lay, pad


def T(spec, lines, kind="display", size=110, color=WHITE, track=0, lead=1.04,
      gap=0, delay=0.0, align="left", shadow=0.6):
    sc = spec["scale"]
    max_w = spec["size"][0] - 2 * spec["margin"]
    img, pad = text_img(lines, kind, round(size * sc), max_w, color, lead, track, align, shadow)
    return El(img, pad, round(gap * sc), delay, align)


def EB(spec, text, **kw):
    kw.setdefault("color", HOT)
    return T(spec, [text], "label", 44, track=7, lead=1.0, shadow=0.9, **kw)


def button(spec, text, gap=0, delay=0.0, size=1.0):
    sc = spec["scale"] * size
    f = font("label", round(46 * sc))
    bw, bh, pad = int(f.getlength(text) + 130 * sc), int(112 * sc), 44
    lay = Image.new("RGBA", (bw + pad * 2, bh + pad * 2), (0, 0, 0, 0))
    box = (pad, pad, pad + bw, pad + bh)
    glow = Image.new("RGBA", lay.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle(box, radius=int(16 * sc), fill=BLUE + (190,))
    lay.alpha_composite(glow.filter(ImageFilter.GaussianBlur(22)))
    d = ImageDraw.Draw(lay)
    d.rounded_rectangle(box, radius=int(16 * sc), fill=BLUE)
    d.text((pad + bw / 2, pad + bh / 2), text, font=f, fill=WHITE, anchor="mm")
    return El(lay, pad, round(gap * sc), delay, "center")


def logo(spec, size=184, gap=0, delay=0.0):
    sc = spec["scale"]
    s, pad = round(size * sc), 44
    big = s * 3
    lg = Image.open(os.path.join(IMG, "logo.jpg")).convert("RGB").resize((big, big), LANCZOS)
    # the app icon shape, same rounding the site nav gives the mark
    radius = int(big * 0.22)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=radius, fill=255)
    disc = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    disc.paste(lg, (0, 0), mask)
    ImageDraw.Draw(disc).rounded_rectangle((0, 0, big - 1, big - 1), radius=radius,
                                           outline=(255, 255, 255, 40), width=6)
    disc = disc.resize((s, s), LANCZOS)
    lay = Image.new("RGBA", (s + pad * 2, s + pad * 2), (0, 0, 0, 0))
    glow = Image.new("RGBA", lay.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle((pad, pad, pad + s, pad + s), radius=int(s * 0.22), fill=BLUE + (150,))
    lay.alpha_composite(glow.filter(ImageFilter.GaussianBlur(26)))
    lay.alpha_composite(disc, (pad, pad))
    return El(lay, pad, round(gap * sc), delay, "center", rise=20)


class Panel:
    """The plan price card, rows arriving one after another."""

    def __init__(self, spec, rows, gap=0, delay=0.0):
        sc = spec["scale"]
        self.w = spec["size"][0] - 2 * spec["margin"]
        self.rh, self.inset = round(150 * sc), round(18 * sc)
        self.h = self.rh * len(rows) + 2 * self.inset
        self.gap, self.delay = round(gap * sc), delay
        self.bg = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        ImageDraw.Draw(self.bg).rounded_rectangle((0, 0, self.w - 1, self.h - 1), radius=int(22 * sc),
                                                  fill=NAVY + (220,), outline=(255, 255, 255, 46), width=2)
        lf, pf, ff = font("label", round(38 * sc)), font("display", round(86 * sc)), font("light", round(34 * sc))
        side, base = round(46 * sc), round(self.rh / 2 + 30 * sc)
        self.rows = []
        for i, (label, price) in enumerate(rows):
            r = Image.new("RGBA", (self.w, self.rh), (0, 0, 0, 0))
            d = ImageDraw.Draw(r)
            x = side
            for c in label:
                d.text((x, base), c, font=lf, fill=SOFT, anchor="ls")
                x += lf.getlength(c) + 4
            rx = self.w - side
            d.text((rx, base), price, font=pf, fill=WHITE, anchor="rs")
            d.text((rx - pf.getlength(price) - 14 * sc, base), "from", font=ff, fill=HOT, anchor="rs")
            if i < len(rows) - 1:
                d.line((side, self.rh - 1, self.w - side, self.rh - 1), fill=(255, 255, 255, 40), width=2)
            self.rows.append(r)

    def draw(self, frame, y, t, spec):
        lt = t - self.delay
        if lt <= 0:
            return
        x = spec["margin"]
        frame.alpha_composite(fade(self.bg, out_cubic(lt / 0.6)), (x, int(y)))
        for i, r in enumerate(self.rows):
            q = out_cubic((lt - 0.35 - 0.32 * i) / 0.55)
            if q > 0:
                frame.alpha_composite(fade(r, q), (x + int((1 - q) * 40), int(y + self.inset + i * self.rh)))


# ---------------------------------------------------------------- timeline

class Scene:
    def __init__(self, dur, bg, els, trans="fade", tdur=0.45, valign="top", scrim=1.0):
        self.dur, self.bg, self.els, self.trans, self.tdur, self.valign, self.scrim = \
            dur, bg, els, trans, tdur, valign, scrim


def render_scene(sc, fmt, spec, lt):
    size = spec["size"]
    fr = sc.bg(fmt, size, max(0.0, lt) / sc.dur).convert("RGBA")
    fr.alpha_composite(overlay(fmt, size, sc.scrim))
    total = sum(e.gap + e.h for e in sc.els)
    y = spec["top"]
    if sc.valign == "center":
        y += (spec["bottom"] - spec["top"] - total) / 2
    for e in sc.els:
        y += e.gap
        e.draw(fr, y, lt, spec)
        y += e.h
    return fr


def end_card(spec, headline, cta="Book online"):
    return Scene(4.4, END, [
        logo(spec, 230, delay=0.1),
        T(spec, ["VANYAN\u2019S"], "display", 150, track=7, lead=1.0, align="center", gap=30, delay=0.25),
        T(spec, ["AUTO DETAIL"], "light", 50, HOT, track=18, lead=1.0, align="center", gap=4, delay=0.35),
        T(spec, headline, "display", 92, lead=1.1, align="center", gap=70, delay=0.6),
        button(spec, cta, gap=40, delay=0.85, size=1.3),
        T(spec, ["vanyansautodetail.com"], "body", 50, WHITE, lead=1.0, align="center", gap=30, delay=1.0),
        T(spec, ["818.660.5845  \u00b7  Burbank, CA"], "body", 44, SOFT, lead=1.0, align="center", gap=6, delay=1.05),
    ], valign="center", scrim=0, tdur=0.5)


# ---------------------------------------------------------------- the ads

def hero(a=(550, 760, 1.0), b=(530, 600, 1.12), **kw):
    kw.setdefault("f4x5", ((550, 600, 1.0), (530, 560, 1.1)))
    return Shot("hero.jpg", a, b, **kw)


def ad_reveal(spec):
    """Corvette job, September 10 2026: foam, wipe to the finish, the work, price, book.

    Shots that show the back of a crew shirt are left out, because the shirts
    still carry the old emblem.
    """
    return [
        Scene(2.6, Shot("cine-foam.jpg", (1206, 900, 1.0), (1206, 960, 1.1)), [
            # already in on frame one: it is the thumbnail and the scroll stopper
            EB(spec, "BEFORE", delay=-0.6),
            T(spec, ["It starts", [("with foam.", HOT)]], size=150, gap=10, delay=-0.6),
        ], scrim=1.3),
        Scene(3.0, Shot("cine-clean.jpg", (1206, 960, 1.1), (1206, 900, 1.0), gain=1.08), [
            EB(spec, "AFTER", delay=0.1),
            T(spec, ["It ends", [("like this.", HOT)]], size=150, gap=10, delay=0.25),
        ], trans="wipe", tdur=0.8, scrim=1.2),
        # the site's own crop of this step, which already leaves the parked van out
        Scene(2.3, Shot("work/02-wash-a.jpg", (520, 625, 1.0), (500, 610, 1.1)), [
            T(spec, ["Hand washed.", [("Never rushed.", HOT)]], size=140, delay=0.1),
        ], scrim=1.5, tdur=0.35),
        Scene(2.3, Shot("best:05-wheel-detail-IMG_9323.jpg", (850, 1300, 1.12), (850, 1300, 1.0),
                        f4x5=((820, 1300, 1.1), (820, 1300, 1.0))), [
            T(spec, ["Every wheel.", [("Every detail.", HOT)]], size=140, delay=0.1),
        ], scrim=1.5, tdur=0.35),
        Scene(2.4, Shot("best:01-foam-cannon-IMG_9233.jpg", (900, 1350, 1.0), (880, 1300, 1.1),
                        f4x5=((800, 1350, 1.0), (800, 1300, 1.08))), [
            EB(spec, "BURBANK TO BEVERLY HILLS", delay=0.05),
            T(spec, ["We come", [("to you.", HOT)]], size=150, gap=10, delay=0.12),
        ], scrim=1.6, tdur=0.35),
        Scene(2.8, Shot("cine-clean.jpg", (1500, 1120, 1.25), (1400, 1160, 1.4), gain=1.12), [
            EB(spec, "OUT THE DOOR PRICING", delay=0.05),
            T(spec, ["Detail starts", [("at $185.", HOT)]], size=150, gap=10, delay=0.12),
            T(spec, ["Two detailers. Nothing added later."], "intl", 50, WHITE, gap=26, delay=0.45, shadow=0.9),
        ], scrim=1.4, tdur=0.4),
        end_card(spec, ["Book your detail today"]),
    ]


ADS = {
    "reveal": ad_reveal,
}


# ---------------------------------------------------------------- output

def render(name, fmt, stills=None):
    spec = FORMATS[fmt]
    W, H = spec["size"]
    scenes = ADS[name](spec)
    starts, t = [], 0.0
    for s in scenes:
        starts.append(t)
        t += s.dur
    total = t

    def frame_at(t):
        i = max(j for j in range(len(scenes)) if starts[j] <= t + 1e-9)
        sc, lt = scenes[i], t - starts[i]
        fr = render_scene(sc, fmt, spec, lt)
        if i + 1 < len(scenes):
            nx = scenes[i + 1]
            if lt > sc.dur - nx.tdur:
                q = ease((lt - (sc.dur - nx.tdur)) / nx.tdur)
                fr2 = render_scene(nx, fmt, spec, lt - sc.dur)
                if nx.trans == "wipe":
                    bx = int(W * q)
                    if bx > 0:
                        fr.paste(fr2.crop((0, 0, bx, H)), (0, 0))
                    st = strip(H)
                    half = st.width // 2
                    sx = max(0, half - bx)
                    piece = st.crop((sx, 0, min(st.width, half + (W - bx)), H))
                    if piece.width > 0:
                        fr.alpha_composite(piece, (max(0, bx - half), 0))
                else:
                    fr = Image.blend(fr, fr2, q)
        return fr.convert("RGB")

    if stills:
        shots = []
        for i, sc in enumerate(scenes):
            nx = scenes[i + 1].tdur if i + 1 < len(scenes) else 0
            shots.append(frame_at(starts[i] + sc.dur - nx - 0.05))
        tw = 360
        th = round(H * tw / W)
        sheet = Image.new("RGB", (tw * len(shots) + 10 * (len(shots) - 1), th), (40, 40, 40))
        for k, s in enumerate(shots):
            sheet.paste(s.resize((tw, th), LANCZOS), (k * (tw + 10), 0))
        os.makedirs(stills, exist_ok=True)
        path = os.path.join(stills, "%s_%s.png" % (name, fmt))
        sheet.save(path)
        print(path)
        return

    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, "%s_%s.mp4" % (name, fmt))
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
           "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
           "-map", "0:v", "-map", "1:a", "-shortest",
           "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
           "-profile:v", "high", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in range(int(round(total * FPS))):
        proc.stdin.write(frame_at(f / FPS).tobytes())
    proc.stdin.close()
    if proc.wait():
        sys.exit("ffmpeg failed on " + out)
    print("%s  %.1fs  %.1f MB" % (out, total, os.path.getsize(out) / 1e6))


def main():
    args = sys.argv[1:]
    stills = None
    if "--stills" in args:
        i = args.index("--stills")
        stills = args[i + 1]
        del args[i:i + 2]
    for name in args or list(ADS):
        for fmt in FORMATS:
            render(name, fmt, stills)


if __name__ == "__main__":
    main()
