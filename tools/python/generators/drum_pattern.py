"""Generate the `drum-pattern` curated output: the repeating drum rhythm.

Design note — why not LoCoMotif here:
  The PATTERN sidecar (locomotif) discovers motifs on beat-synchronous
  *chroma*. Chroma captures harmony, not percussion, so it's the wrong
  signal for a drum groove. Instead we derive the rhythm directly:

    1. Grid from cached allin1 (downbeatPositions = bar starts, bpm).
    2. Onset detection on the *drums* stem (librosa) — the stem isolation
       is what makes the onsets clean enough to quantize.
    3. Fold each bar's onsets onto a 16th-note step grid
       (beats_per_bar × 4 steps per cycle).
    4. Find the longest run of consecutive bars whose step pattern is
       self-similar — that run IS the repeating groove.
    5. Emit ONE Pattern: a single-bar cycle, repeat_count = run length,
       highlighted_beats = steps that fire in ≥ half the run's bars.

Needs the drums stem on disk (Demucs) — generate() returns a SKIPPED
(no-input) envelope when it's absent, so this only fully runs on the VM.

Run:  python -m generators.drum_pattern <slug>     (from tools/python/)
"""

from __future__ import annotations

import sys
from pathlib import Path

# tools/python on the path for `paths`.
_PY_DIR = Path(__file__).resolve().parent.parent
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

from generators.common import (  # noqa: E402
    build_envelope,
    load_allin1,
    missing_inputs_fatal,
    write_envelope,
)
from paths import stem_audio  # noqa: E402

# The envelope family id (kebab-case, matches generators.common.FAMILY_KINDS).
# The module is named drum_pattern.py because '-' is illegal in a module name.
ENV_FAMILY = "drum-pattern"
SUBBEATS_PER_BEAT = 4  # 16th-note resolution, mirrors PATTERN_SUBBEATS_PER_BEAT (web)
# A bar's step-vector is "the same groove" as the run's seed when their cosine
# similarity is at least this. Tolerant enough to absorb fills/ghost notes.
SIMILARITY = 0.75
# A step is part of the canonical pattern when it fires in at least this
# fraction of the run's bars.
STEP_HIT_FRACTION = 0.5


def _beats_per_bar(allin1: dict) -> int:
    # allin1 has no time signature; downbeats vs beats give the ratio.
    beats = allin1.get("beatPositions") or []
    downs = allin1.get("downbeatPositions") or []
    if len(beats) >= 2 and len(downs) >= 2:
        bar_dur = (downs[-1] - downs[0]) / max(1, len(downs) - 1)
        beat_dur = (beats[-1] - beats[0]) / max(1, len(beats) - 1)
        if beat_dur > 0:
            n = int(round(bar_dur / beat_dur))
            if 2 <= n <= 12:
                return n
    return 4


def _bar_step_vectors(
    onsets: list[float],
    downbeats: list[float],
    steps_per_cycle: int,
) -> list[tuple[float, float, list[int]]]:
    """Per bar, return (bar_start, bar_dur, step_counts[steps_per_cycle])."""
    bars: list[tuple[float, float, list[int]]] = []
    import bisect

    onsets = sorted(onsets)
    for i in range(len(downbeats) - 1):
        bar_start = float(downbeats[i])
        bar_end = float(downbeats[i + 1])
        bar_dur = bar_end - bar_start
        if bar_dur <= 0:
            continue
        step_dur = bar_dur / steps_per_cycle
        counts = [0] * steps_per_cycle
        lo = bisect.bisect_left(onsets, bar_start)
        hi = bisect.bisect_left(onsets, bar_end)
        for t in onsets[lo:hi]:
            # Round to the NEAREST step (not floor): onset_detect(backtrack)
            # pulls a hit slightly before its beat, so a downbeat kick would
            # otherwise fall into the previous bar's last step. Rounding +
            # wraparound assigns it to step 0 where it belongs.
            step = int(round((t - bar_start) / step_dur)) % steps_per_cycle
            counts[step] += 1
        bars.append((bar_start, bar_dur, counts))
    return bars


