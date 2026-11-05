"""Composes the final demo video: screencast frames + PayPal popup window + burned-in English
subtitles + Kokoro narration -> H.264/AAC MP4 (and an .srt with the same captions).

usage: python3 scripts/video/compose.py <recording_dir> <out.mp4>
"""
import bisect
import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REC, OUT = Path(sys.argv[1]), Path(sys.argv[2])
rec = json.loads((REC / "recording.json").read_text())
nar = json.loads((REC / "narration.json").read_text())
W, H, FPS, SR = 1920, 1080, 30, 24000
LEAD, TAIL, GAP = 0.25, 0.45, 0.28
MIN_SPEED, MAX_SPEED = 0.6, 6.0
MAX_TOTAL = 148.0
FONT = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"

markers = {}
for m in rec["markers"]:
    markers.setdefault(m["name"], m)
main, popup = rec["main"], rec["popup"]
main_ts = [f["t"] for f in main]
popup_ts = [f["t"] for f in popup]
popup_end = (popup_ts[-1] + 0.15) if popup_ts else 0
markers["popup_done"] = {"t": max(popup_end, markers["popup_click"]["t"] + 1.0)}


def mt(name):
    return markers[name]["t"]


# ---------------------------------------------------------------- timeline
def build(lead, tail, gap):
    shots, t = [], 0.0
    for s in nar["shots"]:
        speech = sum(x["dur"] for x in s["sentences"]) + gap * (len(s["sentences"]) - 1)
        dur = lead + speech + tail
        card = s["from"].startswith("card:")
        if card:
            dur += 1.4 if s["from"] == "card:end" else 0.3
            src0 = src_d = speed = 0.0
        else:
            src0, src1 = mt(s["from"]), mt(s["to"])
            src_d = max(0.01, src1 - src0)
            speed = min(MAX_SPEED, max(MIN_SPEED, src_d / dur))
            dur = max(dur, src_d / speed) if speed >= MAX_SPEED else dur
        subs, st = [], t + lead
        for x in s["sentences"]:
            subs.append({"start": st, "end": st + x["dur"], **x})
            st += x["dur"] + gap
        shots.append({"start": t, "dur": dur, "card": s["from"][5:] if card else None, "src0": src0, "src_d": src_d, "speed": speed, "subs": subs})
        t += dur
    return shots, t


shots, total = build(LEAD, TAIL, GAP)
if total > MAX_TOTAL:  # tighten pauses if needed to stay under 2:30
    shots, total = build(0.15, 0.25, 0.18)
print(f"total duration {total:.1f}s over {len(shots)} shots")
for s in shots:
    print(f"  {s['start']:6.1f}s +{s['dur']:5.1f}s  speed {s['speed']:.2f}  {s['card'] or ''} {s['subs'][0]['display'][:60]}")
assert total <= 150, "video would exceed 2:30"

# ---------------------------------------------------------------- assets
cards = {n: Image.open(REC / "cards" / f"{n}.png").convert("RGB").resize((W, H), Image.LANCZOS) for n in ("title", "end")}
S = 1.2
PW, PH = 568, 750
if popup:
    PW, PH = Image.open(REC / popup[0]["file"]).size
pw, ph = int(PW * S), int(PH * S)
BAR = 46
login_card = Image.open(REC / "cards" / "login.png").convert("RGB").resize((pw, ph), Image.LANCZOS)
win_x, win_y = (W - pw) // 2, (H - ph - BAR) // 2


def window_frame():
    """Browser-window chrome + shadow, drawn once."""
    frame = Image.new("RGBA", (pw + 120, ph + BAR + 120), (0, 0, 0, 0))
    sh = Image.new("L", frame.size, 0)
    ImageDraw.Draw(sh).rounded_rectangle([60, 72, 60 + pw, 72 + ph + BAR], radius=18, fill=150)
    frame.putalpha(sh.filter(ImageFilter.GaussianBlur(26)))
    chrome = Image.new("RGBA", (pw, BAR), (235, 238, 242, 255))
    d = ImageDraw.Draw(chrome)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse([18 + i * 24, 16, 32 + i * 24, 30], fill=c)
    f = ImageFont.truetype(FONT, 18)
    label = "sandbox.paypal.com"
    tw = d.textlength(label, font=f)
    d.rounded_rectangle([(pw - tw) / 2 - 16, 9, (pw + tw) / 2 + 16, 37], radius=9, fill=(255, 255, 255))
    d.text(((pw - tw) / 2, 12), label, fill=(70, 80, 95), font=f)
    frame.alpha_composite(chrome, (60, 60))
    return frame


WINDOW = window_frame()
CURSOR = Image.new("RGBA", (36, 36), (0, 0, 0, 0))
ImageDraw.Draw(CURSOR).polygon([(4, 2), (28, 15), (17, 18), (12, 30)], fill=(13, 23, 38), outline=(255, 255, 255), width=2)

font_sub = ImageFont.truetype(FONT, 40)


def wrap(text, width=1540):
    d = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    lines, cur = [], ""
    for w in text.split():
        trial = f"{cur} {w}".strip()
        if d.textlength(trial, font=font_sub) <= width:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def sub_image(lines):
    d = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    tw = int(max(d.textlength(l, font=font_sub) for l in lines))
    lh = 54
    img = Image.new("RGBA", (tw + 56, lh * len(lines) + 30), (0, 0, 0, 0))
    dd = ImageDraw.Draw(img)
    dd.rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=16, fill=(10, 18, 30, 222))
    for i, l in enumerate(lines):
        lw = dd.textlength(l, font=font_sub)
        dd.text(((img.width - lw) / 2, 13 + i * lh), l, font=font_sub, fill=(255, 255, 255))
    return img


