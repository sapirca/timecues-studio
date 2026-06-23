"""Generate the `lyrics` curated output: per-word vocal timing.

Source (read from the LYRICS sidecar cache):
  * ctc-forced-aligner  — tightest word timing, but needs a reference
                          transcript saved by the annotator. Preferred when
                          present.
  * whisper-base        — no transcript needed; coarser (~200 ms) word
                          timestamps. Fallback.

Both are preferred on the *vocals* stem (cleaner transcription) and fall
back to the full mix. Output is the new `lyrics` kind:

    { time_ms, end_ms, text, kind }    kind ∈ {"word", "line"}

We emit per-WORD items when the chosen source has them; otherwise we fall
back to per-LINE items (the user's stated fallback: sentence start/end).

Run:  python -m generators.lyrics <slug>     (from tools/python/)
"""

from __future__ import annotations

from generators.common import (
    build_envelope,
    detect_cache,
    missing_inputs_fatal,
    sec_to_ms,
    write_envelope,
)

FAMILY = "lyrics"
# Preference order: tighter aligner first, then Whisper. Each is tried on the
# vocals stem before the full mix.
_ALGO_PREFERENCE = ("ctc-forced-aligner", "whisper-base")
_PREFER_STEMS = ("vocals", None)


def _items_from_payload(payload: dict, duration_ms: int) -> tuple[list[dict], str]:
    """Return (items, granularity). Prefer per-word; fall back to per-line."""
    words = payload.get("words") or []
    lines = payload.get("lines") or []
    rows = words if words else lines
    granularity = "word" if words else "line"

    items: list[dict] = []
    for r in rows:
        text = str(r.get("text") or "").strip()
        if not text:
            continue
        try:
            t_ms = sec_to_ms(r["time"], duration_ms=duration_ms)
        except (KeyError, TypeError, ValueError):
            continue
        end = r.get("end")
        end_ms = sec_to_ms(end, duration_ms=duration_ms) if isinstance(end, (int, float)) else None
        if end_ms is not None and end_ms < t_ms:
            end_ms = t_ms
        items.append({
            "time_ms": t_ms,
            "end_ms": end_ms,
            "text": text,
            "kind": str(r.get("kind") or granularity),
        })
    items.sort(key=lambda x: x["time_ms"])
    return items, granularity


def generate(slug: str) -> dict:
    """Build (and return) the lyrics envelope for `slug`. Writes nothing."""
    payload = None
    used = None
    for algo in _ALGO_PREFERENCE:
        payload, stem = detect_cache("lyrics", slug, algo, prefer_stems=_PREFER_STEMS)
        if payload is not None:
            used = f"{algo}:{stem}"
            break

    if payload is None:
        return missing_inputs_fatal(
            FAMILY, slug,
            hint=(
                "no LYRICS cache for this slug. On the VM run the lyrics detect "
                "on the vocals stem first (POST /api/lyrics/detect with "
                "algo=whisper-base, stem=vocals; or ctc-forced-aligner once a "
                "reference transcript is saved)."
            ),
        )

    duration_ms = sec_to_ms(payload.get("duration") or 0.0)
    items, granularity = _items_from_payload(payload, duration_ms)

    return build_envelope(
        FAMILY, slug, items=items, duration_ms=duration_ms,
        generator=f"lyrics@{used}({granularity})",
    )


def run(slug: str) -> dict:
    env = generate(slug)
    write_envelope(env)
    return env


if __name__ == "__main__":
    import sys

    from generators.common import curated_path

    if len(sys.argv) < 2:
        print("usage: python -m generators.lyrics <slug>")
        raise SystemExit(2)
    _env = run(sys.argv[1])
    print(f"{sys.argv[1]}: {_env['stats']} → {curated_path(FAMILY, sys.argv[1])}")
