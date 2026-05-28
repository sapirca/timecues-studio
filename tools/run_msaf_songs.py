#!/usr/bin/env python3
"""
Run MSAF + BPM annotations on all songs in songs/ that are missing them.
Outputs to data/algorithm-outputs/msaf/<slug>/msaf-{algo}.json and msaf-bpm.json
Also syncs results to data/algorithm-outputs/analysis/<slug>/ and updates manifest.json.
"""
import argparse, json, os, re, sys, tempfile, time, warnings
from pathlib import Path
import librosa, numpy as np, msaf

warnings.filterwarnings("ignore")

# msaf.process() writes a features cache to msaf.config.features_tmp_file,
# which defaults to ".features_msaf_tmp.json" in cwd — route it to the
# system tmp dir so it doesn't pollute the repo root.
msaf.config.features_tmp_file = os.path.join(tempfile.gettempdir(), ".features_msaf_tmp.json")

sys.path.insert(0, str(Path(__file__).resolve().parent / "python"))
from paths import SONGS_DIR as _SONGS_DIR, MSAF_DIR as _MSAF_DIR, ANALYSIS_DIR as _ANALYSIS_DIR  # noqa: E402

SONGS_DIR     = str(_SONGS_DIR)
MSAF_OUT_DIR  = str(_MSAF_DIR)
ANALYSIS_DIR  = str(_ANALYSIS_DIR)
MANIFEST_PATH = os.path.join(ANALYSIS_DIR, "manifest.json")


def sync_to_public(slug, ann_dir):
    """Copy MSAF results from data/algorithm-outputs/msaf/<slug>/ to data/algorithm-outputs/analysis/<slug>/
    and set hasAnalysis=true in manifest.json."""
    pub_dir = os.path.join(ANALYSIS_DIR, slug)
    os.makedirs(pub_dir, exist_ok=True)

    # Copy msaf-{algo}.json → {algo}.json and msaf-bpm.json → bpm.json
    renames = {f"msaf-{algo}.json": f"{algo}.json" for algo in ALGORITHMS}
    renames["msaf-bpm.json"] = "bpm.json"
    for src_name, dst_name in renames.items():
        src = os.path.join(ann_dir, src_name)
        if os.path.exists(src):
            import shutil
            shutil.copy2(src, os.path.join(pub_dir, dst_name))

    # Update manifest hasAnalysis flag
    try:
        manifest = json.loads(open(MANIFEST_PATH).read())
        for entry in manifest:
            if entry.get("id") == slug:
                entry["hasAnalysis"] = True
                break
        with open(MANIFEST_PATH, "w") as f:
            json.dump(manifest, f, indent=2)
    except Exception as e:
        print(f"    [manifest] warning: {e}")

ALGORITHMS = {
    "sf":    "Structural Features (SF)",
    "foote": "Foote Self-Similarity",
    "cnmf":  "CNMF (Non-negative Matrix Factorization)",
    "olda":  "OLDA (Optimal Linear Discriminant)",
}

def find_audio(folder):
    for f in os.listdir(folder):
        if f.lower().endswith((".mp3", ".wav", ".flac", ".ogg", ".m4a")):
            return os.path.join(folder, f)
    return None

def classify_sections(y, sr, boundaries):
    duration = librosa.get_duration(y=y, sr=sr)
    boundaries = np.clip(boundaries, 0, duration)
    boundaries = np.sort(np.unique(boundaries))
    seg_energies, seg_centroids = [], []
    for i in range(len(boundaries) - 1):
        s0 = int(boundaries[i] * sr); s1 = int(boundaries[i+1] * sr)
        seg = y[s0:s1]
        if len(seg) < 512:
            seg_energies.append(0.0); seg_centroids.append(0.0); continue
        seg_energies.append(float(np.sqrt(np.mean(seg**2))))
        seg_centroids.append(float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=sr))))
    n = len(seg_energies)
    if n == 0: return []
    e_arr = np.array(seg_energies); c_arr = np.array(seg_centroids)
    e_norm = e_arr / (e_arr.max() or 1.0); c_norm = c_arr / (c_arr.max() or 1.0)
    labels = ["verse"] * n
    is_drop = e_norm > 0.65
    for i in range(n):
        if is_drop[i]: labels[i] = "drop"
    for i in range(1, n):
        if labels[i] == "drop" and labels[i-1] != "drop":
            if boundaries[i] - boundaries[i-1] >= 4: labels[i-1] = "buildup"
    for i in range(n):
        if e_norm[i] < 0.35 and labels[i] == "verse":
            if not (i < n-1 and labels[i+1] == "drop"): labels[i] = "breakdown"
    first_drop = next((i for i,l in enumerate(labels) if l=="drop"), n)
    for i in range(first_drop):
        if labels[i] in ("verse","breakdown") and e_norm[i] < 0.55: labels[i] = "intro"
    last_drop = next((i for i in range(n-1,-1,-1) if labels[i]=="drop"), -1)
    if last_drop >= 0:
        for i in range(last_drop+1, n):
            if labels[i] in ("verse","breakdown") and e_norm[i] < 0.55: labels[i] = "outro"
    sections = []
    for i in range(n):
        lt = labels[i]
        sections.append({"time": round(float(boundaries[i]),3), "endTime": round(float(boundaries[i+1]),3),
                         "type": lt, "label": lt.capitalize(),
                         "energy": round(float(e_norm[i]),3), "centroid": round(float(c_norm[i]),3)})
    return sections

