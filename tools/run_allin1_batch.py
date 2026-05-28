#!/usr/bin/env python3
"""
Run allin1 (harmonix-fold0) on all songs missing the annotation.
Usage: python tools/run_allin1_batch.py [--model harmonix-fold0]
"""
import argparse, os, sys, subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "python"))
from paths import SONGS_DIR, ANALYSIS_DIR  # noqa: E402

RUNNER = Path(__file__).parent / "run_allin1.py"


def slugify(name: str) -> str:
    import re
    name = re.sub(r'\.[^.]+$', '', name)
    name = name.lower()
    name = re.sub(r'[^a-z0-9]+', '-', name)
    return name.strip('-')


def find_audio(song_dir: Path):
    for f in song_dir.iterdir():
        if f.suffix.lower() in ('.mp3', '.wav', '.flac', '.ogg', '.m4a'):
            return f
    return None


def out_filename(model: str) -> str:
    if model == "harmonix-all":
        return "allin1.json"
    fold = model.replace("harmonix-", "")
    return f"allin1-{fold}.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="harmonix-fold0",
                        help="allin1 model variant (default: harmonix-fold0)")
    args = parser.parse_args()

    fname = out_filename(args.model)

    missing = []
    for song_dir in sorted(SONGS_DIR.iterdir()):
        if not song_dir.is_dir():
            continue
        audio = find_audio(song_dir)
        if not audio:
            continue
        slug = slugify(audio.name)
        out = ANALYSIS_DIR / slug / fname
        if not out.exists():
            missing.append(audio)

    if not missing:
        print(f"All songs already have {fname}.")
        return

    print(f"Running allin1 [{args.model}] on {len(missing)} songs:\n")
    for i, audio in enumerate(missing, 1):
        print(f"[{i}/{len(missing)}] {audio.name}")
        result = subprocess.run(
            [sys.executable, str(RUNNER), str(audio), "--save", "--model", args.model],
            capture_output=False
        )
        if result.returncode != 0:
            print(f"  ERROR (exit {result.returncode})")
        print()

    print("Done.")


if __name__ == "__main__":
    main()
