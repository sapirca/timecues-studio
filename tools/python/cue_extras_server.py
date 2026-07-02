#!/usr/bin/env python3
"""
Pure-librosa CUE-family extras server. Three lightweight detectors that
share one sidecar to keep the docker image count manageable:

  librosa-key       Krumhansl-Schmuckler key correlation against the 24
                    major/minor templates. Emits a single global-key cue
                    at t=0 + per-segment cues at every key change.
  autochord-chords  Chroma-template chord recognition via the `autochord`
                    pip package. One cue per chord transition, labelled
                    with the chord symbol (e.g. "Am", "G/B", "C:maj7").
  librosa-onsets    librosa.onset.onset_detect. One cue per transient
                    onset (kick hits, FX triggers, anything sharp).

All three are pure DSP-ish — no pretrained neural-net weights, no GPU,
no special install. autochord is the only non-librosa pip dep here.

Endpoints
---------
  GET  /api/cue-extras/health              → server up + per-detector status
  GET  /api/cue-extras/algorithms          → [{ id, name, available, description }]
  GET  /api/cue-extras/detect/:slug/:algo  → cached result, or null
  POST /api/cue-extras/detect              { slug, algo, force? }
  POST /api/cue-extras/initialize          { algo } — no-op (warms imports)

Output schema (one shape for all three — every detector returns cues
that the boundary-style inspector can render as points-in-time)
-------------------------------------------------------------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,
    "duration":    float,
    "cues": [
      {
        "time":       float,       # seconds
        "label":      str,         # detector-specific
        "confidence": float | None # 0..1 when the detector exposes one
      }
    ],
    "key":         str | null,     # only set by librosa-key
    "ms":          int,
    "computed_at": str
  }

Cache
-----
  data/algorithm-outputs/cue-extras/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# autochord ships a legacy Keras-2 SavedModel that Keras 3 (bundled with
# TensorFlow 2.16+) refuses to load. The standard escape hatch is to keep
# tf-keras installed and flip this env var BEFORE the first `import
# tensorflow` so tf.keras resolves to the legacy package. Must be set
# before the `import autochord` below, which transitively imports TF.
#
# Only set it when tf_keras is actually importable: the Docker image pins
# tensorflow<2.16 (native Keras 2, no separate tf_keras), and forcing
# TF_USE_LEGACY_KERAS=1 there makes TF demand a tf_keras package that isn't
# installed — which silently breaks `import autochord`. Gate on availability
# so the env var helps the TF≥2.16 (bare-metal) case without sabotaging the
# pinned-TF Docker case.
try:
    import tf_keras  # noqa: F401
    os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")
except ImportError:
    pass

warnings.filterwarnings("ignore")

PORT = 8014

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (  # noqa: E402
    find_audio, stem_audio, cache_name, CUE_EXTRAS_OUTPUTS_DIR as CACHE_DIR,
)

CACHE_DIR.mkdir(parents=True, exist_ok=True)

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import librosa
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False

try:
    from energy_gate import gate_point_events
    _ENERGY_GATE_OK = True
except Exception:
    _ENERGY_GATE_OK = False

try:
    import autochord  # noqa: F401
    _AUTOCHORD_OK = True
except Exception:
    _AUTOCHORD_OK = False


def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(algo: str, msg: str) -> dict:
    return {"algorithm": algo, "ok": False, "error": msg, "cues": []}


# ─── Detector: librosa Krumhansl-Schmuckler key ─────────────────────────────

# Krumhansl-Schmuckler probe-tone profiles. Each is the relative weight of
# the 12 pitch classes for a given key — correlating the song's chroma
# distribution against rotated versions of these picks the key.
_KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                      2.52, 5.19, 2.39, 3.66, 2.29, 2.88]) if _NUMPY_OK else None
_KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                      2.54, 4.75, 3.98, 2.69, 3.34, 3.17]) if _NUMPY_OK else None
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _ks_key_from_chroma(chroma_col: "np.ndarray") -> tuple[str, float]:
    """Return (key_name, correlation_score) for a single chroma vector.
    Iterates all 24 rotations (12 major + 12 minor)."""
    best_score = -2.0
    best_label = "C major"
    chroma_z = chroma_col - chroma_col.mean()
    chroma_n = np.linalg.norm(chroma_z) or 1e-9
    for i in range(12):
        for mode_name, profile in (("major", _KS_MAJOR), ("minor", _KS_MINOR)):
            rotated = np.roll(profile, i)
            rot_z = rotated - rotated.mean()
            rot_n = np.linalg.norm(rot_z) or 1e-9
            score = float(np.dot(chroma_z, rot_z) / (chroma_n * rot_n))
            if score > best_score:
                best_score = score
                best_label = f"{_NOTE_NAMES[i]} {mode_name}"
    return best_label, best_score


def detect_librosa_key(audio_path: Path) -> dict:
    algo = "librosa-key"
    if not (_LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "librosa / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        # CENS (chroma energy normalized) is the recommended chroma flavour
        # for key detection — robust to dynamics and timbre.
        chroma = librosa.feature.chroma_cens(y=y, sr=sr)
        # Global key: average chroma across the whole track.
        global_chroma = chroma.mean(axis=1)
        global_key, global_score = _ks_key_from_chroma(global_chroma)
        duration = float(len(y) / sr)

        # Per-segment key change detection: walk a 10 s sliding window with
        # 5 s hop and emit a cue whenever the local key differs from the
        # previous window's. Coarse — caller can re-derive a finer grid
        # from the global cue itself if they want.
        hop_len = int(5.0 * (sr / 512))  # librosa chroma hop is 512 samples
        win_len = int(10.0 * (sr / 512))
        cues: list[dict] = []
        # Always emit a global-key cue at t=0 so downstream consumers see
        # at least one entry per song.
        cues.append({
            "time":       0.0,
            "label":      global_key,
            "confidence": max(0.0, min(1.0, global_score)),
        })
        prev_key = global_key
        if chroma.shape[1] >= win_len:
            for start in range(0, chroma.shape[1] - win_len + 1, hop_len):
                local_chroma = chroma[:, start : start + win_len].mean(axis=1)
                local_key, local_score = _ks_key_from_chroma(local_chroma)
                if local_key != prev_key and local_score > 0.5:
                    cue_time = float(start * 512 / sr)
                    cues.append({
                        "time":       cue_time,
                        "label":      local_key,
                        "confidence": max(0.0, min(1.0, local_score)),
                    })
                    prev_key = local_key

        return {
            "algorithm": algo,
            "ok":        True,
            "cues":      cues,
            "duration":  duration,
            "key":       global_key,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Detector: autochord chord recognition ──────────────────────────────────

def detect_autochord(audio_path: Path) -> dict:
    algo = "autochord-chords"
    if not _AUTOCHORD_OK:
        return _err(algo, "autochord not installed")
    if not _LIBROSA_OK:
        return _err(algo, "librosa not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        # autochord.recognize() returns a list of (start, end, chord_label).
        # It re-decodes the audio internally; we don't need to pre-load.
        chord_segments = autochord.recognize(str(audio_path))  # type: ignore[union-attr]
        cues: list[dict] = []
        prev = None
        for seg in chord_segments:
            start, _end, label = seg
            label = str(label).strip()
            # Skip silence / no-chord markers but keep them as a transition
            # signal so the cue list reflects "chord goes away here" too.
            if label == prev:
                continue
            cues.append({
                "time":       float(start),
                "label":      label or "N",
                "confidence": None,
            })
            prev = label

        # Duration: cheaper to derive from the last chord segment than to
        # re-decode the file.
        if chord_segments:
            duration = float(chord_segments[-1][1])
        else:
            duration = 0.0
        return {
            "algorithm": algo,
            "ok":        True,
            "cues":      cues,
            "duration":  duration,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Detector: librosa onset detector ───────────────────────────────────────

def detect_librosa_onsets(audio_path: Path) -> dict:
    algo = "librosa-onsets"
    if not (_LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "librosa / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="frames")
        onset_times = librosa.frames_to_time(onset_frames, sr=sr)
        # Strength curve (1 sample per onset frame) so we can attach a
        # confidence in [0, 1] proportional to peak prominence.
        env = librosa.onset.onset_strength(y=y, sr=sr)
        if len(env) > 0:
            env_max = float(env.max() or 1.0)
        else:
            env_max = 1.0
        cues: list[dict] = []
        for t, f in zip(onset_times, onset_frames):
            strength = float(env[min(int(f), len(env) - 1)] / env_max) if len(env) else None
            cues.append({
                "time":       float(t),
                "label":      "onset",
                "confidence": max(0.0, min(1.0, strength)) if strength is not None else None,
            })
        # Onset strength is normalized to the stem's own peak, so noise-floor
        # bleed in a near-silent stem peaks at confidence ~1.0. Drop onsets in
        # regions that are inaudible in absolute terms.
        gated_out = 0
        if _ENERGY_GATE_OK:
            cues, gated_out = gate_point_events(cues, y, sr)
        return {
            "algorithm": algo,
            "ok":        True,
            "cues":      cues,
            "duration":  float(len(y) / sr),
            "gated_out": gated_out,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


ALGORITHMS = {
    "librosa-key": {
        "name":        "librosa key (KS templates)",
        "description": "Krumhansl-Schmuckler key correlation. Global + per-segment key cues. Pure DSP.",
        "detect":      detect_librosa_key,
        "available":   lambda: _LIBROSA_OK and _NUMPY_OK,
    },
    "autochord-chords": {
        "name":        "autochord (chord recognition)",
        "description": "Chroma-template chord recognition. One cue per chord change. Pure DSP-ish (autochord package).",
        "detect":      detect_autochord,
        "available":   lambda: _AUTOCHORD_OK and _LIBROSA_OK,
    },
    "librosa-onsets": {
        "name":        "librosa onsets",
        "description": "Spectral-flux onset detection. One cue per transient. Pure DSP.",
        "detect":      detect_librosa_onsets,
        "available":   lambda: _LIBROSA_OK and _NUMPY_OK,
    },
}


def detect_one(slug: str, algo: str, stem: str = "mix", force: bool = False) -> dict:
    if algo not in ALGORITHMS:
        raise ValueError(f"unknown algorithm: {algo}")
    cache_dir = CACHE_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Per-stem runs cache under "<algo>__<stem>.json"; the full mix keeps the
    # bare "<algo>.json" name so existing caches stay valid.
    cache_path = cache_dir / f"{cache_name(algo, stem)}.json"
    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text())
    if stem and stem != "mix":
        audio_path = stem_audio(slug, stem)
        if audio_path is None:
            raise FileNotFoundError(f"no cached '{stem}' stem for slug: {slug}")
    else:
        audio_path = find_audio(slug)
        if audio_path is None:
            raise FileNotFoundError(f"audio not found for slug: {slug}")
    result = ALGORITHMS[algo]["detect"](audio_path)
    payload: dict = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "algorithm":   algo,
        "stem":        stem or "mix",
        "duration":    result.get("duration", 0.0),
        "cues":        result.get("cues", []),
        "gated_out":   result.get("gated_out", 0),
        "ok":          result.get("ok", False),
        "error":       result.get("error"),
        "ms":          result.get("ms", 0),
        "computed_at": _now_iso(),
    }
    if "key" in result:
        payload["key"] = result["key"]
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass
    return payload


def _cors():
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/cue-extras/health":
            self._send(200, {
                "ok":         _LIBROSA_OK and _NUMPY_OK,
                "librosaOk":  _LIBROSA_OK,
                "numpyOk":    _NUMPY_OK,
                "autochordOk": _AUTOCHORD_OK,
            })
            return
        if path == "/api/cue-extras/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/cue-extras/detect/"):
            tail = path[len("/api/cue-extras/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/cue-extras/detect/<slug>/<algo>"})
                return
            slug, algo = tail
            cache_path = CACHE_DIR / slug / f"{algo}.json"
            self._send(200, json.loads(cache_path.read_text()) if cache_path.exists() else None)
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
        if path == "/api/cue-extras/detect":
            slug = str(body.get("slug", "")).strip()
            algo = str(body.get("algo", "")).strip()
            stem = str(body.get("stem", "mix")).strip() or "mix"
            force = bool(body.get("force", False))
            if not slug or not algo:
                self._send(400, {"error": "slug and algo are required"})
                return
            try:
                self._send(200, detect_one(slug, algo, stem=stem, force=force))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return
        if path == "/api/cue-extras/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            self._send(200, {"ok": ALGORITHMS[algo]["available"](), "algorithm": algo})
            return
        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting CUE-extras server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  librosa={_LIBROSA_OK}  numpy={_NUMPY_OK}  autochord={_AUTOCHORD_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
