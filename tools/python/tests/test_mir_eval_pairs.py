"""Equivalence test for POST /api/mir-eval/pairs.

Asserts that the endpoint's boundary P/R/F numbers are bit-equivalent (to full
float precision) to a direct in-process call of `mir_eval.segment.detection(...,
trim=True)` on the same input. Covers both:

  * the in-process `_eval_pair` wrapper (catches future refactors that would
    change the entry point, trim flag, or interval construction), and

  * the HTTP path end-to-end (catches JSON serialization / handler bugs).
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.request
from http.server import HTTPServer
from pathlib import Path
from typing import Iterable

import mir_eval
import mir_eval.segment
import numpy as np
import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from mir_eval_server import Handler, _eval_pair, _times_to_intervals  # noqa: E402


# ─── Fixtures ────────────────────────────────────────────────────────────────

# (ref_times, est_times, tolerance, track_duration) — covers perfect match,
# partial match, no match, out-of-order input, near-tolerance boundary, dense.
CASES: list[tuple[list[float], list[float], float, float]] = [
    # Perfect match
    ([10.0, 30.0, 50.0], [10.0, 30.0, 50.0], 0.5, 60.0),
    # Within-tolerance shift
    ([10.0, 30.0, 50.0], [10.3, 29.8, 50.1], 0.5, 60.0),
    # All misses
    ([10.0, 30.0, 50.0], [12.0, 32.0, 52.0], 0.5, 60.0),
    # Asymmetric counts (extra est / missing ref)
    ([10.0, 30.0, 50.0], [10.1, 20.0, 30.1, 40.0, 50.1], 0.5, 60.0),
    # Out-of-order times (must be tolerant of unsorted input)
    ([30.0, 10.0, 50.0], [50.1, 10.2, 29.9], 0.5, 60.0),
    # Tight tolerance
    ([10.0, 30.0, 50.0], [10.05, 30.5, 50.0], 0.1, 60.0),
    # Loose tolerance
    ([10.0, 30.0, 50.0], [15.0, 35.0, 45.0], 3.0, 60.0),
    # Single boundary each
    ([45.0], [45.2], 0.5, 90.0),
    # Long track, dense boundaries
    (list(np.linspace(5.0, 295.0, 30)),
     list(np.linspace(5.1, 295.1, 30)), 0.5, 300.0),
]


def _direct_mir_eval(ref_times: Iterable[float], est_times: Iterable[float],
                     tolerance: float, track_duration: float) -> tuple[float, float, float]:
    """Call `mir_eval.segment.detection(trim=True)` directly on padded intervals."""
    ref_intervals = _times_to_intervals(ref_times, track_duration)
    est_intervals = _times_to_intervals(est_times, track_duration)
    p, r, f = mir_eval.segment.detection(
        ref_intervals, est_intervals, window=tolerance, trim=True,
    )
    return float(p), float(r), float(f)


# ─── Unit test: in-process wrapper matches direct mir_eval call ──────────────


@pytest.mark.parametrize("ref,est,tol,dur", CASES)
def test_eval_pair_matches_direct_mir_eval(ref, est, tol, dur):
    """`_eval_pair` must return exactly what `mir_eval.segment.detection(trim=True)`
    returns when called with the same intervals — to full float precision."""
    p_direct, r_direct, f_direct = _direct_mir_eval(ref, est, tol, dur)
    result = _eval_pair(ref, est, tol, dur)

    assert result["precision"] == p_direct
    assert result["recall"]    == r_direct
    assert result["fmeasure"]  == f_direct
    assert result["tolerance"] == tol
    assert result["refCount"]  == len(ref)
    assert result["estCount"]  == len(est)


@pytest.mark.parametrize("ref,est,tol,dur", CASES)
def test_eval_pair_nearest_neighbor_errors(ref, est, tol, dur):
    """`t2eErrors` and `e2tErrors` are nearest-neighbor distances in caller order."""
    result = _eval_pair(ref, est, tol, dur)
    ref_arr = np.asarray(ref, dtype=float)
    est_arr = np.asarray(est, dtype=float)
    expected_t2e = [float(np.min(np.abs(est_arr - r))) for r in ref_arr]
    expected_e2t = [float(np.min(np.abs(ref_arr - e))) for e in est_arr]
    assert result["t2eErrors"] == expected_t2e
    assert result["e2tErrors"] == expected_e2t


def test_eval_pair_empty_inputs_return_zero():
    """Empty ref or est returns all-zero scores without crashing."""
    for ref, est in [([], [10.0]), ([10.0], []), ([], [])]:
        r = _eval_pair(ref, est, 0.5, 60.0)
        assert r["precision"] == 0.0
        assert r["recall"]    == 0.0
        assert r["fmeasure"]  == 0.0


# ─── Edge cases that hit users in the auto-guess review flow ─────────────────


def test_eval_pair_single_boundary_at_zero():
    """A reference of just [0.0] is common after auto-guess (the track-start
    sentinel). Must not raise and must score sensibly against a matching est."""
    r = _eval_pair([0.0], [0.0], 0.5, 60.0)
    # After trim=True, the leading boundary at 0 is dropped from both sides;
    # the endpoint-only intervals contribute no boundary matches. What matters
    # is that the call doesn't raise and the response shape is intact.
    assert r["refCount"] == 1
    assert r["estCount"] == 1
    assert r["tolerance"] == 0.5


def test_eval_pair_tolerance_zero_only_exact_matches():
    """With tolerance 0, near-misses must count as misses."""
    r = _eval_pair([10.0, 30.0], [10.0, 30.001], 0.0, 60.0)
    # 30.001 is 1ms off — not an exact match.
    assert r["recall"] < 1.0
    # The exact match (10.0) means we should NOT score zero either.
    assert r["recall"] > 0.0


def test_eval_pair_tolerance_zero_perfect_match():
    """With tolerance 0 but identical times, recall/precision must hit 1.0."""
    r = _eval_pair([10.0, 30.0], [10.0, 30.0], 0.0, 60.0)
    assert r["precision"] == 1.0
    assert r["recall"]    == 1.0
    assert r["fmeasure"]  == 1.0


def test_eval_pair_very_asymmetric_counts():
    """5 refs vs 1 est: precision can be 1.0 (the one est is right) while
    recall must reflect 4/5 missed refs. Caught a class of bugs where
    division-by-zero or count confusion sneaks in."""
    r = _eval_pair(
        [10.0, 20.0, 30.0, 40.0, 50.0],
        [10.0],
        0.5,
        60.0,
    )
    assert r["refCount"] == 5
    assert r["estCount"] == 1
    # The one est hit one ref → precision should be high (after trim, the
    # endpoints are excluded but the inner match remains).
    assert 0.0 <= r["precision"] <= 1.0
    assert 0.0 <= r["recall"]    <= 1.0
    # Recall must NOT be 1.0 — we're missing 4 of 5 references.
    assert r["recall"] < 0.5


def test_eval_pair_boundary_at_track_duration():
    """A boundary at exactly track_duration is a legal edge case (end-of-song
    marker). _times_to_intervals must produce a valid interval array."""
    r = _eval_pair([60.0], [60.0], 0.5, 60.0)
    assert r["refCount"] == 1
    assert r["estCount"] == 1
    # No raise == pass. Specific numerics depend on mir_eval's trim behavior
    # at the endpoint and aren't pinned here.


# ─── End-to-end test: HTTP roundtrip matches direct mir_eval call ────────────


@pytest.fixture(scope="module")
def server():
    """Start the real `mir_eval_server` Handler on an ephemeral port."""
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    thread.join(timeout=2)


def _post_pairs(base_url: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{base_url}/api/mir-eval/pairs",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def test_http_pairs_matches_direct_mir_eval(server):
    """POST /api/mir-eval/pairs round-trip equals direct mir_eval calls."""
    pairs = [
        {"id": f"case_{i}", "refTimes": ref, "estTimes": est,
         "tolerance": tol, "trackDuration": dur}
        for i, (ref, est, tol, dur) in enumerate(CASES)
    ]
    resp = _post_pairs(server, {"pairs": pairs})
    results = resp["results"]

    for i, (ref, est, tol, dur) in enumerate(CASES):
        p_direct, r_direct, f_direct = _direct_mir_eval(ref, est, tol, dur)
        got = results[f"case_{i}"]
        assert got["precision"] == p_direct, f"case_{i} precision drift"
        assert got["recall"]    == r_direct, f"case_{i} recall drift"
        assert got["fmeasure"]  == f_direct, f"case_{i} fmeasure drift"
