"""Generate the `phrases` curated output: the structural phrases of a song.

Sources (all already on disk — no model run needed):
  * allin1.json  — functional sections ({time, endTime, type}) + the
                   downbeat grid (bar starts).

Output (boundary kind):
  * One CRITICAL boundary at each section start, labelled with the section
    type (Intro / Verse / Chorus / Drop / …). These are the coarse
    structural phrases the user cares about most.
  * One OPTIONAL boundary at every N-bar phrase start inside a section
    (default 4 bars), labelled "P1", "P2", … — the finer musical phrasing.
    Phrase marks that land on (or within tolerance of) a section start are
    dropped so the critical section boundary wins.

Run:  python -m generators.phrases <slug>        (from tools/python/)
"""

from __future__ import annotations

from typing import Optional

from generators.common import (
    build_envelope,
    curated_path,
    dedupe_sorted_ms,
    load_allin1,
    near,
    write_envelope,
)

FAMILY = "phrases"
DEFAULT_PHRASE_BARS = 4
# A phrase mark within this many ms of a section boundary is considered the
# same musical event — the section boundary (critical) is kept instead.
SECTION_TOL_MS = 250


def _sections_to_boundaries(sections: list[dict], duration_ms: int) -> tuple[list[dict], list[int]]:
    """Critical boundaries at each section start. Returns (items, section_ms)."""
    items: list[dict] = []
    section_ms: list[int] = []
    for s in sections:
        try:
            t_ms = int(round(float(s["time"]) * 1000))
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= t_ms <= duration_ms):
            continue
        label = str(s.get("type") or s.get("label") or "section")
        items.append({
            "time_ms": t_ms,
            "label": label,
            "importance": "critical",
            "candidates": None,
        })
        section_ms.append(t_ms)
    return items, section_ms


def _phrase_boundaries(
    downbeats_sec: list[float],
    duration_ms: int,
    section_ms: list[int],
    phrase_bars: int,
) -> list[dict]:
    """Optional boundaries every `phrase_bars` downbeats, skipping those that
    coincide with a section start."""
    items: list[dict] = []
    n = 0
    for i in range(0, len(downbeats_sec), max(1, phrase_bars)):
        try:
            t_ms = int(round(float(downbeats_sec[i]) * 1000))
        except (TypeError, ValueError):
            continue
        if not (0 <= t_ms <= duration_ms):
            continue
        n += 1
        if near(t_ms, section_ms, SECTION_TOL_MS):
            continue
        items.append({
            "time_ms": t_ms,
            "label": f"P{n}",
            "importance": "optional",
            "candidates": None,
        })
    return items


def generate(slug: str, *, phrase_bars: int = DEFAULT_PHRASE_BARS) -> dict:
    """Build (and return) the phrases envelope for `slug`. Writes nothing."""
    allin1 = load_allin1(slug)
    if allin1 is None:
        return build_envelope(
            FAMILY, slug, items=[], duration_ms=0,
            generator="phrases@allin1+grid",
            fatal={
                "type": "FileNotFoundError",
                "message": (
                    "no allin1.json cache for this slug under "
                    "algorithm-outputs/analysis/<slug>/. Run All-In-One first "
                    "(tools/run_allin1_batch.py)."
                ),
                "traceback": "",
            },
        )

    duration_ms = int(round(float(allin1.get("duration") or 0.0) * 1000))
    sections = allin1.get("sections") or []
    downbeats = allin1.get("downbeatPositions") or []

    section_items, section_ms = _sections_to_boundaries(sections, duration_ms)
    phrase_items = _phrase_boundaries(downbeats, duration_ms, section_ms, phrase_bars)

    # Merge, keeping section (critical) marks when a phrase mark duplicates one.
    all_items = section_items + phrase_items
    by_time: dict[int, dict] = {}
    for it in sorted(all_items, key=lambda x: (x["time_ms"], x["importance"] != "critical")):
        # First write for a timestamp wins; critical sorts before optional.
        by_time.setdefault(it["time_ms"], it)
    # Re-number the surviving optional phrase marks so labels stay contiguous.
    items = [by_time[t] for t in dedupe_sorted_ms(by_time.keys())]
    p = 0
    for it in items:
        if it["importance"] == "optional":
            p += 1
            it["label"] = f"P{p}"

    return build_envelope(
        FAMILY, slug, items=items, duration_ms=duration_ms,
        generator=f"phrases@allin1+grid(bars={phrase_bars})",
    )


def run(slug: str, *, phrase_bars: int = DEFAULT_PHRASE_BARS) -> dict:
    """Generate and persist the phrases envelope for `slug`."""
    env = generate(slug, phrase_bars=phrase_bars)
    write_envelope(env)
    return env


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: python -m generators.phrases <slug> [phrase_bars]")
        raise SystemExit(2)
    _slug = sys.argv[1]
    _bars: Optional[int] = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_PHRASE_BARS
    _env = run(_slug, phrase_bars=_bars or DEFAULT_PHRASE_BARS)
    print(f"{_slug}: {_env['stats']} → {curated_path(FAMILY, _slug)}")
