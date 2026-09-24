"""Score every beat tracker against this corpus's own curated grids.

Why this exists
---------------
The published F-measures do not answer the question we actually have.
Beat This! reports 89.1 beat / 78.3 downbeat on GTZAN and wins on 18
datasets — none of which is EDM. The one EDM evaluation that exists
(Raveform, TISMIR 2025) measured madmom at 0.947 beat / 0.669 downbeat,
against 0.941 / 0.805 on pop: on four-on-the-floor the beats are nearly free
and the DOWNBEATS fall apart. Raveform notes madmom was trained on ten
datasets "covering various genres except EDM", and Beat This!'s training set
skews classical, jazz and pop, so neither number transfers here.

What does transfer is a measurement on the actual corpus. The curated grids
in data/song-info are already beat annotation — stored as a rule rather than
a list — so expanding them (grid_truth.expand) gives ground truth for free.

What it reports, and why those metrics
--------------------------------------
  beat F1        ±70 ms, the field's convention. Expect this to be high and
                 uninformative on sequenced music.
  downbeat F1    the number that actually decides whether a fitted segment's
                 bar 1 lands in the right place.
  CMLt / AMLt    continuity: the longest stretch the tracker stays locked on,
                 at the correct metrical level (CMLt) or allowing half/double
                 and offbeat (AMLt). These matter here because the Beat This!
                 paper concedes that dropping the DBN "hurts the CMLt and
                 AMLt metrics" — it wins F-measure while being LESS
                 temporally consistent, and on a genre with a rigid grid that
                 trade-off may not be the one we want.
  AMLt - CMLt    how much of the tracker's accuracy is only available if you
                 forgive an octave or offbeat error. A big gap means it heard
                 the pulse but counted it at the wrong level.

Usage
-----
  python tools/python/beat_eval.py                 # every cached tracker
  python tools/python/beat_eval.py --slug <slug>   # one song
  python tools/python/beat_eval.py --json out.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grid_truth import expand, is_trustworthy  # noqa: E402
from paths import (  # noqa: E402
    BEATNET_OUTPUTS_DIR, BEAT_THIS_OUTPUTS_DIR, BEAT_TRANSFORMER_OUTPUTS_DIR,
    BPM_DETECTIONS_DIR, DATA_DIR, DEFAULT_DATA_DIR, find_audio,
)

# ±70 ms, the standard beat-tracking tolerance. Every published number this
# is compared against uses it, so we do too.
TOLERANCE = 0.07


def _song_info(slug: str) -> "dict | None":
    """The curated grid for `slug`, user tree first then shipped defaults."""
    for base in (DATA_DIR, DEFAULT_DATA_DIR):
        path = base / "song-info" / f"{slug}.json"
        if path.is_file():
            try:
                return json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                return None
    return None


def _duration(slug: str, fallback: float = 0.0) -> float:
    """Audio duration in seconds; 0.0 when it can't be read."""
    audio = find_audio(slug)
    if audio is None:
        return fallback
    try:
        import librosa
        return float(librosa.get_duration(path=str(audio)))
    except Exception:
        return fallback