def run_msaf(audio_path, slug, ann_dir):
    audio_file = os.path.basename(audio_path)
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    for algo, algo_name in ALGORITHMS.items():
        out_path = os.path.join(ann_dir, f"msaf-{algo}.json")
        if os.path.exists(out_path):
            print(f"    [{algo}] cached"); continue
        print(f"    [{algo}] running...", end="", flush=True)
        t0 = time.time()
        try:
            boundaries, _ = msaf.process(audio_path, boundaries_id=algo, feature="mfcc")
            elapsed = round(time.time()-t0, 2)
            if len(boundaries) == 0 or boundaries[0] != 0:
                boundaries = np.concatenate([[0.0], boundaries])
            sections = classify_sections(y, sr, boundaries)
            data = {"algorithm": algo, "algoName": algo_name, "audioFile": audio_file,
                    "duration": sections[-1]["endTime"] if sections else duration,
                    "sections": sections, "rawBoundaries": [round(float(b),3) for b in boundaries],
                    "computedAt": int(time.time()), "elapsedSec": elapsed}
            with open(out_path, "w") as f: json.dump(data, f, indent=2)
            print(f" done ({elapsed}s, {len(sections)} sections)")
        except Exception as e:
            print(f" ERROR: {e}")

    # BPM
    bpm_path = os.path.join(ann_dir, "msaf-bpm.json")
    if not os.path.exists(bpm_path):
        print(f"    [bpm] running...", end="", flush=True)
        try:
            tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
            beat_times = librosa.frames_to_time(beat_frames, sr=sr)
            bpm_val = float(tempo) if np.isscalar(tempo) else float(tempo[0])
            data = {"algorithm": "librosa", "bpm": round(bpm_val, 2),
                    "beatInterval": round(60.0/bpm_val, 6) if bpm_val else 0,
                    "beatTimes": [round(float(t),3) for t in beat_times],
                    "audioFile": audio_file, "computedAt": int(time.time())}
            with open(bpm_path, "w") as f: json.dump(data, f, indent=2)
            print(f" done ({round(bpm_val,1)} BPM)")
        except Exception as e:
            print(f" ERROR: {e}")
    else:
        print(f"    [bpm] cached")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--slug', default=None, help='Only process this song slug')
    parser.add_argument('--algorithms', default=None,
                        help='Comma-separated subset of algorithms to run (sf,foote,cnmf,olda). Default: all')
    args = parser.parse_args()

    if args.algorithms:
        global ALGORITHMS
        requested = set(args.algorithms.split(','))
        invalid = requested - set(ALGORITHMS)
        if invalid:
            print(f"Unknown algorithms: {invalid}. Valid: {set(ALGORITHMS)}")
        ALGORITHMS = {k: v for k, v in ALGORITHMS.items() if k in requested}
        if not ALGORITHMS:
            print("No valid algorithms selected, nothing to do."); return

    if args.slug:
        target = [args.slug]
    else:
        missing = []
        for slug in sorted(os.listdir(SONGS_DIR)):
            d = os.path.join(SONGS_DIR, slug)
            if not os.path.isdir(d): continue
            out = os.path.join(MSAF_OUT_DIR, slug)
            if not os.path.exists(os.path.join(out, "msaf-sf.json")):
                missing.append(slug)
        if not missing:
            print("All songs already have MSAF annotations."); return
        print(f"Songs needing MSAF ({len(missing)}):")
        for s in missing: print(f"  {s}")
        print()
        target = missing

    for slug in target:
        d = os.path.join(SONGS_DIR, slug)
        if not os.path.isdir(d):
            print(f"  [{slug}] not found, skipping"); continue
        audio = find_audio(d)
        if not audio:
            print(f"  [{slug}] no audio file found, skipping"); continue
        ann_dir = os.path.join(MSAF_OUT_DIR, slug)
        os.makedirs(ann_dir, exist_ok=True)
        print(f"► {slug}  ({os.path.basename(audio)})")
        run_msaf(audio, slug, ann_dir)
        sync_to_public(slug, ann_dir)
        print(f"    [sync] → data/algorithm-outputs/analysis/{slug}/")
        print()

if __name__ == "__main__":
    main()
