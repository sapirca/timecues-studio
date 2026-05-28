#!/usr/bin/env python3
"""
Ruptures Analysis Server — all methods from Truong, Oudre & Vayatis (2020).
Port 8003.

Search methods (§5):
  §5.1.1  Dynp     — exact, dynamic programming, fixed n_bkps
  §5.1.2  Pelt     — exact, penalty-based
  §5.2.1  Window   — approximate, sliding window
  §5.2.2  Binseg   — approximate, binary segmentation
  §5.2.3  BottomUp — approximate, bottom-up merging

Cost functions (§4):
  §4.1.1  l2, l1, ar   — parametric (MLE, median, autoregressive)
  §4.1.2  linear        — piecewise linear regression
  §4.1.3  mahal         — Mahalanobis
  §4.2.2  rank          — non-parametric rank-based
  §4.2.3  rbf           — non-parametric kernel (RBF)

Endpoints
---------
  GET  /api/ruptures/health
  GET  /api/ruptures/methods          → list of all 19 method descriptors
  GET  /api/ruptures/songs            → all slugs with per-method cache status
  GET  /api/ruptures/progress         → batch-job progress
  POST /api/ruptures/analyze          → { slug, suffix }  — run one method on one song
  POST /api/ruptures/run-all          → start background batch (idempotent)

Cache
-----
    data/algorithm-outputs/analysis/<slug>/ruptures-<suffix>.json
  (served as static files by Vite once written)

Usage
-----
  pip install ruptures librosa numpy scipy
  python tools/python/ruptures_server.py
"""

import json
import sys
import threading
import time
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")

try:
    import librosa
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False

try:
    import ruptures as rpt
    _RUPTURES_OK = True
except ImportError:
    _RUPTURES_OK = False

PORT = 8003

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import ANALYSIS_DIR, REPO_ROOT, find_audio, list_song_slugs, safe_segment  # noqa: E402

MANIFEST     = ANALYSIS_DIR / "manifest.json"

# ─── Method catalogue ─────────────────────────────────────────────────────────
# Each entry: (search, model, suffix, display, paper_section, method_type)
# suffix becomes the filename: ruptures-{suffix}.json
# method_type: "exact" | "approximate"

