#!/usr/bin/env python3
"""
Beat Transformer CUE-family detector — demixed beat + downbeat tracking.

Sibling to beat_this_server.py (:8008) and beatnet_server.py (:8010). Same
JSON contract, and like Beat This! it also returns fitted grid `segments`.

Detector
--------
  beat-transformer  Dilated self-attention over DEMIXED stems (Zhao, Xia &
                    Wang, ISMIR 2022). MIT code and weights.

Why this one, given we already have three beat trackers
-------------------------------------------------------
Because it attacks the half that is actually failing. On this corpus, and in
the literature, beats on four-on-the-floor material are nearly free (~0.95
F1) while DOWNBEATS collapse (0.669 on EDM vs 0.805 on pop — Raveform,
TISMIR 2025), and the downbeat is what a grid segment's bar 1 is anchored
to. Every other tracker here reads the mixdown, where the kick that marks
bar 1 is buried under everything else. This one reads the separated stems,
so the drum track drives the downbeat decision directly.

That makes it the only detector in the tree with a hard prerequisite: the
song must have Demucs stems. With none it reports so rather than silently
falling back to the mix, which would make it a worse copy of Beat This!.

Stems: trained on Spleeter, fed Demucs
--------------------------------------
Upstream trains on 5 Spleeter stems; we have 4-6 Demucs ones. That is a
smaller mismatch than it looks: the training loop randomly SUMS stem pairs
so that 2, 3, 4 and 5-channel inputs all appear during training, and the
model reads its instrument count from the input shape rather than a fixed
architecture. Different separator, same kind of input. Whether that costs
accuracy is not a matter of opinion — tools/python/beat_eval.py scores it
against the curated grids alongside every other tracker.

Endpoints
---------
  GET  /api/beat-transformer/health        → server up + dep availability
  GET  /api/beat-transformer/detect/:slug  → cached result, or null
  POST /api/beat-transformer/detect        { slug, force?, start?, end? }
  POST /api/beat-transformer/initialize    → fetch weights + warm the model

Cache
-----
  data/algorithm-outputs/beat-transformer/<slug>.json

Weights
-------
  .cache/beat-transformer/fold_0_trf_param.pt — 36 MB, fetched on first use
  from the upstream repo. Same pattern run.sh uses for the JDCNet weights.
  Eight folds exist; fold 0 is the released default. BEAT_TRANSFORMER_FOLD
  picks another.

Gated by the `experimental-models` docker compose profile and the
`experimentalCueExtras` user setting.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import warnings
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8018

sys.path.insert(0, str(Path(__file__).resolve().parent))
from beat_segments import fit_segments, summarize  # noqa: E402
from paths import (  # noqa: E402
    REPO_ROOT, find_audio, stem_audio,
    BEAT_TRANSFORMER_OUTPUTS_DIR as CACHE_DIR,
)
from server_common import cached_result, cors_headers, now_iso, parse_range, time_ms  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Upstream's feature settings. These are not tunable: the checkpoint was
# trained on exactly this representation, and changing any of them silently
# degrades the model rather than erroring.
SR, N_FFT, HOP, N_MELS, F_MIN, F_MAX = 44100, 4096, 1024, 128, 30, 11000
FPS = SR / HOP                     # ≈ 43.07 frames/sec

# Architecture of the released checkpoint (the repo's own demo config; the
# class defaults are smaller and will NOT load these weights).
ARCH = dict(attn_len=5, instr=5, ntoken=2, dmodel=256, nhead=8,
            d_hid=1024, nlayers=9, norm_first=True, dropout=.1)

FOLD = os.environ.get("BEAT_TRANSFORMER_FOLD", "0")
WEIGHTS_DIR = REPO_ROOT / ".cache" / "beat-transformer"
WEIGHTS_PATH = WEIGHTS_DIR / f"fold_{FOLD}_trf_param.pt"
WEIGHTS_URL = (
    "https://github.com/zhaojw1998/Beat-Transformer/raw/main/checkpoint/"
    f"fold_{FOLD}_trf_param.pt"
)

# Stems in the order they are fed to the model, and the order upstream's
# Spleeter config emits. Demucs's 4-stem model has no guitar/piano; whichever
# are present are used, and the model reads the count off the input.
STEM_ORDER = ("vocals", "drums", "bass", "other", "guitar", "piano")

# Upstream's DBN decoding bounds. Wider than the 55-215 default would suggest
# for EDM, but left exactly as published — these are part of the reported
# result, not a knob.
MIN_BPM, MAX_BPM = 55.0, 215.0

# ─── Optional imports ───────────────────────────────────────────────────────

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import librosa  # noqa: F401
    _LIBROSA_OK = True
except Exception:
    _LIBROSA_OK = False

try:
    import torch  # noqa: F401
    _TORCH_OK = True
except Exception:
    _TORCH_OK = False

try:
    # Only for decoding activations into beat times; the model itself is
    # pure torch. madmom is already a core dependency (bpm_server).
    import madmom  # noqa: F401
    _MADMOM_OK = True
except Exception:
    _MADMOM_OK = False

_DEPS_OK = _NUMPY_OK and _LIBROSA_OK and _TORCH_OK and _MADMOM_OK

_model = None
_mel_filter = None


def _ensure_weights() -> Path:
    """Fetch the checkpoint on first use. 36 MB, cached under .cache/."""
    if WEIGHTS_PATH.exists() and WEIGHTS_PATH.stat().st_size > 1_000_000:
        return WEIGHTS_PATH
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = WEIGHTS_PATH.with_suffix(".part")
    print(f"[beat-transformer] fetching {WEIGHTS_URL}", file=sys.stderr)
    urllib.request.urlretrieve(WEIGHTS_URL, tmp)
    tmp.replace(WEIGHTS_PATH)
    return WEIGHTS_PATH


def _ensure_model():
    """Build the model and load the checkpoint on first use."""
    global _model, _mel_filter
    if _model is not None:
        return
    import torch
    from vendor.beat_transformer import Demixed_DilatedTransformerModel

    path = _ensure_weights()
    model = Demixed_DilatedTransformerModel(**ARCH)
    state = torch.load(str(path), map_location="cpu", weights_only=False)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    # strict=True on purpose: a silently half-loaded transformer still returns
    # plausible-looking activations, which is the worst possible failure here.
    model.load_state_dict(state)
    model.eval()
    _model = model
    _mel_filter = librosa.filters.mel(
        sr=SR, n_fft=N_FFT, n_mels=N_MELS, fmin=F_MIN, fmax=F_MAX
    ).T


def _stem_spectrograms(slug: str, span: "tuple[float, float] | None"):
    """Log-power mel spectrogram per available stem → (instr, T, 128).

    Raises FileNotFoundError when the song has no stems: this detector reads
    separated sources, and quietly substituting the full mix would turn it
    into a worse duplicate of the trackers that already read the mix.
    """
    _ensure_model()
    offset = span[0] if span else 0.0
    duration = (span[1] - span[0]) if span else None

    channels, used = [], []
    for stem in STEM_ORDER:
        path = stem_audio(slug, stem)
        if path is None:
            continue
        y, _ = librosa.load(str(path), sr=SR, mono=True,
                            offset=offset, duration=duration)
        if len(y) == 0:
            continue
        spec = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP))
        mel = np.dot(spec.T ** 2, _mel_filter)            # (T, n_mels), power
        channels.append(librosa.power_to_db(mel, ref=np.max))
        used.append(stem)

    if not channels:
        raise FileNotFoundError(
            f"no Demucs stems for '{slug}' — Beat Transformer reads separated "
            f"sources. Run the stems daemon on this song first."
        )
    # Stems can differ by a frame after independent STFTs; trim to the shortest.
    width = min(c.shape[0] for c in channels)
    return np.stack([c[:width] for c in channels]), used


def _decode(beat_act, down_act) -> "tuple[list[float], list[float]]":
    """Activations → beat and downbeat times, via madmom's DBNs.

    Upstream's decoding, unchanged. Note the beat activation handed to the
    downbeat DBN is `beat - downbeat` clipped at zero: that processor wants
    two mutually exclusive columns (non-downbeat beat, downbeat), not the two
    overlapping ones the network emits.
    """
    from madmom.features.beats import DBNBeatTrackingProcessor
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor

    beats = DBNBeatTrackingProcessor(
        min_bpm=MIN_BPM, max_bpm=MAX_BPM, fps=FPS)(beat_act)
    combined = DBNDownBeatTrackingProcessor(
        beats_per_bar=[3, 4], min_bpm=MIN_BPM, max_bpm=MAX_BPM, fps=FPS,
    )(np.stack((np.maximum(beat_act - down_act, 0), down_act), axis=-1))
    downbeats = [float(t) for t, pos in combined if int(round(pos)) == 1]
    return [float(b) for b in beats], downbeats


def detect_beat_transformer(slug: str, span=None) -> dict:
    src = "beat-transformer"
    if not _DEPS_OK:
        return {"source": src, "ok": False,
                "error": "numpy / librosa / torch / madmom not installed"}
    t0 = datetime.now().timestamp() * 1000
    try:
        import torch
        x, used = _stem_spectrograms(slug, span)
        with torch.no_grad():
            pred, _ = _model(torch.from_numpy(x).unsqueeze(0).float())
        beat_act = torch.sigmoid(pred[0, :, 0]).numpy()
        down_act = torch.sigmoid(pred[0, :, 1]).numpy()
        beat_times, downbeats = _decode(beat_act, down_act)
        if len(beat_times) < 2:
            return {"source": src, "ok": False, "error": "no beats detected"}

        # A ranged run analysed a window loaded at an offset, so its times
        # count from zero. Shift back into song time before anything reads
        # them — the fit below included.
        if span:
            beat_times = [t + span[0] for t in beat_times]
            downbeats = [t + span[0] for t in downbeats]

        median_ibi = float(np.median(np.diff(beat_times)))
        return {
            "source":     src,
            "ok":         True,
            "bpm":        float(60.0 / median_ibi) if median_ibi > 0 else None,
            "beat_times": beat_times,
            "downbeats":  downbeats,
            "stems":      used,
            "ms":         time_ms(t0),
        }
    except FileNotFoundError as e:
        return {"source": src, "ok": False, "error": str(e)}
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def _add_segments(result: dict, duration: "float | None") -> dict:
    """Fit grid segments onto a successful detection, in song time."""
    if not result.get("ok"):
        return result
    segments = fit_segments(result.get("beat_times", []),
                            result.get("downbeats", []), duration=duration)
    result["segments"] = segments
    result["summary"] = summarize(segments)
    result["meter"] = segments[0]["time_signature"] if segments else None
    return result


def detect(slug: str, force: bool = False, span=None) -> dict:
    cache_path = CACHE_DIR / f"{slug}.json"
    if span is None:
        hit = cached_result(cache_path, force)
        if hit is not None:
            return hit

    audio_path = find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")

    result = detect_beat_transformer(slug, span)

    if span:
        _add_segments(result, float(span[1] - span[0]))
        return {
            "slug":        slug,
            "audio_file":  audio_path.name,
            "duration":    float(span[1] - span[0]),
            "range":       {"start": span[0], "end": span[1]},
            "result":      result,
            "computed_at": now_iso(),
        }

    duration = 0.0
    try:
        duration = float(librosa.get_duration(path=str(audio_path)))
    except Exception:
        pass
    _add_segments(result, duration or None)

    payload = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "duration":    duration,
        "result":      result,
        "computed_at": now_iso(),
    }
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass
    return payload


# ─── HTTP handler ───────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/api/beat-transformer/health":
            self._send(200, {
                "ok":        _DEPS_OK,
                "numpyOk":   _NUMPY_OK,
                "librosaOk": _LIBROSA_OK,
                "torchOk":   _TORCH_OK,
                "madmomOk":  _MADMOM_OK,
                "weightsReady": WEIGHTS_PATH.exists(),
                "fold":      FOLD,
                # Surfaced so the UI can explain an empty result: this is the
                # one detector that needs stems, not just audio.
                "requiresStems": True,
            })
            return

        if path.startswith("/api/beat-transformer/detect/"):
            slug = path[len("/api/beat-transformer/detect/"):]
            cache_path = CACHE_DIR / f"{slug}.json"
            self._send(200, json.loads(cache_path.read_text())
                       if cache_path.exists() else None)
            return

        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"invalid JSON: {e}"})
            return

        if path == "/api/beat-transformer/detect":
            slug = str(body.get("slug", "")).strip()
            if not slug:
                self._send(400, {"error": "slug is required"}); return
            try:
                span = parse_range(body)
            except ValueError as e:
                self._send(400, {"error": str(e)}); return
            try:
                self._send(200, detect(slug, force=bool(body.get("force")), span=span))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return

        if path == "/api/beat-transformer/initialize":
            if not _DEPS_OK:
                self._send(503, {"ok": False, "error": "deps missing"}); return
            try:
                _ensure_model()
                self._send(200, {"ok": True, "algorithm": "beat-transformer"})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"init failed: {type(e).__name__}: {e}"})
            return

        self._send(404, {"error": "not found"})


def main():
    host = os.environ.get("HOST", "localhost")
    print(f"Starting Beat Transformer server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  numpy={_NUMPY_OK} librosa={_LIBROSA_OK} torch={_TORCH_OK} "
          f"madmom={_MADMOM_OK} weights={WEIGHTS_PATH.exists()} fold={FOLD}",
          file=sys.stderr)
    try:
        HTTPServer((host, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
