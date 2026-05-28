#!/usr/bin/env python3
"""
Batch MIR evaluation across all reviewed manual annotations.

For each reviewed song, loads every available algorithm result from
    data/algorithm-outputs/analysis/<slug>/<algo>.json
and evaluates it against the manual annotation using mir_eval.

Usage:
    python tools/python/evaluate_reviewed.py [--tolerance 0.5] [--tolerance2 3.0]
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import mir_eval.segment
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import ANALYSIS_DIR, REPO_ROOT, MANUAL_ANNOTATIONS_DIR as ANNOTATIONS_DIR  # noqa: E402

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
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

def load_manual(path: Path):
    data = json.loads(path.read_text())
    sections = data.get("sections", [])
    # Infer endTimes from the next section's start (track duration unknown → use last+60)
    track_duration = sections[-1]["time"] + 60 if sections else 300.0
    result = []
    for i, s in enumerate(sections):
        result.append({
            "time":    float(s["time"]),
            "endTime": float(sections[i + 1]["time"]) if i + 1 < len(sections) else track_duration,
            "label":   s.get("type", s.get("label", f"seg{i}")),
        })
    return result, track_duration


def load_algo(path: Path):
    raw = json.loads(path.read_text())
    # Handle both {"sections": [...]} and plain [...]
    sections = raw if isinstance(raw, list) else raw.get("sections", [])
    return [
        {
            "time":    float(s["time"]),
            "endTime": float(s["endTime"]),
            "label":   s.get("type", s.get("label", "seg")),
        }
        for s in sections
        if "time" in s and "endTime" in s
    ]


def segs_to_intervals_labels(segs):
    intervals = np.array([[s["time"], s["endTime"]] for s in segs], dtype=float)
    labels    = [s["label"] for s in segs]
    return intervals, labels


def fix_intervals(intervals: np.ndarray, track_duration: float) -> np.ndarray:
    if len(intervals) == 0:
        return np.array([[0.0, track_duration]])
    intervals = intervals.copy()[intervals[:, 0].argsort()]
    intervals[:, 0] = np.clip(intervals[:, 0], 0, track_duration)
    intervals[:, 1] = np.clip(intervals[:, 1], 0, track_duration)
    for i in range(len(intervals) - 1):
        intervals[i, 1] = intervals[i + 1, 0]
    intervals[-1, 1] = track_duration
    valid = intervals[:, 1] > intervals[:, 0]
    intervals = intervals[valid]
    if len(intervals) == 0:
        return np.array([[0.0, track_duration]])
    if intervals[0, 0] > 1e-6:
        intervals = np.vstack([[0.0, intervals[0, 0]], intervals])
    return intervals


def pad_labels(labels, intervals_raw, intervals_fixed):
    diff = len(intervals_fixed) - len(labels)
    return ["__pad__"] * diff + list(labels) if diff > 0 else list(labels)


def evaluate_pair(ref_segs, est_segs, track_duration, tolerance):
    ref_iv_raw, ref_lb_raw = segs_to_intervals_labels(ref_segs)
    est_iv_raw, est_lb_raw = segs_to_intervals_labels(est_segs)
    ref_iv = fix_intervals(ref_iv_raw, track_duration)
    est_iv = fix_intervals(est_iv_raw, track_duration)
    ref_lb = pad_labels(ref_lb_raw, ref_iv_raw, ref_iv)
    est_lb = pad_labels(est_lb_raw, est_iv_raw, est_iv)

    ref_t = np.array([s["time"] for s in ref_segs])
    est_t = np.array([s["time"] for s in est_segs])

    m = {}

    # Boundary detection
    try:
        p, r, f = mir_eval.segment.detection(ref_iv, est_iv, window=tolerance)
        m["bd_p"], m["bd_r"], m["bd_f"] = float(p), float(r), float(f)
    except Exception:
        m["bd_p"] = m["bd_r"] = m["bd_f"] = float("nan")

    # Deviation
    try:
        t2e, e2t = mir_eval.segment.deviation(ref_iv, est_iv)
        m["t2e"], m["e2t"] = float(t2e), float(e2t)
    except Exception:
        if len(ref_t) > 0 and len(est_t) > 0:
            m["t2e"] = float(np.median([np.min(np.abs(r - est_t)) for r in ref_t]))
            m["e2t"] = float(np.median([np.min(np.abs(e - ref_t)) for e in est_t]))
        else:
            m["t2e"] = m["e2t"] = float("nan")

    # Pairwise
    try:
        p, r, f = mir_eval.segment.pairwise(ref_iv, ref_lb, est_iv, est_lb)
        m["pw_p"], m["pw_r"], m["pw_f"] = float(p), float(r), float(f)
    except Exception:
        m["pw_p"] = m["pw_r"] = m["pw_f"] = float("nan")

    # NCE
    try:
        fwd, bwd, avg = mir_eval.segment.nce(ref_iv, ref_lb, est_iv, est_lb)
        m["nce_fwd"], m["nce_bwd"], m["nce_avg"] = float(fwd), float(bwd), float(avg)
    except Exception:
        m["nce_fwd"] = m["nce_bwd"] = m["nce_avg"] = float("nan")

    # NMI
    try:
        mi, ami, nmi = mir_eval.segment.mutual_information(ref_iv, ref_lb, est_iv, est_lb)
        m["nmi"] = float(nmi)
    except Exception:
        m["nmi"] = float("nan")

    return m


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tolerance",  type=float, default=0.5,  help="Primary tolerance (default 0.5s)")
    parser.add_argument("--tolerance2", type=float, default=3.0,  help="Secondary tolerance (default 3.0s)")
    args = parser.parse_args()

    # Load all reviewed annotations
    reviewed = []
    for f in sorted(ANNOTATIONS_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            if data.get("reviewed"):
                reviewed.append((f.stem, f))
        except Exception:
            pass

    if not reviewed:
        print("No reviewed annotations found.")
        sys.exit(1)

    print(f"Found {len(reviewed)} reviewed songs.\n")

    # Collect per-algo scores: algo → list of metric dicts
    scores_t1: dict[str, list] = defaultdict(list)
    scores_t2: dict[str, list] = defaultdict(list)
    song_results = []   # (slug, algo, metrics_t1, metrics_t2)

    for slug, ann_path in reviewed:
        ref_segs, track_dur = load_manual(ann_path)
        if not ref_segs:
            continue

        algo_dir = ANALYSIS_DIR / slug
        for algo, filename in ALGO_FILES.items():
            algo_path = algo_dir / filename
            if not algo_path.exists():
                continue
            est_segs = load_algo(algo_path)
            if not est_segs:
                continue

            m1 = evaluate_pair(ref_segs, est_segs, track_dur, args.tolerance)
            m2 = evaluate_pair(ref_segs, est_segs, track_dur, args.tolerance2)
            scores_t1[algo].append(m1)
            scores_t2[algo].append(m2)
            song_results.append((slug, algo, m1, m2))

    if not song_results:
        print("No algorithm results found for reviewed songs.")
        sys.exit(1)

    # ── Per-song detail ──────────────────────────────────────────────────────
    print("=" * 110)
    print("PER-SONG RESULTS  (τ = {:.1f}s)".format(args.tolerance))
    print("=" * 110)
    hdr = f"{'Song':<46} {'Algo':<14} {'BD-P':>5} {'BD-R':>5} {'BD-F':>5}  {'T2E':>5} {'E2T':>5}  {'PW-F':>5}  {'NCE↑':>5}  {'NMI':>5}"
    print(hdr)
    print("-" * 110)

    current_slug = None
    for slug, algo, m1, _ in sorted(song_results):
        if slug != current_slug:
            if current_slug is not None:
                print()
            current_slug = slug
        def pct(v): return f"{v*100:5.1f}" if not np.isnan(v) else "  —  "
        def sec(v): return f"{v:5.2f}" if not np.isnan(v) else "  —  "
        slug_col = slug[:45] if slug != current_slug else " " * 46
        print(f"{slug:<46} {algo:<14} {pct(m1['bd_p'])} {pct(m1['bd_r'])} {pct(m1['bd_f'])}  {sec(m1['t2e'])} {sec(m1['e2t'])}  {pct(m1['pw_f'])}  {pct(m1['nce_avg'])}  {pct(m1['nmi'])}")

    # ── Aggregate per algorithm ───────────────────────────────────────────────
    METRICS = ["bd_p", "bd_r", "bd_f", "t2e", "e2t", "pw_f", "nce_avg", "nmi"]
    METRIC_LABELS = ["BD-P", "BD-R", "BD-F", "T2E", "E2T", "PW-F", "NCE↑", "NMI"]
    PCT_METRICS = {"bd_p", "bd_r", "bd_f", "pw_f", "nce_avg", "nmi"}

    for tau_label, scores in [(f"τ = {args.tolerance:.1f}s", scores_t1), (f"τ = {args.tolerance2:.1f}s", scores_t2)]:
        print()
        print("=" * 110)
        print(f"AGGREGATE RESULTS — {tau_label}  (mean ± std, N = songs evaluated per algorithm)")
        print("=" * 110)

        # Header
        col_w = 14
        header = f"{'Algorithm':<{col_w}}"
        for lbl in METRIC_LABELS:
            header += f"  {lbl:>13}"
        header += f"  {'N':>3}"
        print(header)
        print("-" * 110)

        # Sort algorithms: allin1 first, then folds, then msaf
        def algo_sort_key(k):
            if k == "allin1": return (0, "")
            if k.startswith("allin1-fold"): return (1, k)
            return (2, k)

        for algo in sorted(scores.keys(), key=algo_sort_key):
            rows = scores[algo]
            n = len(rows)
            row_str = f"{algo:<{col_w}}"
            for key in METRICS:
                vals = [r[key] for r in rows if not np.isnan(r[key])]
                if not vals:
                    row_str += f"  {'—':>13}"
                    continue
                mu = np.mean(vals)
                sd = np.std(vals)
                if key in PCT_METRICS:
                    row_str += f"  {mu*100:5.1f}±{sd*100:4.1f}%  "
                else:
                    row_str += f"  {mu:5.2f}±{sd:4.2f}s  "
            row_str += f"  {n:>3}"
            print(row_str)

    print()
    print("Metrics:")
    print("  BD-P/R/F  Boundary Detection Precision / Recall / F-measure  (mir_eval.segment.detection)")
    print("  T2E/E2T   Median deviation True→Est / Est→True in seconds     (mir_eval.segment.deviation)")
    print("  PW-F      Pairwise Frame Clustering F-measure                 (mir_eval.segment.pairwise)")
    print("  NCE↑      Normalized Conditional Entropy average (↑ = better) (mir_eval.segment.nce)")
    print("  NMI       Normalized Mutual Information                        (mir_eval.segment.mutual_information)")


if __name__ == "__main__":
    main()