ALL_METHODS: list[dict] = [
    # §5.1.1 Dynamic Programming (Opt / Dynp) — exact, fixed n_bkps
    {"search": "Dynp",     "model": "rbf",    "suffix": "dynp-rbf",      "display": "Dynp · rbf",       "section": "§5.1.1", "type": "exact"},
    {"search": "Dynp",     "model": "l2",     "suffix": "dynp-l2",       "display": "Dynp · l2",        "section": "§5.1.1", "type": "exact"},
    {"search": "Dynp",     "model": "l1",     "suffix": "dynp-l1",       "display": "Dynp · l1",        "section": "§5.1.1", "type": "exact"},
    {"search": "Dynp",     "model": "ar",     "suffix": "dynp-ar",       "display": "Dynp · ar",        "section": "§5.1.1", "type": "exact"},
    # §5.1.2 PELT — exact, penalty-based
    {"search": "Pelt",     "model": "rbf",    "suffix": "pelt-rbf",      "display": "PELT · rbf",       "section": "§5.1.2", "type": "exact"},
    {"search": "Pelt",     "model": "l2",     "suffix": "pelt-l2",       "display": "PELT · l2",        "section": "§5.1.2", "type": "exact"},
    {"search": "Pelt",     "model": "l1",     "suffix": "pelt-l1",       "display": "PELT · l1",        "section": "§5.1.2", "type": "exact"},
    {"search": "Pelt",     "model": "ar",     "suffix": "pelt-ar",       "display": "PELT · ar",        "section": "§5.1.2", "type": "exact"},
    {"search": "Pelt",     "model": "rank",   "suffix": "pelt-rank",     "display": "PELT · rank",      "section": "§5.1.2", "type": "exact"},
    # §5.2.1 Window — approximate, sliding window
    {"search": "Window",   "model": "rbf",    "suffix": "window-rbf",    "display": "Window · rbf",     "section": "§5.2.1", "type": "approximate"},
    {"search": "Window",   "model": "l2",     "suffix": "window-l2",     "display": "Window · l2",      "section": "§5.2.1", "type": "approximate"},
    {"search": "Window",   "model": "linear", "suffix": "window-linear", "display": "Window · linear",  "section": "§5.2.1", "type": "approximate"},
    # §5.2.2 Binary Segmentation — approximate, greedy
    {"search": "Binseg",   "model": "rbf",    "suffix": "binseg-rbf",    "display": "BinSeg · rbf",     "section": "§5.2.2", "type": "approximate"},
    {"search": "Binseg",   "model": "l2",     "suffix": "binseg-l2",     "display": "BinSeg · l2",      "section": "§5.2.2", "type": "approximate"},
    {"search": "Binseg",   "model": "l1",     "suffix": "binseg-l1",     "display": "BinSeg · l1",      "section": "§5.2.2", "type": "approximate"},
    {"search": "Binseg",   "model": "ar",     "suffix": "binseg-ar",     "display": "BinSeg · ar",      "section": "§5.2.2", "type": "approximate"},
    {"search": "Binseg",   "model": "rank",   "suffix": "binseg-rank",   "display": "BinSeg · rank",    "section": "§5.2.2", "type": "approximate"},
    # §5.2.3 Bottom-Up — approximate, agglomerative
    {"search": "BottomUp", "model": "l2",     "suffix": "bottomup-l2",   "display": "Bottom-Up · l2",   "section": "§5.2.3", "type": "approximate"},
    {"search": "BottomUp", "model": "rbf",    "suffix": "bottomup-rbf",  "display": "Bottom-Up · rbf",  "section": "§5.2.3", "type": "approximate"},
    # "default" trio — formerly served by the standalone CPD server. PELT's
    # fixed pen=3.0 produces visibly different boundaries from pelt-rbf's BIC
    # penalty (~log n), so it gets its own cache. The other two coincide
    # exactly with binseg-rbf / window-l2 but are kept as separate suffixes
    # for the "CPD" UI grouping (AlgoInspectStage / GlobalEvalStage).
    {"search": "Pelt",     "model": "rbf",    "suffix": "pelt-default",   "display": "PELT · default",   "section": "default", "type": "exact",       "params": {"pen": 3.0}},
    {"search": "Binseg",   "model": "rbf",    "suffix": "binseg-default", "display": "BinSeg · default", "section": "default", "type": "approximate"},
    {"search": "Window",   "model": "l2",     "suffix": "window-default", "display": "Window · default", "section": "default", "type": "approximate"},
]

_SUFFIX_TO_METHOD = {m["suffix"]: m for m in ALL_METHODS}

# ─── Batch state ──────────────────────────────────────────────────────────────

_batch_lock = threading.Lock()
_batch: dict = {
    "running":    False,
    "total":      0,
    "done":       0,
    "errors":     0,
    "current":    "",
    "started_at": None,
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _cors_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    }


def _find_audio(slug: str) -> "Path | None":
    return find_audio(slug)


def _load_manifest() -> list[dict]:
    try:
        return json.loads(MANIFEST.read_text())
    except Exception:
        # Fallback: scan disk (user dir + shipped defaults).
        return [{"id": s, "name": s} for s in list_song_slugs()]


def _auto_n_bkps(duration: float) -> int:
    """Heuristic: ~1 section per 20 s, clamped to [4, 20]."""
    return int(max(4, min(20, duration / 20)))


# ─── Feature extraction ────────────────────────────────────────────────────────

def extract_features(audio_path: "Path") -> "tuple[np.ndarray, np.ndarray, float]":
    """
    Load audio and return (features, beat_times, duration).

    features   : float32, shape (n_beats, 39)  — MFCC(20) + Chroma(12) + SpectralContrast(7), z-scored
    beat_times : float64, shape (n_beats,)      — timestamps in seconds
    duration   : float
    """
    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))
    hop = 512

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop, trim=False)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)

    if len(beat_frames) < 4:
        beat_times  = np.arange(0, duration, 0.5)
        beat_frames = librosa.time_to_frames(beat_times, sr=sr, hop_length=hop)

    S       = np.abs(librosa.stft(y, hop_length=hop))
    mfcc    = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20, hop_length=hop)
    chroma  = librosa.feature.chroma_cens(y=y, sr=sr, hop_length=hop)
    contrast= librosa.feature.spectral_contrast(S=S, sr=sr)

    feat = np.vstack([mfcc, chroma, contrast])                        # (39, T)
    feat_sync = librosa.util.sync(feat, beat_frames, aggregate=np.median).T  # (n_beats, 39)
    feat_sync = feat_sync.astype(np.float32)
    feat_sync = np.nan_to_num(feat_sync, nan=0.0, posinf=0.0, neginf=0.0)

    std = feat_sync.std(axis=0)
    std[std < 1e-8] = 1.0
    feat_sync = (feat_sync - feat_sync.mean(axis=0)) / std

    return feat_sync.astype(np.float32), beat_times.astype(np.float64), duration