def _read(path: Path) -> "dict | None":
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def load_predictions(slug: str) -> "dict[str, dict]":
    """Every tracker's cached output for `slug`, keyed by detector name.

    Reads the caches rather than calling the servers: a scoring run should be
    reproducible and instant, and re-running detection is a separate, slow,
    explicitly-requested act (POST .../detect with force).
    """
    out: "dict[str, dict]" = {}

    payload = _read(BEAT_THIS_OUTPUTS_DIR / f"{slug}.json")
    result = (payload or {}).get("result") or {}
    if result.get("ok"):
        out["beat-this"] = {
            "beats":     result.get("beat_times") or [],
            "downbeats": result.get("downbeats") or [],
        }

    payload = _read(BEAT_TRANSFORMER_OUTPUTS_DIR / f"{slug}.json")
    result = (payload or {}).get("result") or {}
    if result.get("ok"):
        out["beat-transformer"] = {
            "beats":     result.get("beat_times") or [],
            "downbeats": result.get("downbeats") or [],
        }

    payload = _read(BEATNET_OUTPUTS_DIR / f"{slug}.json")
    result = (payload or {}).get("result") or {}
    if result.get("ok"):
        out["beatnet"] = {
            "beats":     result.get("beat_times") or [],
            "downbeats": result.get("downbeats") or [],
        }

    # bpm_server holds several detectors in one file; take the ones that
    # return beat times at all. madmom-tempo and the librosa tempo estimators
    # return a scalar BPM with no beats, so there is nothing to score.
    payload = _read(BPM_DETECTIONS_DIR / f"{slug}.json")
    for algorithm in (payload or {}).get("algorithms") or []:
        if not algorithm.get("ok") or not algorithm.get("beat_times"):
            continue
        out[algorithm["source"]] = {
            "beats":     algorithm.get("beat_times") or [],
            "downbeats": algorithm.get("downbeats") or [],
        }

    return out


def median_bpm(times: "list[float]") -> "float | None":
    """Tempo implied by a beat list, from the median inter-beat interval.

    Median, not mean: one dropped beat doubles a single interval, and a mean
    would smear that across the whole answer.
    """
    if len(times) < 2:
        return None
    import statistics
    ibis = [b - a for a, b in zip(times, times[1:])]
    median = statistics.median(ibis)
    return round(60.0 / median, 2) if median > 0 else None


def score(reference: "list[float]", estimate: "list[float]") -> "dict | None":
    """mir_eval beat scores for one (reference, estimate) pair.

    Returns None when either side is too short to score. mir_eval's own
    convention is to discard the first 5 seconds (trim_beats) because the
    opening of a track is where trackers are still locking on and where
    annotators are least consistent; f_measure and continuity both do this
    internally, so the numbers here stay directly comparable to published
    ones.
    """
    import mir_eval

    if len(reference) < 2 or len(estimate) < 2:
        return None

    ref = mir_eval.beat.util.np.asarray(reference, dtype=float)
    est = mir_eval.beat.util.np.asarray(estimate, dtype=float)
    try:
        f1 = mir_eval.beat.f_measure(ref, est, f_measure_threshold=TOLERANCE)
        cmlc, cmlt, amlc, amlt = mir_eval.beat.continuity(ref, est)
    except Exception:
        return None

    return {
        "f_measure": round(float(f1), 4),
        "cmlt":      round(float(cmlt), 4),
        "amlt":      round(float(amlt), 4),
        "n_ref":     len(reference),
        "n_est":     len(estimate),
    }


def inter_tracker_agreement(predictions: "dict[str, dict]") -> "float | None":
    """Mean pairwise beat F1 among the trackers themselves, ignoring truth.

    This is the check that keeps the whole exercise honest. The trackers are
    independent — different architectures, different training sets, different
    decades — so when they all agree with each other and all disagree with
    the curated grid, the grid is the outlier, not three separate models that
    happened to fail identically.

    Without this the report silently blames trackers for a song whose tempo
    was typed in as a round number and never aligned, and the resulting
    ranking is noise.
    """
    names = sorted(predictions)
    if len(names) < 2:
        return None
    scores = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            result = score(predictions[a]["beats"], predictions[b]["beats"])
            if result:
                scores.append(result["f_measure"])
    return round(sum(scores) / len(scores), 4) if scores else None


# A grid the trackers unanimously contradict cannot serve as ground truth.
# Both thresholds are deliberately far apart so the verdict only fires on an
# unambiguous case: near-perfect agreement between models, and agreement with
# the grid that is worse than a coin flip.
CONSENSUS_MIN = 0.85
TRUTH_MAX = 0.70


