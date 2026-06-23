"""Generate the `instruments` curated output: per-instrument presence spans.

Two layers, merged into one span set (span kind):

  BASE (reliable)
    * Silero-VAD on the *vocals* stem → "vocals" presence spans. Running on
      the isolated stem makes voicing detection far cleaner than on the mix.

  NAMED (richer, probabilistic)
    * PANNs CNN14 on the *other* stem → one span per AudioSet instrument
      class (piano, violin, guitar, …). The `other` stem has drums/bass/
      vocals removed, so the tagger localizes harmonic instruments without
      those dominating. Window-level hits are already collapsed into spans
      by the sidecar; we merge same-label spans across short gaps.

Both sources are read from the sidecars' on-disk caches — populate them on
the VM first with the SPAN + PANNs detect endpoints (per-stem, see
prefer_stems below). Sources that aren't cached are silently skipped; if
neither is present the envelope is a SKIPPED (no-input) result.

Run:  python -m generators.instruments <slug>     (from tools/python/)
"""

from __future__ import annotations

from generators.common import (
    build_envelope,
    detect_cache,
    merge_spans,
    missing_inputs_fatal,
    sec_to_ms,
    write_envelope,
)

FAMILY = "instruments"
# Same-label spans closer than this are fused — bridges the 0.5 s window hop
# gaps PANNs leaves between consecutive hits of the same class.
MERGE_GAP_MS = 1500
# Drop trivially short presence blips.
MIN_SPAN_MS = 400


def _spans_from_payload(payload: dict, duration_ms: int, *, force_label: str | None) -> list[dict]:
    """Convert a sidecar {spans:[{start,end,label,confidence}]} payload into
    curated Span dicts. `force_label` overrides the per-span label (used for
    VAD, whose label is always 'voice' but we want 'vocals')."""
    out: list[dict] = []
    for s in payload.get("spans", []) or []:
        try:
            start_ms = sec_to_ms(s["start"], duration_ms=duration_ms)
            end_ms = sec_to_ms(s["end"], duration_ms=duration_ms)
        except (KeyError, TypeError, ValueError):
            continue
        dur = end_ms - start_ms
        if dur < MIN_SPAN_MS:
            continue
        conf = s.get("confidence")
        out.append({
            "start_ms": start_ms,
            "duration_ms": dur,
            "label": force_label or str(s.get("label") or "instrument"),
            "intensity": float(conf) if isinstance(conf, (int, float)) else None,
        })
    return out


def generate(slug: str) -> dict:
    """Build (and return) the instruments envelope for `slug`. Writes nothing."""
    vad, vad_stem = detect_cache("span", slug, "silero-vad", prefer_stems=("vocals", None))
    panns, panns_stem = detect_cache("panns", slug, "panns-cnn14", prefer_stems=("other", None))

    if vad is None and panns is None:
        return missing_inputs_fatal(
            FAMILY, slug,
            hint=(
                "no SPAN (silero-vad) or PANNs cache for this slug. On the VM "
                "run the SPAN detect on the vocals stem and PANNs detect on the "
                "other stem first (POST /api/span/detect, /api/panns/detect "
                "with stem=vocals / stem=other)."
            ),
        )

    duration_ms = 0
    for p in (vad, panns):
        if p:
            duration_ms = max(duration_ms, sec_to_ms(p.get("duration") or 0.0))

    spans: list[dict] = []
    sources: list[str] = []
    if vad is not None:
        spans += _spans_from_payload(vad, duration_ms, force_label="vocals")
        sources.append(f"vad:{vad_stem}")
    if panns is not None:
        spans += _spans_from_payload(panns, duration_ms, force_label=None)
        sources.append(f"panns:{panns_stem}")

    items = merge_spans(spans, gap_ms=MERGE_GAP_MS)

    return build_envelope(
        FAMILY, slug, items=items, duration_ms=duration_ms,
        generator=f"instruments@{'+'.join(sources)}",
    )


def run(slug: str) -> dict:
    env = generate(slug)
    write_envelope(env)
    return env


if __name__ == "__main__":
    import sys

    from generators.common import curated_path

    if len(sys.argv) < 2:
        print("usage: python -m generators.instruments <slug>")
        raise SystemExit(2)
    _env = run(sys.argv[1])
    print(f"{sys.argv[1]}: {_env['stats']} → {curated_path(FAMILY, sys.argv[1])}")