def _cosine(a: list[int], b: list[int]) -> float:
    import math

    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _longest_similar_run(bars: list[tuple[float, float, list[int]]]) -> tuple[int, int]:
    """Index range [start, end) of the longest run of self-similar bars."""
    best_start, best_len = 0, 0
    i = 0
    n = len(bars)
    while i < n:
        # Skip empty bars (no onsets) as run seeds.
        if sum(bars[i][2]) == 0:
            i += 1
            continue
        seed = bars[i][2]
        j = i + 1
        while j < n and sum(bars[j][2]) > 0 and _cosine(seed, bars[j][2]) >= SIMILARITY:
            j += 1
        if j - i > best_len:
            best_start, best_len = i, j - i
        i = max(j, i + 1)
    return best_start, best_start + best_len


def generate(slug: str) -> dict:
    """Build (and return) the drum-pattern envelope for `slug`. Writes nothing."""
    allin1 = load_allin1(slug)
    if allin1 is None:
        return missing_inputs_fatal(
            ENV_FAMILY, slug,
            hint="no allin1.json cache (needed for the bar grid). Run All-In-One first.",
        )
    downbeats = allin1.get("downbeatPositions") or []
    if len(downbeats) < 3:
        return missing_inputs_fatal(
            ENV_FAMILY, slug,
            hint="allin1 has too few downbeats to define a bar grid.",
        )

    drums_path = stem_audio(slug, "drums")
    if drums_path is None:
        return missing_inputs_fatal(
            ENV_FAMILY, slug,
            hint=(
                "no 'drums' stem on disk. Run Demucs separation first "
                "(tools/run_demucs_songs.py) so the drum onsets can be quantized."
            ),
        )

    try:
        import librosa
    except Exception as exc:  # pragma: no cover
        return missing_inputs_fatal(ENV_FAMILY, slug, hint=f"librosa unavailable: {exc}")

    y, sr = librosa.load(str(drums_path), sr=22050, mono=True)
    duration_ms = int(round(len(y) / sr * 1000))
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, backtrack=True, units="frames")
    onsets = list(librosa.frames_to_time(onset_frames, sr=sr))
    if not onsets:
        return build_envelope(
            ENV_FAMILY, slug, items=[], duration_ms=duration_ms,
            generator="drum-pattern@drums-onsets(no-onsets)",
        )

    beats_per_bar = _beats_per_bar(allin1)
    steps = beats_per_bar * SUBBEATS_PER_BEAT
    bars = _bar_step_vectors(onsets, downbeats, steps)
    if not bars:
        return build_envelope(
            ENV_FAMILY, slug, items=[], duration_ms=duration_ms,
            generator="drum-pattern@drums-onsets(no-bars)",
        )

    run_start, run_end = _longest_similar_run(bars)
    run = bars[run_start:run_end]
    if len(run) < 2:
        return build_envelope(
            ENV_FAMILY, slug, items=[], duration_ms=duration_ms,
            generator="drum-pattern@drums-onsets(no-repeat)",
        )

    # Canonical pattern: steps firing in >= STEP_HIT_FRACTION of the run's bars.
    n_bars = len(run)
    fired = [0] * steps
    for _, _, counts in run:
        for s in range(steps):
            if counts[s] > 0:
                fired[s] += 1
    highlighted = [s for s in range(steps) if fired[s] >= STEP_HIT_FRACTION * n_bars]

    cycle_start_ms = int(round(run[0][0] * 1000))
    cycle_dur_ms = int(round(sum(b[1] for b in run) / n_bars * 1000))  # mean bar length
    # Clamp the repeated region inside the track.
    max_repeats = max(1, (duration_ms - cycle_start_ms) // max(1, cycle_dur_ms))
    repeat_count = int(min(n_bars, max_repeats))

    item = {
        "start_ms": cycle_start_ms,
        "duration_ms": cycle_dur_ms,
        "label": f"Drum groove ({len(highlighted)} hits/bar)",
        "repeat_count": repeat_count,
        "highlighted_beats": highlighted or None,
    }
    return build_envelope(
        ENV_FAMILY, slug, items=[item], duration_ms=duration_ms,
        generator=f"drum-pattern@drums-onsets(bars={n_bars},steps={steps})",
    )


def run(slug: str) -> dict:
    env = generate(slug)
    write_envelope(env)
    return env


if __name__ == "__main__":
    from generators.common import curated_path

    if len(sys.argv) < 2:
        print("usage: python -m generators.drum_pattern <slug>")
        raise SystemExit(2)
    _env = run(sys.argv[1])
    print(f"{sys.argv[1]}: {_env['stats']} → {curated_path(ENV_FAMILY, sys.argv[1])}")
