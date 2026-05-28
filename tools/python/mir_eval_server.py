#!/usr/bin/env python3
"""
MIR Evaluation API Server
Uses the real `mir_eval` library for industry-standard metrics.

Endpoints
---------
POST /api/mir-eval
    Evaluate one or more algorithm outputs against a reference annotation
    using mir_eval boundary-detection and segment-clustering metrics.

POST /api/mir-eval/pairs
    Lightweight batched boundary P/R/F evaluator. Takes a list of
    independent (refTimes, estTimes, tolerance) pairs and returns per-id
    boundary precision/recall/F-measure via mir_eval.onset.f_measure.
    Body: { pairs: [{ id, refTimes, estTimes, tolerance? }, ...] }

POST /api/mir-eval/cpd
    Evaluate using CPD-focused metrics (ruptures + sklearn):
    tolerance-based P/R/F1, Hausdorff distance, MAE, Rand Index, ARI, NMI.
    Body: { tolerance, fps, trackDuration, reference, algorithms }

POST /api/mir-eval/batch
    Aggregate POST /api/mir-eval across all reviewed manual annotations on disk.

GET /api/mir-eval/health
    Returns {"ok": true, "rupturesOk": bool, "sklearnOk": bool, ...}

Usage
-----
    pip install mir_eval numpy ruptures scikit-learn
    python tools/python/mir_eval_server.py
    # → http://localhost:8001

The Vite dev server proxies /api/mir-eval → http://localhost:8001
so the browser never needs to know the port.
"""

import json
import sys
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import mir_eval
import mir_eval.onset
import mir_eval.segment
import numpy as np

try:
    import ruptures.metrics as rpt_metrics
    _RUPTURES_OK = True
except ImportError:
    _RUPTURES_OK = False

try:
    from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score
    _SKLEARN_OK = True
except ImportError:
    _SKLEARN_OK = False

PORT = 8001

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (  # noqa: E402
    ANALYSIS_DIR,
    REPO_ROOT,
    MANUAL_ANNOTATIONS_DIR as ANNOTATIONS_DIR,
    AUTO_GUESS_ANNOTATIONS_DIR as AUTO_GUESS_DIR,
)

# Multi-annotator storage: annotations live at `<dir>/<annotator_id>/<slug>.json`.


def _resolve_ann_file(base_dir: Path, annotator_id: str, slug: str) -> Path | None:
    """Find the annotation file for (base_dir, annotator_id, slug), or None."""
    own = base_dir / annotator_id / f"{slug}.json"
    return own if own.exists() else None


def _list_own_slugs(base_dir: Path, annotator_id: str) -> list[str]:
    """Return every slug owned by `annotator_id`."""
    own_dir = base_dir / annotator_id
    if not own_dir.exists():
        return []
    return sorted(f.stem for f in own_dir.glob("*.json"))

ALGO_FILES = {
    "allin1":       "allin1.json",
    "allin1-fold0": "allin1-fold0.json",
    "allin1-fold1": "allin1-fold1.json",
    "allin1-fold2": "allin1-fold2.json",
    "allin1-fold3": "allin1-fold3.json",
    "allin1-fold4": "allin1-fold4.json",
    "allin1-fold5": "allin1-fold5.json",
    "allin1-fold6": "allin1-fold6.json",
    "allin1-fold7": "allin1-fold7.json",
    "msaf-sf":      "sf.json",
    "msaf-foote":   "foote.json",
    "msaf-cnmf":    "cnmf.json",
    "msaf-olda":    "olda.json",
    "ruptures-pelt-default":   "ruptures-pelt-default.json",
    "ruptures-binseg-default": "ruptures-binseg-default.json",
    "ruptures-window-default": "ruptures-window-default.json",
}

# ─── helpers ──────────────────────────────────────────────────────────────────

def _cors_headers():
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    }


def _segs_to_intervals_labels(segments):
    """Convert [{time, endTime, label}] → (np.ndarray Nx2, list[str])."""
    intervals = np.array([[s["time"], s["endTime"]] for s in segments], dtype=float)
    labels = [s["label"] for s in segments]
    return intervals, labels


