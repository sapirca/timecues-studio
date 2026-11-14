"""Orchestrating generators for the five curated end-products.

Each module here turns the repo's raw algorithm caches (allin1, panns,
lyrics, pattern, …) and Demucs stems into ONE clean, importable layer:

    phrases       — structural phrases of a song           (boundary)
    instruments   — per-instrument presence spans          (span)
    cues          — sparse, salient points of interest     (cue)
    drum-pattern  — the repeating rhythmic pattern          (pattern)
                    drum_kit_pattern.py: labelled rows (kick/snare/hat)
                    with accents, and each repeat carrying how far it
                    strays from the groove. Built by the Drum hits &
                    grooves detector, not by a batch run: it needs the
                    song's bar grid.
    lyrics        — per-word (fallback per-line) timing      (lyrics)

These are NOT sandboxed custom detectors: they run as privileged batch
scripts (siblings of run_demucs_songs.py) so they may call the heavy
model sidecars and read every cache on disk. They emit the SAME envelope
shape the custom-detector runner produces (see common.build_envelope), so
a single web-side importer can fold any of them into an editable
AnnotationLayer.
"""