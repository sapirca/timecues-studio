"""Generate the `cues` curated output: sparse, salient points of interest.

NOT every onset. Cues are the "decorations" — where something *enters* or
*changes* in a way a listener notices. We assemble candidates from the
caches that already localize such events, then aggressively thin them:

  Candidate sources (any subset that's cached)
    * PANNs (other/mix)   — the START of an instrument-class span = an
                            instrument entrance ("piano in", "guitar in").
                            First entrance per class + re-entrances after a
                            long gap.
    * lyrics (vocals/mix) — each line start = a vocal-phrase entrance.
    * pattern/locomotif   — the first occurrence of each motif = a hook /
                            riff entrance.

  Curation
    * Snap to the nearest beat (allin1 beatPositions).
    * DROP anything coinciding with a section boundary — those are structural
      and belong to `phrases`, keeping cues a distinct, non-structural layer.
    * Fuse near-duplicates, then greedily keep the highest-salience cues
      subject to a minimum spacing, capped by track length. Sparse by design.

Run:  python -m generators.cues <slug>     (from tools/python/)
"""

from __future__ import annotations

import bisect

from generators.common import (
    build_envelope,
    detect_cache,
    load_allin1,
    missing_inputs_fatal,
    near,
    sec_to_ms,
    write_envelope,
)

FAMILY = "cues"
# A cue within this of a section boundary is treated as structural and dropped.
SECTION_TOL_MS = 600
# Candidates closer than this are fused into one cue.
FUSE_MS = 350
# Minimum spacing between kept cues — keeps the layer sparse.
MIN_GAP_MS = 2000
# Re-count an instrument class as a fresh entrance only after this much silence.
REENTRY_GAP_MS = 8000
# Cap density: at most one cue per this many ms of track (plus a hard ceiling).
CUE_DENSITY_MS = 6000
HARD_CAP = 80


def _snap(t_ms: int, beats_ms: list[int]) -> int:
    if not beats_ms:
        return t_ms
    i = bisect.bisect_left(beats_ms, t_ms)
    cands = []
    if i < len(beats_ms):
        cands.append(beats_ms[i])
    if i > 0:
        cands.append(beats_ms[i - 1])
    return min(cands, key=lambda b: abs(b - t_ms))


def _panns_entrances(payload: dict, duration_ms: int) -> list[dict]:
    """First start per class + re-entrances after a long gap."""
    last_end: dict[str, int] = {}
    out: list[dict] = []
    for s in sorted(payload.get("spans", []) or [], key=lambda x: x.get("start", 0.0)):
        try:
            start_ms = sec_to_ms(s["start"], duration_ms=duration_ms)
            end_ms = sec_to_ms(s["end"], duration_ms=duration_ms)
        except (KeyError, TypeError, ValueError):
            continue
        label = str(s.get("label") or "instrument")
        prev = last_end.get(label)
        if prev is None or (start_ms - prev) >= REENTRY_GAP_MS:
            conf = s.get("confidence")
            out.append({
                "time_ms": start_ms,
                "label": f"{label} in",
                "weight": float(conf) if isinstance(conf, (int, float)) else 0.5,
            })
        last_end[label] = max(end_ms, last_end.get(label, 0))
    return out


def _lyric_entrances(payload: dict, duration_ms: int) -> list[dict]:
    out: list[dict] = []
    for ln in payload.get("lines", []) or []:
        try:
            t_ms = sec_to_ms(ln["time"], duration_ms=duration_ms)
        except (KeyError, TypeError, ValueError):
            continue
        out.append({"time_ms": t_ms, "label": "vocal phrase", "weight": 0.55})
    return out


def _motif_entrances(payload: dict, duration_ms: int) -> list[dict]:
    """First occurrence of each motif set."""
    seen: set[int] = set()
    out: list[dict] = []
    for p in sorted(payload.get("patterns", []) or [], key=lambda x: x.get("start", 0.0)):
        mid = p.get("motif_id")
        if mid in seen:
            continue
        seen.add(mid)
        try:
            t_ms = sec_to_ms(p["start"], duration_ms=duration_ms)
        except (KeyError, TypeError, ValueError):
            continue
        conf = p.get("confidence")
        out.append({
            "time_ms": t_ms,
            "label": f"motif {mid}",
            "weight": float(conf) if isinstance(conf, (int, float)) else 0.6,
        })
    return out