def _fix_intervals(intervals: np.ndarray, track_duration: float) -> np.ndarray:
    """
    Ensure intervals are non-overlapping, sorted, and cover [0, track_duration].
    mir_eval.segment validators require contiguous intervals.
    """
    if len(intervals) == 0:
        return np.array([[0.0, track_duration]])

    intervals = intervals.copy()
    intervals = intervals[intervals[:, 0].argsort()]          # sort by start

    # clamp to [0, track_duration]
    intervals[:, 0] = np.clip(intervals[:, 0], 0, track_duration)
    intervals[:, 1] = np.clip(intervals[:, 1], 0, track_duration)

    # force contiguous: set each end = next start
    for i in range(len(intervals) - 1):
        intervals[i, 1] = intervals[i + 1, 0]
    intervals[-1, 1] = track_duration

    # drop zero-length
    valid = intervals[:, 1] > intervals[:, 0]
    intervals = intervals[valid]

    if len(intervals) == 0:
        return np.array([[0.0, track_duration]])

    # prepend [0, first_start] if there's a gap at the beginning
    if intervals[0, 0] > 1e-6:
        intervals = np.vstack([[0.0, intervals[0, 0]], intervals])

    return intervals


# ─── core evaluation ──────────────────────────────────────────────────────────

def evaluate_one(ref_segs, est_segs, tolerance: float, track_duration: float) -> dict:
    """
    Run all mir_eval metrics for one (ref, est) pair.

    Returns a flat dict ready for JSON serialisation.
    """
    result = {}

    ref_times = np.array([s["time"] for s in ref_segs], dtype=float)
    est_times = np.array([s["time"] for s in est_segs], dtype=float)

    ref_intervals_raw, ref_labels_raw = _segs_to_intervals_labels(ref_segs)
    est_intervals_raw, est_labels_raw = _segs_to_intervals_labels(est_segs)

    ref_intervals = _fix_intervals(ref_intervals_raw, track_duration)
    est_intervals = _fix_intervals(est_intervals_raw, track_duration)

    # Pad labels if fix_intervals added a leading [0, first] interval
    def _pad_labels(labels, intervals_raw, intervals_fixed):
        if len(intervals_fixed) > len(labels):
            return ["__pad__"] * (len(intervals_fixed) - len(labels)) + list(labels)
        return list(labels)

    ref_labels = _pad_labels(ref_labels_raw, ref_intervals_raw, ref_intervals)
    est_labels = _pad_labels(est_labels_raw, est_intervals_raw, est_intervals)

    # ── 1. Boundary Detection — mir_eval.segment.detection ───────────────────
    # trim=True drops the [0, track_duration] silence-padding anchors that
    # _fix_intervals adds, so scoring is on user-marked boundaries only. This
    # matches the convention reported by SALAMI / MIREX papers.
    try:
        p, r, f = mir_eval.segment.detection(
            ref_intervals, est_intervals, window=tolerance, trim=True,
        )
        result["boundaryPrecision"] = float(p)
        result["boundaryRecall"]    = float(r)
        result["boundaryFmeasure"]  = float(f)
    except Exception as e:
        result["boundaryError"] = str(e)

    # ── 2. Boundary Deviation — mir_eval.segment.deviation ───────────────────
    # Returns (r_to_e, e_to_r): median deviation in each direction.
    # Also compute per-boundary error arrays for the UI detail view.
    try:
        r_to_e, e_to_r = mir_eval.segment.deviation(ref_intervals, est_intervals)
        result["medianT2E"] = float(r_to_e)
        result["medianE2T"] = float(e_to_r)
    except Exception as e:
        result["deviationError"] = str(e)
        result["medianT2E"] = 0.0
        result["medianE2T"] = 0.0

    # Per-boundary error arrays (for the chip display in the UI)
    ref_times_all = np.array([s["time"] for s in ref_segs], dtype=float)
    est_times_all = np.array([s["time"] for s in est_segs], dtype=float)
    if len(ref_times_all) > 0 and len(est_times_all) > 0:
        result["t2eErrors"] = [float(np.min(np.abs(r - est_times_all))) for r in ref_times_all]
        result["e2tErrors"] = [float(np.min(np.abs(e - ref_times_all))) for e in est_times_all]
    else:
        result["t2eErrors"] = []
        result["e2tErrors"] = []

    # ── 3. Pairwise Frame Clustering (mir_eval.segment.pairwise) ────────────
    try:
        p, r, f = mir_eval.segment.pairwise(
            ref_intervals, ref_labels, est_intervals, est_labels
        )
        result["pairwisePrecision"] = float(p)
        result["pairwiseRecall"]    = float(r)
        result["pairwiseFmeasure"]  = float(f)
    except Exception as e:
        result["pairwiseError"] = str(e)

    # ── 4. Normalized Conditional Entropy (mir_eval.segment.nce) ───────────
    # NCE measures how well you can predict ref clusters from est, and vice versa.
    # fwd = H(ref|est)/H(ref), bwd = H(est|ref)/H(est), avg = harmonic mean
    try:
        fwd, bwd, avg = mir_eval.segment.nce(
            ref_intervals, ref_labels, est_intervals, est_labels
        )
        result["nceForward"]  = float(fwd)
        result["nceBackward"] = float(bwd)
        result["nceAverage"]  = float(avg)
    except Exception as e:
        result["nceError"] = str(e)

    # ── 5. Mutual Information (mir_eval.segment.mutual_information) ─────────
    try:
        mi_scores = mir_eval.segment.mutual_information(
            ref_intervals, ref_labels, est_intervals, est_labels
        )
        # Returns: (MI, AMI, NMI)
        result["mutualInfo"]           = float(mi_scores[0])
        result["adjustedMutualInfo"]   = float(mi_scores[1])
        result["normalizedMutualInfo"] = float(mi_scores[2])
    except Exception as e:
        result["miError"] = str(e)

    return result