def verdict(trackers: dict, consensus: "float | None") -> "tuple[str, str]":
    """Turn a song's scores into a verdict a curator can act on.

    The three states mean different work, which is the whole reason to name
    them instead of showing four raw numbers:

      confirmed  the models agree with this grid. Nothing to do.
      disputed   the models agree with EACH OTHER and not with the grid.
                 Three independent architectures do not fail identically, so
                 the grid is the outlier. Re-curate.
      octave     low F1 but high AMLt: AMLt forgives half/double time and
                 offbeat, so the grid is on the right pulse counted at a
                 different level. A judgment call, NOT an error — this is why
                 F1 alone would send a curator to "fix" a correct grid.
    """
    scored = [t["beat"] for t in trackers.values() if t.get("beat")]
    if not scored:
        return "unscorable", "no tracker output to compare against"

    best_f = max(t["f_measure"] for t in scored)
    best_amlt = max(t["amlt"] for t in scored)
    mean_f = sum(t["f_measure"] for t in scored) / len(scored)

    if best_f >= 0.9:
        return "confirmed", "the trackers agree with this grid"
    if best_amlt >= 0.75 and best_f < 0.6:
        return "octave", (
            "the pulse is right but counted at a different metrical level — "
            "half- or double-time. Probably not an error"
        )
    if consensus is not None and consensus >= CONSENSUS_MIN and mean_f <= TRUTH_MAX:
        return "disputed", (
            f"the trackers agree with each other ({consensus:.2f}) far more "
            f"than with this grid ({mean_f:.2f})"
        )
    return "weak", "no tracker matches this grid well, and they disagree with each other too"


def suggest(predictions: "dict[str, dict]") -> dict:
    """What the trackers collectively think the grid should be.

    Median BPM across trackers rather than mean: one detector locking onto
    double-time should not drag the number halfway there. The downbeat comes
    from whichever tracker actually reports downbeats, in descending order of
    how well each scored on this corpus (see the table in beat_eval's docs).
    """
    import statistics

    bpms = []
    for pred in predictions.values():
        beats = pred.get("beats") or []
        if len(beats) > 10:
            ibis = [b - a for a, b in zip(beats, beats[1:])]
            median_ibi = statistics.median(ibis)
            if median_ibi > 0:
                bpms.append(60.0 / median_ibi)

    first_downbeat = None
    for name in ("beat-transformer", "beat-this", "madmom-dbn-downbeats", "beatnet"):
        downbeats = (predictions.get(name) or {}).get("downbeats") or []
        if downbeats:
            first_downbeat = float(downbeats[0])
            break

    return {
        "bpm":           round(statistics.median(bpms), 2) if bpms else None,
        "firstDownbeat": round(first_downbeat, 3) if first_downbeat is not None else None,
    }


def score_grid(slug: str, info: dict, duration: "float | None" = None) -> dict:
    """Score one grid — as given, not as stored — against the cached trackers.

    `info` is a SongInfo-shaped dict, so a caller can pass the grid currently
    being EDITED rather than the one last written to disk. That is what makes
    this usable live: drag the downbeat, watch the score move.
    """
    trusted, caveat = is_trustworthy(info)
    if not trusted:
        return {"ok": False, "slug": slug, "reason": caveat}

    if duration is None or duration <= 0:
        duration = _duration(slug)
    if duration <= 0:
        return {"ok": False, "slug": slug, "reason": "audio not found or unreadable"}

    predictions = load_predictions(slug)
    if not predictions:
        return {"ok": False, "slug": slug,
                "reason": "no tracker has run on this song yet"}

    ref_beats, ref_downbeats = expand(info, duration)
    trackers = {}
    for name, pred in sorted(predictions.items()):
        trackers[name] = {
            "beat":     score(ref_beats, pred["beats"]),
            "downbeat": score(ref_downbeats, pred["downbeats"]),
            # The tempo this tracker actually heard. An F-measure of 0.02
            # means "disagrees with your grid" without saying how: a tracker
            # can have the tempo exactly right and still score near zero
            # because the phase is off by half a beat. The BPM separates
            # those two, and is the number a curator can act on.
            "bpm":      median_bpm(pred["beats"]),
        }

    consensus = inter_tracker_agreement(predictions)
    state, reason = verdict(trackers, consensus)

    return {
        "ok":          True,
        "slug":        slug,
        "duration":    round(float(duration), 3),
        "caveat":      caveat or None,
        "consensus":   consensus,
        "verdict":     state,
        "reason":      reason,
        "refBeats":    len(ref_beats),
        "trackers":    trackers,
        "suggestion":  suggest(predictions),
    }


