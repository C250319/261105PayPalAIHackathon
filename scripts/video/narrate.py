"""Synthesizes the narration with Kokoro-82M (Apache-2.0, runs locally via kokoro-onnx; no API key).

Setup (once):
  python3 -m venv tts-venv && tts-venv/bin/pip install kokoro-onnx soundfile
  download onnx/model.onnx and voices/af_heart.bin from huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
usage: tts-venv/bin/python scripts/video/narrate.py <recording_dir> <model.onnx> <af_heart.bin>
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

REC, MODEL, VOICE_BIN = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
VOICE, SPEED = "af_heart", 1.06

voices = REC / "tts" / "voices.npz"
voices.parent.mkdir(parents=True, exist_ok=True)
np.savez(voices, **{VOICE: np.fromfile(VOICE_BIN, dtype=np.float32).reshape(510, 1, 256)})
kokoro = Kokoro(MODEL, str(voices))

nar = json.loads((REC / "narration.json").read_text())
total = 0.0
for shot in nar["shots"]:
    for i, s in enumerate(shot["sentences"]):
        samples, sr = kokoro.create(s["spoken"], voice=VOICE, speed=SPEED, lang="en-us")
        # trim leading/trailing near-silence so subtitle timing is tight
        idx = np.where(np.abs(samples) > 0.01)[0]
        if len(idx):
            samples = samples[max(0, idx[0] - int(0.03 * sr)) : idx[-1] + int(0.08 * sr)]
        path = REC / "tts" / f"s{shot['id']:02d}_{i}.wav"
        sf.write(path, samples, sr, subtype="PCM_16")
        s["wav"] = str(path)
        s["dur"] = round(len(samples) / sr, 3)
        total += s["dur"]
        print(f"[{shot['id']:2}] {s['dur']:5.2f}s  {s['display'][:70]}")
(REC / "narration.json").write_text(json.dumps(nar, indent=1))
print(f"total speech {total:.1f}s")
