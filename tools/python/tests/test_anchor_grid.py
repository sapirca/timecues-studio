"""Python parity tests for the anchor-aware grid math.

Mirrors the TypeScript tests in
``web-app/src/utils/beatGrid.test.ts`` so a future change that touches one
language will catch any drift in the other.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure tools/python is on sys.path so `import custom_api` works when pytest
# is invoked from the repo root.
_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from custom_api import DetectionContext, TempoAnchor  # noqa: E402


def _bare_ctx(bpm: float, grid_offset_ms: int = 0, anchors=()) -> DetectionContext:
    """Build a DetectionContext skeleton with only the grid fields set.
    Audio / features are stubbed out — only the math helpers are exercised
    so we never touch librosa or the full pipeline."""
    ctx = object.__new__(DetectionContext)
    object.__setattr__(ctx, "bpm", bpm)
    object.__setattr__(ctx, "grid_offset_ms", grid_offset_ms)
    object.__setattr__(ctx, "tempo_anchors", tuple(anchors))
    return ctx


# Same 3-anchor fixture as the TS suite:
#   - Anchor 0 at  0.0s, 120 BPM  (segment 0: 40 beats)
#   - Anchor 1 at 20.0s, 100 BPM  (segment 1: 50 beats)
#   - Anchor 2 at 50.0s, 140 BPM
THREE = (
    TempoAnchor(timestamp_ms=0,     bpm=120.0),
    TempoAnchor(timestamp_ms=20000, bpm=100.0),
    TempoAnchor(timestamp_ms=50000, bpm=140.0),
)


# ─── Static mode unchanged ───────────────────────────────────────────────────

def test_static_bpm_at_falls_back_to_global():
    ctx = _bare_ctx(120.0)
    assert ctx.bpm_at(5000) == 120.0

def test_static_beat_index_legacy_formula():
    ctx = _bare_ctx(120.0)
    assert ctx.beat_index_at(500) == 1
    assert ctx.beat_index_at(2000) == 4

def test_static_snap_to_beat():
    ctx = _bare_ctx(120.0)
    # Nearest beat at 120 BPM (period 500 ms).
    assert ctx.snap_to_beat_ms(240) == 0
    assert ctx.snap_to_beat_ms(260) == 500


# ─── Anchor traversal ────────────────────────────────────────────────────────

def test_bpm_at_routes_to_segment():
    ctx = _bare_ctx(120.0, 0, THREE)
    assert ctx.bpm_at(10000) == 120.0
    assert ctx.bpm_at(35000) == 100.0
    assert ctx.bpm_at(60000) == 140.0

def test_beat_index_cumulative():
    ctx = _bare_ctx(120.0, 0, THREE)
    # 10s into seg 0 at 120 BPM → 20 beats.
    assert ctx.beat_index_at(10000) == 20
    # 35s = 20s + 15s into seg 1 at 100 BPM → 40 + 25 = 65.
    assert ctx.beat_index_at(35000) == 65
    # Exactly at anchor 2 → 90.
    assert ctx.beat_index_at(50000) == 90


# ─── Snap-to-grid boundary ───────────────────────────────────────────────────

def test_snap_near_manual_anchor():
    manual = (
        TempoAnchor(timestamp_ms=0,     bpm=120.0),
        TempoAnchor(timestamp_ms=20000, bpm=100.0),
    )
    ctx = _bare_ctx(120.0, 0, manual)
    # Seg 1's beat 1 (100 BPM, dBeat=600ms) is at 20.6s.
    assert ctx.snap_to_beat_ms(20550) == 20600
    assert ctx.snap_to_beat_ms(20650) == 20600

def test_snap_before_anchor_uses_prev_segment_tempo():
    manual = (
        TempoAnchor(timestamp_ms=0,     bpm=120.0),
        TempoAnchor(timestamp_ms=20000, bpm=100.0),
    )
    ctx = _bare_ctx(120.0, 0, manual)
    # 19.5s inside seg 0 (120 BPM, dBeat=500ms) — already on a beat.
    assert ctx.snap_to_beat_ms(19500) == 19500
    # 19.4s → nearest beat is 19.5s under 120 BPM.
    assert ctx.snap_to_beat_ms(19400) == 19500