def evaluate_song(slug: str) -> "dict | None":
    """Score every cached tracker for one song against its curated grid."""
    info = _song_info(slug)
    if info is None:
        return None

    trusted, caveat = is_trustworthy(info)
    if not trusted:
        return {"slug": slug, "skipped": caveat}

    duration = _duration(slug)
    if duration <= 0:
        return {"slug": slug, "skipped": "audio not found or unreadable"}

    ref_beats, ref_downbeats = expand(info, duration)
    predictions = load_predictions(slug)
    if not predictions:
        return {"slug": slug, "skipped": "no cached tracker output"}

    trackers = {}
    for name, pred in sorted(predictions.items()):
        trackers[name] = {
            "beat":     score(ref_beats, pred["beats"]),
            "downbeat": score(ref_downbeats, pred["downbeats"]),
        }

    consensus = inter_tracker_agreement(predictions)
    truths = [t["beat"]["f_measure"] for t in trackers.values() if t.get("beat")]
    vs_truth = round(sum(truths) / len(truths), 4) if truths else None

    disputed = (consensus is not None and vs_truth is not None
                and consensus >= CONSENSUS_MIN and vs_truth <= TRUTH_MAX)

    return {
        "slug":        slug,
        "duration":    round(duration, 3),
        "bpm":         info.get("bpm"),
        "time_signature": info.get("timeSignature"),
        "segments":    len(info.get("gridSegments") or []) + 1,
        "caveat":      caveat or None,
        "n_ref_beats": len(ref_beats),
        "consensus":   consensus,
        "vs_truth":    vs_truth,
        "disputed":    disputed,
        "trackers":    trackers,
    }


def aggregate(songs: "list[dict]", *, trusted_only: bool = False) -> "dict[str, dict]":
    """Mean scores per tracker across songs.

    Unweighted per song, not per beat: a 6-minute track should not outvote a
    3-minute one when the question is "which tracker handles our material".
    """
    totals: "dict[str, dict]" = {}
    for song in songs:
        if trusted_only and song.get("disputed"):
            continue
        for name, scores in (song.get("trackers") or {}).items():
            bucket = totals.setdefault(name, {
                "beat_f": [], "beat_cmlt": [], "beat_amlt": [],
                "down_f": [], "songs": 0,
            })
            bucket["songs"] += 1
            if scores.get("beat"):
                bucket["beat_f"].append(scores["beat"]["f_measure"])
                bucket["beat_cmlt"].append(scores["beat"]["cmlt"])
                bucket["beat_amlt"].append(scores["beat"]["amlt"])
            if scores.get("downbeat"):
                bucket["down_f"].append(scores["downbeat"]["f_measure"])

    out = {}
    for name, bucket in totals.items():
        def mean(key):
            values = bucket[key]
            return round(sum(values) / len(values), 4) if values else None
        out[name] = {
            "songs":        bucket["songs"],
            "beat_f":       mean("beat_f"),
            "beat_cmlt":    mean("beat_cmlt"),
            "beat_amlt":    mean("beat_amlt"),
            "downbeat_f":   mean("down_f"),
            "downbeat_n":   len(bucket["down_f"]),
        }
    return out