# ─── CPD runners ──────────────────────────────────────────────────────────────

def _pelt_penalty(model: str, n_features: int, n_samples: int) -> float:
    """
    BIC-inspired penalty: scales with log(n) so segment count stays bounded.

    RBF kernel costs live in [0, 1] per sample — penalty is log(n).
    Rank costs scale with n_features — penalty is n_features * log(n).
    L2/L1/AR costs scale with n_features (variance units) — same.
    """
    log_n = float(np.log(max(n_samples, 2)))
    if model == "rbf":
        return log_n                          # ~4–7 for typical track lengths
    return float(n_features) * log_n         # ~250–300 for 39-dim, 640 beats


def _window_width(model: str, n_features: int) -> int:
    """
    Window search needs enough samples per half-window for the cost to be defined.
    The 'linear' model fits a regression — requires width > 2 * n_features.
    """
    if model == "linear":
        return max(n_features * 2 + 4, 20)   # ~82 for 39-dim features
    return 10                                  # fast default for l2 / rbf


def run_ruptures(
    features: np.ndarray,
    duration: float,
    search: str,
    model: str,
    params: "dict | None" = None,
) -> list[int]:
    """
    Run one ruptures search+model combo.
    `params` overrides defaults — e.g. {"pen": 3.0} for the CPD-style PELT.
    Returns list of breakpoint beat-frame indices (sentinel excluded).
    """
    params    = params or {}
    n_bkps    = _auto_n_bkps(duration)
    n_samples = features.shape[0]
    n_features= features.shape[1]

    if search == "Pelt":
        pen  = float(params["pen"]) if "pen" in params else _pelt_penalty(model, n_features, n_samples)
        algo = rpt.Pelt(model=model, min_size=2, jump=1).fit(features)
        bkps = algo.predict(pen=pen)

    elif search == "Dynp":
        algo = rpt.Dynp(model=model, min_size=2, jump=5).fit(features)
        bkps = algo.predict(n_bkps=n_bkps)

    elif search == "Binseg":
        algo = rpt.Binseg(model=model, min_size=2, jump=1).fit(features)
        bkps = algo.predict(n_bkps=n_bkps)

    elif search == "Window":
        width = _window_width(model, n_features)
        algo  = rpt.Window(model=model, width=width).fit(features)
        bkps  = algo.predict(n_bkps=n_bkps)

    elif search == "BottomUp":
        algo = rpt.BottomUp(model=model, min_size=2, jump=1).fit(features)
        bkps = algo.predict(n_bkps=n_bkps)

    else:
        raise ValueError(f"Unknown search method: {search!r}")

    return bkps[:-1]  # drop trailing n_samples sentinel


# ─── Section classification ────────────────────────────────────────────────────