def _fuse(cands: list[dict]) -> list[dict]:
    """Merge candidates within FUSE_MS: combine labels, keep max weight."""
    cands.sort(key=lambda c: c["time_ms"])
    fused: list[dict] = []
    for c in cands:
        if fused and c["time_ms"] - fused[-1]["time_ms"] <= FUSE_MS:
            prev = fused[-1]
            labels = {l.strip() for l in (prev["label"] + ", " + c["label"]).split(",")}
            prev["label"] = ", ".join(sorted(labels))
            prev["weight"] = max(prev["weight"], c["weight"])
        else:
            fused.append(dict(c))
    return fused


def generate(slug: str) -> dict:
    """Build (and return) the cues envelope for `slug`. Writes nothing."""
    panns, panns_stem = detect_cache("panns", slug, "panns-cnn14", prefer_stems=("other", None))
    lyrics, lyrics_stem = detect_cache("lyrics", slug, "whisper-base", prefer_stems=("vocals", None))
    if lyrics is None:
        lyrics, lyrics_stem = detect_cache("lyrics", slug, "ctc-forced-aligner", prefer_stems=("vocals", None))
    motifs, motif_stem = detect_cache("pattern", slug, "locomotif", prefer_stems=(None, "other"))

    if panns is None and lyrics is None and motifs is None:
        return missing_inputs_fatal(
            FAMILY, slug,
            hint=(
                "no salience sources cached (PANNs / lyrics / locomotif). On the "
                "VM run those detect endpoints first; cues are assembled from "
                "their instrument/vocal/motif entrances."
            ),
        )

    allin1 = load_allin1(slug)
    duration_ms = 0
    beats_ms: list[int] = []
    section_ms: list[int] = []
    if allin1:
        duration_ms = sec_to_ms(allin1.get("duration") or 0.0)
        beats_ms = sorted(sec_to_ms(b) for b in (allin1.get("beatPositions") or []))
        section_ms = [sec_to_ms(s.get("time", 0.0)) for s in (allin1.get("sections") or [])]
    for p in (panns, lyrics, motifs):
        if p:
            duration_ms = max(duration_ms, sec_to_ms(p.get("duration") or 0.0))

    sources: list[str] = []
    cands: list[dict] = []
    if panns is not None:
        cands += _panns_entrances(panns, duration_ms)
        sources.append(f"panns:{panns_stem}")
    if lyrics is not None:
        cands += _lyric_entrances(lyrics, duration_ms)
        sources.append(f"lyrics:{lyrics_stem}")
    if motifs is not None:
        cands += _motif_entrances(motifs, duration_ms)
        sources.append(f"motif:{motif_stem}")

    # Snap to beat, then drop structural (section-coinciding) candidates.
    for c in cands:
        c["time_ms"] = _snap(c["time_ms"], beats_ms)
    cands = [c for c in cands if not near(c["time_ms"], section_ms, SECTION_TOL_MS)]

    fused = _fuse(cands)

    # Greedy sparse selection: highest salience first, enforce MIN_GAP_MS.
    cap = min(HARD_CAP, max(1, duration_ms // CUE_DENSITY_MS)) if duration_ms else HARD_CAP
    kept: list[dict] = []
    for c in sorted(fused, key=lambda x: x["weight"], reverse=True):
        if len(kept) >= cap:
            break
        if all(abs(c["time_ms"] - k["time_ms"]) >= MIN_GAP_MS for k in kept):
            kept.append(c)
    kept.sort(key=lambda x: x["time_ms"])

    items = [
        {
            "time_ms": c["time_ms"],
            "label": c["label"],
            "description": None,
            "intensity": max(0.0, min(1.0, c["weight"])),
            "candidates": None,
        }
        for c in kept
    ]
    return build_envelope(
        FAMILY, slug, items=items, duration_ms=duration_ms,
        generator=f"cues@{'+'.join(sources)}",
    )


def run(slug: str) -> dict:
    env = generate(slug)
    write_envelope(env)
    return env


if __name__ == "__main__":
    import sys

    from generators.common import curated_path

    if len(sys.argv) < 2:
        print("usage: python -m generators.cues <slug>")
        raise SystemExit(2)
    _env = run(sys.argv[1])
    print(f"{sys.argv[1]}: {_env['stats']} → {curated_path(FAMILY, sys.argv[1])}")
