"""Compose Devpost gallery images (3:2, 2400x1600) from the raw shots of scripts/screenshots.mjs.

usage: python3 scripts/make_gallery.py <shots_dir> <out_dir>
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
DPR = 2
W, H = 2400, 1600
BG = (244, 246, 249)
META = json.loads((SRC / "meta.json").read_text())
FONT_DIR = Path("/usr/share/fonts/opentype/inter")


def font(size, weight="Medium"):
    for name in (f"Inter-{weight}.otf", "Inter-Regular.otf"):
        p = FONT_DIR / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


def img(name):
    return Image.open(SRC / f"{name}.png").convert("RGB")


def box(shot, sel, pad=18):
    b = META["boxes"][shot][sel]
    return (
        max(0, int((b["x"] - pad) * DPR)),
        max(0, int((b["y"] - pad) * DPR)),
        int((b["x"] + b["w"] + pad) * DPR),
        int((b["y"] + b["h"] + pad) * DPR),
    )


def fit_32(im, bg=BG):
    """Pad to 3:2 with the app background, then scale to W x H."""
    w, h = im.size
    if w / h > W / H:
        nh = round(w * H / W)
        canvas = Image.new("RGB", (w, nh), bg)
        canvas.paste(im, (0, (nh - h) // 2))
    else:
        nw = round(h * W / H)
        canvas = Image.new("RGB", (nw, h), bg)
        canvas.paste(im, ((nw - w) // 2, 0))
    return canvas.resize((W, H), Image.LANCZOS)


def save(im, name):
    path = OUT / name
    im.save(path, optimize=True)
    print(f"{path} {im.size} {path.stat().st_size // 1024} KB")


def window(popup, title):
    """Wrap a popup screenshot in a simple browser-window frame with a soft shadow."""
    bar = 64
    w, h = popup.size
    frame = Image.new("RGBA", (w, h + bar), (0, 0, 0, 0))
    mask = Image.new("L", frame.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h + bar - 1], radius=22, fill=255)
    body = Image.new("RGB", frame.size, (235, 238, 242))
    d = ImageDraw.Draw(body)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse([28 + i * 34, 22, 48 + i * 34, 42], fill=c)
    f = font(26)
    tw = d.textlength(title, font=f)
    d.rounded_rectangle([(w - tw) / 2 - 24, 12, (w + tw) / 2 + 24, 52], radius=12, fill=(255, 255, 255))
    d.text(((w - tw) / 2, 17), title, fill=(70, 80, 95), font=f)
    body.paste(popup, (0, bar))
    frame.paste(body, (0, 0), mask)
    shadow = Image.new("RGBA", (frame.width + 160, frame.height + 160), (0, 0, 0, 0))
    sm = Image.new("L", shadow.size, 0)
    ImageDraw.Draw(sm).rounded_rectangle([80, 96, 80 + frame.width, 96 + frame.height], radius=26, fill=150)
    shadow.putalpha(sm.filter(ImageFilter.GaussianBlur(34)))
    shadow.paste(frame, (80, 80), frame)
    return shadow


# 1. Workspace overview after the errand (steps, PayPal-backed meter, agent console with recap)
closed = img("08-closed")
save(closed.crop((0, 0, 2880, 1920)).resize((W, H), Image.LANCZOS), "gallery-1-workspace.png")

# 2. PayPal approval: the real sandbox popup over the page (PayPal's own overlay underneath)
base = img("03-paypal-main").convert("RGBA")
pop = window(img("03-paypal-popup"), "sandbox.paypal.com")
base.alpha_composite(pop, ((base.width - pop.width) // 2, (base.height - pop.height) // 2 + 20))
save(base.convert("RGB").resize((W, H), Image.LANCZOS), "gallery-2-paypal-approval.png")

# 3. The AG Grid agent ledger: AI reasoning, policy firewall, AI auditor and PayPal IDs per attempt
save(fit_32(closed.crop(box("08-closed", "#ledger-card"))), "gallery-3-ledger.png")

# 4. Mandates grid (AI recap + PayPal authorization state) above the hostile store catalog
hist = img("09-mandates").crop(box("09-mandates", "#view-history .card"))
store_full = img("10-store")
sb = box("10-store", "#view-store .card")
store = store_full.crop((sb[0], sb[1], sb[2], min(sb[3], sb[1] + 1160)))
gap = 36
col = Image.new("RGB", (max(hist.width, store.width), hist.height + gap + store.height), BG)
col.paste(hist, (0, 0))
col.paste(store, (0, hist.height + gap))
save(fit_32(col), "gallery-4-mandates-and-store.png")

# 5. Landing page with the pitch and the three-step explanation
save(img("01-landing").crop((0, 0, 2880, 1920)).resize((W, H), Image.LANCZOS), "gallery-5-landing.png")