def classify_sections(
    audio_path: "Path",
    boundaries: np.ndarray,
    duration: float,
) -> list[dict]:
    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    boundaries = np.clip(np.sort(np.unique(boundaries)), 0, duration)

    energies: list[float] = []
    centroids: list[float] = []
    for i in range(len(boundaries) - 1):
        t0, t1 = boundaries[i], boundaries[i + 1]
        seg = y[int(t0 * sr) : int(t1 * sr)]
        if len(seg) < 512:
            energies.append(0.0); centroids.append(0.0); continue
        energies.append(float(np.sqrt(np.mean(seg ** 2))))
        centroids.append(float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=sr))))

    n = len(energies)
    if n == 0:
        return []

    e = np.array(energies);  e_max = e.max() or 1.0;  e_n = e / e_max
    c = np.array(centroids); c_max = c.max() or 1.0;  c_n = c / c_max

    labels = ["verse"] * n
    is_drop = e_n > 0.65
    for i in range(n):
        if is_drop[i]: labels[i] = "drop"
    for i in range(1, n):
        if labels[i] == "drop" and labels[i-1] != "drop" and (boundaries[i] - boundaries[i-1]) >= 4:
            labels[i-1] = "buildup"
    for i in range(n):
        if labels[i] == "verse" and e_n[i] < 0.35 and (i+1 >= n or labels[i+1] != "drop"):
            labels[i] = "breakdown"
    for i in range(min(3, n)):
        if labels[i] == "verse" and e_n[i] < 0.55: labels[i] = "intro"
        else: break
    for i in range(n-1, max(n-4, -1), -1):
        if labels[i] == "verse" and e_n[i] < 0.55: labels[i] = "outro"
        else: break

    DISPLAY = {"intro":"Intro","verse":"Verse","buildup":"Buildup","drop":"Drop","breakdown":"Breakdown","outro":"Outro"}
    return [
        {
            "time":     float(round(boundaries[i], 3)),
            "endTime":  float(round(boundaries[i+1], 3)),
            "type":     labels[i],
            "label":    DISPLAY.get(labels[i], labels[i].capitalize()),
            "energy":   float(round(e_n[i], 4)),
            "centroid": float(round(c_n[i], 4)),
        }
        for i in range(n)
    ]


# ─── Full pipeline ─────────────────────────────────────────────────────────────

def analyze(
    slug: str,
    suffix: str,
    audio_path: "Path | None" = None,
    features_cache: "tuple | None" = None,
    force: bool = False,
) -> dict:
    """
    Run one method on one song. Checks cache first.
    features_cache: optional pre-computed (features, beat_times, duration) tuple.
    Returns the result dict.
    """
    if not _LIBROSA_OK:
        raise RuntimeError("librosa not installed")
    if not _RUPTURES_OK:
        raise RuntimeError("ruptures not installed")

    method = _SUFFIX_TO_METHOD.get(suffix)
    if method is None:
        raise ValueError(f"Unknown suffix: {suffix!r}")

    cache_dir  = ANALYSIS_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"ruptures-{suffix}.json"

    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text())

    if audio_path is None:
        audio_path = _find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"No audio file found for slug: {slug!r}")

    t0 = time.time()

    if features_cache is not None:
        features, beat_times, duration = features_cache
    else:
        features, beat_times, duration = extract_features(audio_path)

    bkp_frames = run_ruptures(features, duration, method["search"], method["model"], method.get("params"))

    boundary_times: list[float] = [0.0]
    for bf in sorted(set(bkp_frames)):
        if 0 < bf < len(beat_times):
            boundary_times.append(float(beat_times[bf]))
    boundary_times.append(float(duration))
    boundaries = np.array(sorted(set(boundary_times)))

    sections = classify_sections(audio_path, boundaries, duration)
    elapsed  = time.time() - t0

    result = {
        "algorithm":     f"ruptures-{suffix}",
        "algoName":      method["display"],
        "search":        method["search"],
        "model":         method["model"],
        "suffix":        suffix,
        "paperSection":  method["section"],
        "methodType":    method["type"],
        "audioFile":     audio_path.name,
        "duration":      float(round(duration, 3)),
        "sections":      sections,
        "rawBoundaries": [float(round(t, 3)) for t in boundaries],
        "computedAt":    int(time.time()),
        "elapsedSec":    float(round(elapsed, 2)),
    }

    cache_path.write_text(json.dumps(result, indent=2))
    print(f"[ruptures] {slug}/{suffix}: {len(sections)} sections in {elapsed:.1f}s", file=sys.stderr)
    return result


# ─── Batch runner ──────────────────────────────────────────────────────────────