# subtitle chunks (max 2 lines each), timed by character share within the sentence
chunks = []
for s in shots:
    for x in s["subs"]:
        lines = wrap(x["display"])
        groups = [lines[i : i + 2] for i in range(0, len(lines), 2)]
        chars = [sum(len(l) for l in g) for g in groups]
        t = x["start"]
        for g, c in zip(groups, chars):
            d = (x["end"] - x["start"]) * c / sum(chars)
            chunks.append({"start": t, "end": t + d, "text": " ".join(g), "img": sub_image(g)})
            t += d
chunk_starts = [c["start"] for c in chunks]

# ---------------------------------------------------------------- audio
audio = np.zeros(int((total + 0.5) * SR), dtype=np.float32)
for s in shots:
    for x in s["subs"]:
        with wave.open(x["wav"]) as wf:
            data = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        i = int(x["start"] * SR)
        audio[i : i + len(data)] += data[: len(audio) - i]
peak = np.max(np.abs(audio)) or 1
audio = np.clip(audio / peak * 0.92, -1, 1)
wav_path = OUT.with_suffix(".wav")
with wave.open(str(wav_path), "wb") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    wf.writeframes((audio * 32767).astype(np.int16).tobytes())


# ---------------------------------------------------------------- subtitles file
def ts(t):
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int((s % 1) * 1000):03d}"


OUT.with_suffix(".srt").write_text(
    "\n".join(f"{i + 1}\n{ts(c['start'])} --> {ts(c['end'])}\n{c['text']}\n" for i, c in enumerate(chunks))
)

# ---------------------------------------------------------------- video frames
ff = subprocess.Popen(
    ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
     "-i", str(wav_path), "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(OUT)],
    stdin=subprocess.PIPE,
)
cache = {}


def load(path):
    if path not in cache:
        if len(cache) > 6:
            cache.clear()
        cache[path] = Image.open(REC / path).convert("RGB")
    return cache[path]


shot_starts = [s["start"] for s in shots]
click_t = markers["popup_click"]["t"] + 0.7
box = rec.get("popupBox") or markers["popup_click"].get("box")
n_frames = int(total * FPS)
last_key, last_bytes = None, None
for k in range(n_frames):
    tau = k / FPS
    s = shots[max(0, bisect.bisect_right(shot_starts, tau) - 1)]
    ci = bisect.bisect_right(chunk_starts, tau) - 1
    chunk = chunks[ci] if ci >= 0 and chunks[ci]["start"] <= tau < chunks[ci]["end"] + 0.12 else None
    if s["card"]:
        key = ("card", s["card"], id(chunk))
        if key != last_key:
            img = cards[s["card"]].copy()
    else:
        src_t = s["src0"] + min(s["src_d"], (tau - s["start"]) * s["speed"])
        mi = max(0, bisect.bisect_right(main_ts, src_t) - 1)
        pop = None
        if popup and markers["popup_open"]["t"] <= src_t <= popup_end:
            if src_t < markers["login_end"]["t"]:
                pop = "login"
            else:
                pop = max(0, bisect.bisect_right(popup_ts, src_t) - 1)
        cur = None
        if pop not in (None, "login") and box and click_t - 0.9 <= src_t <= popup_end:
            p = min(1.0, max(0.0, (src_t - (click_t - 0.9)) / 0.7))
            p = 1 - (1 - p) ** 3
            bx, by = (box["x"] + box["width"] / 2) * S, (box["y"] + box["height"] / 2) * S
            sx, sy = pw * 0.75, ph * 0.9
            cur = (round(sx + (bx - sx) * p), round(sy + (by - sy) * p), src_t >= click_t)
        key = (mi, pop, cur, id(chunk))
        if key != last_key:
            img = load(main[mi]["file"]).copy()
            if pop is not None:
                rgba = img.convert("RGBA")
                rgba.alpha_composite(WINDOW, (win_x - 60, win_y - 60))
                content = login_card if pop == "login" else load(popup[pop]["file"]).resize((pw, ph), Image.LANCZOS)
                rgba.paste(content, (win_x, win_y + BAR))
                if cur:
                    cx, cy, clicked = cur
                    if clicked and src_t - click_t < 0.5:
                        r = int(18 + 40 * (src_t - click_t))
                        ring = Image.new("RGBA", (2 * r, 2 * r), (0, 0, 0, 0))
                        ImageDraw.Draw(ring).ellipse([0, 0, 2 * r - 1, 2 * r - 1], fill=(13, 122, 95, int(120 * (1 - (src_t - click_t) / 0.5))))
                        rgba.alpha_composite(ring, (win_x + cx - r, win_y + BAR + cy - r))
                    rgba.alpha_composite(CURSOR, (win_x + cx - 4, win_y + BAR + cy - 3))
                img = rgba.convert("RGB")
    if key != last_key:
        if chunk:
            si = chunk["img"]
            base = img.convert("RGBA")
            base.alpha_composite(si, ((W - si.width) // 2, H - 64 - si.height))
            img = base.convert("RGB")
        last_bytes = img.tobytes()
        last_key = key
    ff.stdin.write(last_bytes)
    if k % 600 == 0:
        print(f"frame {k}/{n_frames}", flush=True)
ff.stdin.close()
ff.wait()
print("wrote", OUT, f"{OUT.stat().st_size / 1e6:.1f} MB")