def _fmt(value) -> str:
    return "  —  " if value is None else f"{value:.3f}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--slug", help="score one song instead of all")
    parser.add_argument("--json", help="also write the full result to this file")
    args = parser.parse_args()

    if args.slug:
        slugs = [args.slug]
    else:
        from paths import list_song_slugs
        slugs = list_song_slugs()

    songs, skipped = [], []
    for slug in slugs:
        result = evaluate_song(slug)
        if result is None:
            skipped.append((slug, "no song-info"))
        elif "skipped" in result:
            skipped.append((slug, result["skipped"]))
        else:
            songs.append(result)

    if not songs:
        print("Nothing to score.", file=sys.stderr)
        for slug, why in skipped:
            print(f"  {slug}: {why}", file=sys.stderr)
        return 1

    print(f"\nScored {len(songs)} song(s) against their curated grids "
          f"(±{TOLERANCE * 1000:.0f} ms)\n")

    for song in songs:
        header = (f"{song['slug']}  —  {song['bpm']} BPM, {song['time_signature']}, "
                  f"{song['segments']} segment(s)")
        print(header)
        if song["caveat"]:
            print(f"  ⚠  {song['caveat']}")
        if song.get("disputed"):
            print(f"  ✗  DISPUTED GRID — the trackers agree with each other "
                  f"({song['consensus']:.3f}) far more than any of them agrees "
                  f"with this grid ({song['vs_truth']:.3f}).")
            print( "     Three independent models do not fail identically. "
                  "Re-curate before trusting a score here.")
        print(f"  {'tracker':<22} {'beat F1':>8} {'CMLt':>7} {'AMLt':>7} "
              f"{'down F1':>8}")
        for name, scores in song["trackers"].items():
            beat = scores.get("beat") or {}
            down = scores.get("downbeat") or {}
            print(f"  {name:<22} {_fmt(beat.get('f_measure')):>8} "
                  f"{_fmt(beat.get('cmlt')):>7} {_fmt(beat.get('amlt')):>7} "
                  f"{_fmt(down.get('f_measure')):>8}")
        print()

    disputed = [song for song in songs if song.get("disputed")]
    trusted = [song for song in songs if not song.get("disputed")]

    def table(title: str, summary: "dict[str, dict]") -> None:
        print("─" * 78)
        print(f"{title:<22} {'beat F1':>8} {'CMLt':>7} {'AMLt':>7} {'down F1':>8}")
        for name, scores in sorted(summary.items(),
                                   key=lambda kv: -(kv[1]["downbeat_f"] or -1)):
            print(f"  {name:<20} {_fmt(scores['beat_f']):>8} "
                  f"{_fmt(scores['beat_cmlt']):>7} {_fmt(scores['beat_amlt']):>7} "
                  f"{_fmt(scores['downbeat_f']):>8}"
                  f"   ({scores['songs']} songs, {scores['downbeat_n']} w/ downbeats)")

    summary = aggregate(songs, trusted_only=True)
    table(f"MEAN · {len(trusted)} trusted", summary)

    if disputed:
        print()
        table(f"MEAN · all {len(songs)} incl. disputed", aggregate(songs))
        print(f"\n  {len(disputed)} grid(s) disputed by tracker consensus — "
              f"these measure the GRID, not the tracker:")
        for song in disputed:
            print(f"    {song['slug']}  (models agree {song['consensus']:.2f}, "
                  f"grid agrees {song['vs_truth']:.2f})")

    if skipped:
        print(f"\nSkipped {len(skipped)}:")
        for slug, why in skipped:
            print(f"  {slug}: {why}")

    if args.json:
        Path(args.json).write_text(json.dumps(
            {"tolerance": TOLERANCE, "songs": songs, "summary": summary,
             "summary_all": aggregate(songs),
             "skipped": [{"slug": s, "reason": w} for s, w in skipped]},
            indent=2))
        print(f"\nWrote {args.json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