# ─── HTTP server ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Keep output clean — only log errors
        if int(args[1]) >= 400:
            super().log_message(fmt, *args)

    def _send_json(self, code: int, body: dict):
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
        if self.path == "/api/mir-eval/health":
            self._send_json(200, {
                "ok": True,
                "mirEvalVersion": mir_eval.__version__,
                "rupturesOk": _RUPTURES_OK,
                "sklearnOk": _SKLEARN_OK,
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/api/mir-eval/batch":
            self._handle_batch()
            return
        if self.path == "/api/mir-eval/cpd":
            self._handle_cpd()
            return
        if self.path == "/api/mir-eval/pairs":
            self._handle_pairs()
            return
        if self.path != "/api/mir-eval":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as e:
            self._send_json(400, {"error": f"invalid JSON: {e}"})
            return

        tolerance      = float(body.get("tolerance", 0.5))
        track_duration = float(body.get("trackDuration", 0))
        reference      = body.get("reference", {})
        algorithms     = body.get("algorithms", [])

        ref_segs = reference.get("segments", [])
        if not ref_segs:
            self._send_json(400, {"error": "reference.segments is empty"})
            return

        if track_duration <= 0:
            # infer from last segment endTime
            all_ends = [s.get("endTime", 0) for s in ref_segs]
            track_duration = max(all_ends) if all_ends else 300.0

        results = {}
        for algo in algorithms:
            algo_id  = algo.get("id", "unknown")
            est_segs = algo.get("segments", [])
            if not est_segs:
                results[algo_id] = {"error": "no segments"}
                continue
            try:
                results[algo_id] = evaluate_one(ref_segs, est_segs, tolerance, track_duration)
            except Exception as e:
                results[algo_id] = {"error": str(e)}

        self._send_json(200, {"results": results, "tolerance": tolerance})


# ─── Batch helpers ────────────────────────────────────────────────────────────

def _load_manual_segs(ann_path: Path):
    data = json.loads(ann_path.read_text())
    sections = data.get("sections", [])
    if not sections:
        return [], 0.0
    track_duration = sections[-1]["time"] + 60.0
    segs = []
    for i, s in enumerate(sections):
        segs.append({
            "time":    float(s["time"]),
            "endTime": float(sections[i + 1]["time"]) if i + 1 < len(sections) else track_duration,
            "label":   s.get("type", s.get("label", f"seg{i}")),
        })
    return segs, track_duration


def _load_auto_guess_segs(slug: str, annotator_id: str):
    """
    Load auto-guess manual annotation for *slug* (scoped to *annotator_id*) and
    return (segs, track_duration). Only 'correct' points are included. Returns
    ([], 0.0) if not found or empty.
    """
    path = _resolve_ann_file(AUTO_GUESS_DIR, annotator_id, slug)
    if path is None:
        return [], 0.0
    try:
        data = json.loads(path.read_text())
    except Exception:
        return [], 0.0
    points = [p for p in data.get("points", []) if p.get("status") == "correct"]
    if not points:
        return [], 0.0
    points.sort(key=lambda p: p["time"])
    # Estimate track duration: last point + 60 s buffer (same heuristic as manual manual)
    track_duration = points[-1]["time"] + 60.0
    segs = []
    for i, p in enumerate(points):
        segs.append({
            "time":    float(p["time"]),
            "endTime": float(points[i + 1]["time"]) if i + 1 < len(points) else track_duration,
            "label":   f"C{p.get('clusterId', i)}",
        })
    return segs, track_duration


def _load_algo_segs(path: Path):
    raw = json.loads(path.read_text())
    sections = raw if isinstance(raw, list) else raw.get("sections", [])
    return [
        {"time": float(s["time"]), "endTime": float(s["endTime"]),
         "label": s.get("type", s.get("label", "seg"))}
        for s in sections if "time" in s and "endTime" in s
    ]


def _agg(values):
    """Return {mean, std, min, max} for a list of floats, or None if empty."""
    v = [x for x in values if x is not None and not (isinstance(x, float) and np.isnan(x))]
    if not v:
        return None
    return {"mean": float(np.mean(v)), "std": float(np.std(v)),
            "min": float(np.min(v)), "max": float(np.max(v)), "n": len(v)}


# Handler method — added to the class body below via assignment trick
def _handle_batch(self):
    length = int(self.headers.get("Content-Length", 0))
    try:
        body = json.loads(self.rfile.read(length)) if length else {}
    except json.JSONDecodeError as e:
        self._send_json(400, {"error": f"invalid JSON: {e}"}); return

    tolerance      = float(body.get("tolerance", 0.5))
    use_auto_guess = bool(body.get("useAutoGuess", body.get("useConsensus", False)))
    annotator_id   = (body.get("annotator") or "").strip().lower()
    if not annotator_id:
        self._send_json(400, {"error": "missing 'annotator' field"}); return

    # Collect songs to evaluate
    reviewed_songs = []   # list of (slug, ref_segs, track_dur)

    if use_auto_guess:
        # Use songs that have an auto-guess annotation with at least one 'correct' point
        for slug in _list_own_slugs(AUTO_GUESS_DIR, annotator_id):
            ref_segs, track_dur = _load_auto_guess_segs(slug, annotator_id)
            if ref_segs:
                reviewed_songs.append((slug, ref_segs, track_dur))
    else:
        # Use songs with reviewed: true in manual manual annotations
        for slug in _list_own_slugs(ANNOTATIONS_DIR, annotator_id):
            f = _resolve_ann_file(ANNOTATIONS_DIR, annotator_id, slug)
            if f is None:
                continue
            try:
                data = json.loads(f.read_text())
                if data.get("reviewed"):
                    ref_segs, track_dur = _load_manual_segs(f)
                    if ref_segs:
                        reviewed_songs.append((slug, ref_segs, track_dur))
            except Exception:
                pass

    if not reviewed_songs:
        msg = "no auto-guess annotations with correct points found" if use_auto_guess else "no reviewed annotations found"
        self._send_json(200, {"error": msg, "results": {}, "songs": [], "tolerance": tolerance})
        return

    # Collect per-algo per-song metrics
    # algo_data[algo] = list of {slug, metrics}
    algo_data = defaultdict(list)
    song_slugs = []

    for slug, ref_segs, track_dur in reviewed_songs:
        if not ref_segs:
            continue
        song_slugs.append(slug)
        algo_dir = ANALYSIS_DIR / slug
        for algo, filename in ALGO_FILES.items():
            algo_path = algo_dir / filename
            if not algo_path.exists():
                continue
            try:
                est_segs = _load_algo_segs(algo_path)
                if not est_segs:
                    continue
                m = evaluate_one(ref_segs, est_segs, tolerance, track_dur)
                algo_data[algo].append({"slug": slug, "metrics": m})
            except Exception as e:
                algo_data[algo].append({"slug": slug, "error": str(e)})

    # Aggregate per algo
    results = {}
    KEYS = ["boundaryPrecision", "boundaryRecall", "boundaryFmeasure",
            "medianT2E", "medianE2T",
            "pairwisePrecision", "pairwiseRecall", "pairwiseFmeasure",
            "nceForward", "nceBackward", "nceAverage",
            "normalizedMutualInfo"]

    for algo, rows in algo_data.items():
        per_song = []
        per_key = defaultdict(list)
        for row in rows:
            entry = {"slug": row["slug"]}
            if "error" in row:
                entry["error"] = row["error"]
            else:
                entry["metrics"] = {k: row["metrics"].get(k) for k in KEYS}
                for k in KEYS:
                    v = row["metrics"].get(k)
                    if v is not None:
                        per_key[k].append(v)
            per_song.append(entry)

        results[algo] = {
            "perSong":   per_song,
            "aggregate": {k: _agg(per_key[k]) for k in KEYS},
            "n":         len([r for r in rows if "error" not in r]),
        }

    self._send_json(200, {
        "results":   results,
        "songs":     song_slugs,
        "tolerance": tolerance,
    })

# Patch method onto Handler class
Handler._handle_batch = _handle_batch


# ─── Lightweight batched boundary evaluator ──────────────────────────────────

def _times_to_intervals(times, track_duration: float) -> np.ndarray:
    """
    Build contiguous intervals over [0, track_duration] from a list of mid-track
    boundary times. Anchors 0 and `track_duration` are always present so that
    `mir_eval.segment.detection(..., trim=True)` drops them as silence-padding
    and scores only the user-marked boundaries.

    e.g. times=[30, 60], track_duration=120 → [[0,30],[30,60],[60,120]]
    """
    interior = sorted({float(t) for t in times if 0.0 < float(t) < track_duration})
    starts = [0.0] + interior
    ends = interior + [float(track_duration)]
    return np.array(list(zip(starts, ends)), dtype=float)


def _ensure_zero_anchor(arr: np.ndarray) -> np.ndarray:
    """Defensive normalization: prepend 0.0 if not already present.

    `_times_to_intervals` would build [0, first_user_time] regardless, so this
    is a no-op for `segment.detection` scoring. It exists to make every
    boundary list flowing through the eval pipeline canonical, in line with
    the project policy 'every annotation has 0 and track_duration as anchors'.
    """
    if arr.size == 0 or arr.min() == 0.0:
        return arr
    return np.concatenate([[0.0], arr])


def _eval_pair(ref_times, est_times, tolerance: float, track_duration: float) -> dict:
    """
    Boundary P/R/F via `mir_eval.segment.detection(trim=True)` — the canonical
    MIREX entry point for segmentation boundary scoring. Intervals are built
    with explicit [0, track_duration] anchors which `trim=True` then drops, so
    scoring is on the user-marked mid-track boundaries only.

    `refCount` / `estCount` in the response reflect the caller's original
    boundary count (before any 0-anchor normalization), matching what the UI
    displays.

    Also returns `t2eErrors` and `e2tErrors` — nearest-neighbor distances per
    original boundary, in the caller's input order — for per-marker UI coloring.
    """
    ref_arr = np.asarray(ref_times, dtype=float)
    est_arr = np.asarray(est_times, dtype=float)
    orig_ref_count = int(ref_arr.size)
    orig_est_count = int(est_arr.size)
    if ref_arr.size == 0 or est_arr.size == 0 or track_duration <= 0.0:
        return {
            "precision": 0.0, "recall": 0.0, "fmeasure": 0.0,
            "refCount": orig_ref_count, "estCount": orig_est_count,
            "tolerance": tolerance,
            "t2eErrors": [], "e2tErrors": [],
        }
    norm_ref = _ensure_zero_anchor(ref_arr)
    norm_est = _ensure_zero_anchor(est_arr)
    ref_intervals = _times_to_intervals(norm_ref, track_duration)
    est_intervals = _times_to_intervals(norm_est, track_duration)
    p, r, f = mir_eval.segment.detection(
        ref_intervals, est_intervals, window=tolerance, trim=True,
    )
    # TP derived from precision × scored est count. `segment.detection(trim=True)`
    # scores `intervals_to_boundaries(...) [1:-1]` — i.e. n-1 boundaries per
    # side after dropping the [0, T] anchors. Equivalent to multiplying by the
    # interval count minus 1.
    scored_est = max(0, len(est_intervals) - 1)
    hit_count = int(round(p * scored_est)) if scored_est > 0 else 0

    # Per-boundary nearest-neighbor distances (in original caller order, so
    # the UI can map them back to its boundary markers without re-sorting).
    t2e = [float(np.min(np.abs(est_arr - rt))) for rt in ref_arr]
    e2t = [float(np.min(np.abs(ref_arr - et))) for et in est_arr]
    return {
        "precision": float(p), "recall": float(r), "fmeasure": float(f),
        "refCount": orig_ref_count, "estCount": orig_est_count,
        "hitCount": hit_count,
        "tolerance": tolerance,
        "t2eErrors": t2e, "e2tErrors": e2t,
    }


def _handle_pairs(self):
    length = int(self.headers.get("Content-Length", 0))
    try:
        body = json.loads(self.rfile.read(length)) if length else {}
    except json.JSONDecodeError as e:
        self._send_json(400, {"error": f"invalid JSON: {e}"}); return

    pairs = body.get("pairs", [])
    if not isinstance(pairs, list):
        self._send_json(400, {"error": "'pairs' must be a list"}); return

    default_tol = float(body.get("tolerance", 0.5))
    default_dur = float(body.get("trackDuration", 0.0))
    results: dict = {}
    for entry in pairs:
        pair_id = str(entry.get("id", ""))
        if not pair_id:
            continue
        tol = float(entry.get("tolerance", default_tol))
        dur = float(entry.get("trackDuration", default_dur))
        try:
            results[pair_id] = _eval_pair(
                entry.get("refTimes", []),
                entry.get("estTimes", []),
                tol,
                dur,
            )
        except Exception as e:
            results[pair_id] = {"error": str(e)}

    self._send_json(200, {"results": results})


Handler._handle_pairs = _handle_pairs


# ─── CPD evaluation ───────────────────────────────────────────────────────────

def _segs_to_changepoints(segs, track_duration: float, fps: float):
    """
    Convert [{time, endTime, label}] → ruptures-style change point list.

    ruptures convention: change points are the exclusive end indices of each
    segment, with the final entry always equal to n_samples.

    e.g. segments [0:50], [50:150], [150:300] → change points [50, 150, 300]
    """
    n_samples = max(1, round(track_duration * fps))

    sorted_segs = sorted(segs, key=lambda s: s["time"])

    # Boundary = start time of every segment except the first
    boundary_times = [s["time"] for s in sorted_segs[1:]]

    # Convert to frame indices, clamp, deduplicate
    cps = sorted(set(
        min(max(1, round(t * fps)), n_samples - 1)
        for t in boundary_times
    ))

    # Always end with n_samples (ruptures sentinel)
    cps.append(n_samples)
    return cps, n_samples


def _changepoints_to_labels(changepoints, n_samples: int) -> np.ndarray:
    """
    Convert ruptures-style change points to a dense integer label array for
    sklearn clustering metrics.

    changepoints: sorted list ending with n_samples
    returns: np.ndarray shape (n_samples,) with integer segment IDs
    """
    labels = np.empty(n_samples, dtype=np.int32)
    prev = 0
    for seg_id, cp in enumerate(changepoints):
        end = min(int(cp), n_samples)
        labels[prev:end] = seg_id
        prev = end
    return labels


def evaluate_cpd(ref_segs, est_segs, tolerance_sec: float,
                 track_duration: float, fps: float) -> dict:
    """
    Run CPD-focused metrics for one (ref, est) pair.

    Tolerance-based metrics use ruptures.metrics (precision_recall).
    Distance metrics use ruptures.metrics (hausdorff) + manual MAE.
    Clustering metrics use ruptures.metrics (randindex) and sklearn
    (adjusted_rand_score, normalized_mutual_info_score).

    All time-valued results are returned in seconds; frame equivalents are
    included for debugging.
    """
    if not _RUPTURES_OK:
        return {"error": "ruptures not installed — run: pip install ruptures"}

    result: dict = {}

    ref_cps, n_samples = _segs_to_changepoints(ref_segs, track_duration, fps)
    est_cps, _         = _segs_to_changepoints(est_segs, track_duration, fps)

    # tolerance in frames (must be ≥ 1)
    margin = max(1, round(tolerance_sec * fps))

    # ── 1. Tolerance-based Precision / Recall / F1 ───────────────────────────
    try:
        precision, recall = rpt_metrics.precision_recall(
            ref_cps, est_cps, margin=margin
        )
        denom = precision + recall
        f1 = float(2 * precision * recall / denom) if denom > 0 else 0.0
        result["precision"] = float(precision)
        result["recall"]    = float(recall)
        result["f1"]        = f1
    except Exception as exc:
        result["precisionRecallError"] = str(exc)

    # ── 2. Hausdorff Distance ─────────────────────────────────────────────────
    try:
        h_frames = float(rpt_metrics.hausdorff(ref_cps, est_cps, n_samples=n_samples))
        result["hausdorff"]       = h_frames / fps   # → seconds
        result["hausdorffFrames"] = h_frames
    except Exception as exc:
        result["hausdorffError"] = str(exc)

    # ── 3. MAE — mean |predicted CP − nearest true CP| ───────────────────────
    try:
        # Exclude the trailing n_samples sentinel from both sides
        ref_inner = np.array(ref_cps[:-1], dtype=float)
        est_inner = np.array(est_cps[:-1], dtype=float)

        if len(ref_inner) > 0 and len(est_inner) > 0:
            mae_frames = float(np.mean([
                np.min(np.abs(e - ref_inner)) for e in est_inner
            ]))
        elif len(ref_inner) == 0 and len(est_inner) == 0:
            mae_frames = 0.0
        else:
            mae_frames = float(n_samples)   # worst-case: no overlap at all

        result["mae"]       = mae_frames / fps   # → seconds
        result["maeFrames"] = mae_frames
    except Exception as exc:
        result["maeError"] = str(exc)

    # ── 4. Rand Index (ruptures) ──────────────────────────────────────────────
    try:
        result["randIndex"] = float(
            rpt_metrics.randindex(ref_cps, est_cps, n_samples=n_samples)
        )
    except Exception as exc:
        result["randIndexError"] = str(exc)

    # ── 5. Adjusted Rand Index + NMI (sklearn) ────────────────────────────────
    if not _SKLEARN_OK:
        result["sklearnError"] = "scikit-learn not installed — run: pip install scikit-learn"
    else:
        try:
            ref_labels = _changepoints_to_labels(ref_cps, n_samples)
            est_labels = _changepoints_to_labels(est_cps, n_samples)
            result["adjustedRandIndex"]    = float(adjusted_rand_score(ref_labels, est_labels))
            result["normalizedMutualInfo"] = float(
                normalized_mutual_info_score(ref_labels, est_labels, average_method="arithmetic")
            )
        except Exception as exc:
            result["sklearnError"] = str(exc)

    return result


def _handle_cpd(self):
    if not _RUPTURES_OK:
        self._send_json(503, {"error": "ruptures not installed — run: pip install ruptures"})
        return

    length = int(self.headers.get("Content-Length", 0))
    try:
        body = json.loads(self.rfile.read(length)) if length else {}
    except json.JSONDecodeError as exc:
        self._send_json(400, {"error": f"invalid JSON: {exc}"}); return

    tolerance_sec  = float(body.get("tolerance", 0.5))
    fps            = float(body.get("fps", 10.0))
    track_duration = float(body.get("trackDuration", 0))
    reference      = body.get("reference", {})
    algorithms     = body.get("algorithms", [])

    ref_segs = reference.get("segments", [])
    if not ref_segs:
        self._send_json(400, {"error": "reference.segments is empty"}); return

    if track_duration <= 0:
        all_ends = [s.get("endTime", 0) for s in ref_segs]
        track_duration = max(all_ends) if all_ends else 300.0

    results = {}
    for algo in algorithms:
        algo_id  = algo.get("id", "unknown")
        est_segs = algo.get("segments", [])
        if not est_segs:
            results[algo_id] = {"error": "no segments"}
            continue
        try:
            results[algo_id] = evaluate_cpd(
                ref_segs, est_segs, tolerance_sec, track_duration, fps
            )
        except Exception as exc:
            results[algo_id] = {"error": str(exc)}

    self._send_json(200, {
        "results":   results,
        "tolerance": tolerance_sec,
        "fps":       fps,
    })


Handler._handle_cpd = _handle_cpd


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"mir_eval version: {mir_eval.__version__}", file=sys.stderr)
    print(f"Starting MIR eval server on http://{host}:{PORT}", file=sys.stderr)
    print(f"Vite will proxy /api/mir-eval → this server", file=sys.stderr)
    server = HTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