def _batch_thread(songs: list[dict]) -> None:
    total = len(songs) * len(ALL_METHODS)
    with _batch_lock:
        _batch.update({"running": True, "total": total, "done": 0, "errors": 0,
                        "current": "", "started_at": time.time()})

    for song in songs:
        slug = song["id"]
        audio_path = _find_audio(slug)
        if audio_path is None:
            with _batch_lock:
                _batch["errors"] += len(ALL_METHODS)
                _batch["done"]   += len(ALL_METHODS)
            continue

        # Extract features once per song, reuse for all methods
        try:
            feat_cache = extract_features(audio_path)
        except Exception as e:
            print(f"[ruptures] Feature extraction failed for {slug}: {e}", file=sys.stderr)
            with _batch_lock:
                _batch["errors"] += len(ALL_METHODS)
                _batch["done"]   += len(ALL_METHODS)
            continue

        for method in ALL_METHODS:
            suffix = method["suffix"]
            with _batch_lock:
                _batch["current"] = f"{slug} / {suffix}"

            cache_path = ANALYSIS_DIR / slug / f"ruptures-{suffix}.json"
            if cache_path.exists():
                with _batch_lock:
                    _batch["done"] += 1
                continue

            try:
                analyze(slug, suffix, audio_path=audio_path, features_cache=feat_cache)
                with _batch_lock:
                    _batch["done"] += 1
            except Exception as e:
                print(f"[ruptures] {slug}/{suffix} failed: {e}", file=sys.stderr)
                with _batch_lock:
                    _batch["errors"] += 1
                    _batch["done"]   += 1

    with _batch_lock:
        _batch["running"]  = False
        _batch["current"]  = ""


def start_batch() -> bool:
    """Start background batch. Returns False if already running."""
    with _batch_lock:
        if _batch["running"]:
            return False

    songs = _load_manifest()
    t = threading.Thread(target=_batch_thread, args=(songs,), daemon=True)
    t.start()
    return True


# ─── Song status helper ────────────────────────────────────────────────────────

def _song_status(slug: str) -> dict[str, str]:
    """Return per-suffix cache status for one slug."""
    status: dict[str, str] = {}
    for m in ALL_METHODS:
        p = ANALYSIS_DIR / slug / f"ruptures-{m['suffix']}.json"
        status[m["suffix"]] = "cached" if p.exists() else "missing"
    return status


# ─── HTTP handler ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if int(code) >= 400:
            super().log_message(fmt, *args)

    def _send_json(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/api/ruptures/health":
            self._send_json(200, {
                "ok":         _LIBROSA_OK and _RUPTURES_OK,
                "librosaOk":  _LIBROSA_OK,
                "rupturesOk": _RUPTURES_OK,
                "version":    "1.0.0",
                "methods":    len(ALL_METHODS),
            })

        elif path == "/api/ruptures/methods":
            self._send_json(200, ALL_METHODS)

        elif path == "/api/ruptures/songs":
            songs = _load_manifest()
            result = []
            for s in songs:
                slug = s.get("id", "")
                result.append({
                    "slug":    slug,
                    "name":    s.get("name", slug),
                    "methods": _song_status(slug),
                })
            self._send_json(200, result)

        elif path == "/api/ruptures/progress":
            with _batch_lock:
                self._send_json(200, dict(_batch))

        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path   = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send_json(400, {"error": f"invalid JSON: {e}"}); return

        if path == "/api/ruptures/run-all":
            started = start_batch()
            with _batch_lock:
                self._send_json(200, {"started": started, "progress": dict(_batch)})

        elif path == "/api/ruptures/analyze":
            slug   = safe_segment(str(body.get("slug", "")).strip())
            suffix = str(body.get("suffix", "")).strip()
            force  = bool(body.get("force", False))

            if not slug:
                self._send_json(400, {"error": "invalid or missing slug"}); return
            if suffix not in _SUFFIX_TO_METHOD:
                self._send_json(400, {"error": f"unknown suffix, valid: {list(_SUFFIX_TO_METHOD)}"}); return

            try:
                result = analyze(slug, suffix, force=force)
                self._send_json(200, result)
            except FileNotFoundError as e:
                self._send_json(404, {"error": str(e)})
            except RuntimeError as e:
                self._send_json(503, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": f"Analysis failed: {e}"})

        else:
            self._send_json(404, {"error": "not found"})


def main():
    if not _LIBROSA_OK:
        print("WARNING: librosa not installed — pip install librosa", file=sys.stderr)
    if not _RUPTURES_OK:
        print("WARNING: ruptures not installed — pip install ruptures", file=sys.stderr)

    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting Ruptures server on http://{host}:{PORT}", file=sys.stderr)
    print(f"Methods: {len(ALL_METHODS)} ({sum(1 for m in ALL_METHODS if m['type']=='exact')} exact, "
          f"{sum(1 for m in ALL_METHODS if m['type']=='approximate')} approximate)", file=sys.stderr)

    server = HTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
