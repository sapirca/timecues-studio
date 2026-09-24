# Task — export a song's timing as standard label files (+ time-precision setting)

Add a feature that exports a song's annotations to **tool-agnostic timing files**:
Audacity-style label tracks (`.txt`) plus a structured JSON manifest. This lets
users take their work into DAWs, Audacity, visualizers, LED/lighting tools, or
any script — TimeCues becomes a source that emits open, standard formats. The
export also honors a new configurable **time precision** setting.

Everything below is defined purely in terms of TimeCues' own data (`data/` and
`data-default/`, per `DATA.md`) and public formats. No downstream tool is
assumed or referenced.

---

## Feature 1 — configurable time precision

- New setting `timePrecisionDecimals` (integer). **Default 3** (millisecond).
  Allowed range 2–6.
- Store it with the app's other settings/config (follow the existing pattern;
  find how config is read/persisted rather than inventing a new store).
- Reuse the existing precision convention — `web-app/src/utils/beatGrid.ts`
  already uses `precision = 3`. Round (never truncate) with one shared helper:
  `Number(t.toFixed(decimals))` (`toFixed` returns a string).
- Apply the precision when **exporting** (Feature 2). In-memory values used for
  editing/playback keep full precision — only exported numbers are rounded.
- Add a small Settings control: "Time precision (decimal places)", 2–6, help
  text "3 = millisecond; lower = smaller files".

## Feature 2 — export timing files

For a `(song slug, annotator)`, write the files below into an output folder.

### Format rules (strict — this is the Audacity "Export Labels" format)
- TAB-separated. Seconds as floats, rounded to `timePrecisionDecimals`.
- Label tracks are one record per line, **sorted by start time**, no header,
  labels unquoted (labels may contain spaces).
- **POINT** markers: `<time>\t<time>\t<label>` (start == end). Some point files
  historically use a two-column `<label>\t<time>` form; emit the three-column
  form.
- **SPAN** markers: `<start>\t<end>\t<label>`.

### Files and where each comes from (all sources are TimeCues' own `data/`)
| File | Kind | Source |
|---|---|---|
| `<slug>_beats.txt` | POINT | `algorithm-outputs/bpm-detections/<slug>.json` → chosen detector's `beat_times`. Detector preference: `madmom-rnn-beats`, else `librosa-beat-track`, else any algorithm with `ok` + `beat_times`. Label `b0, b1, …`. |
| `<slug>_bars.txt` | POINT | Downbeats derived from the beats: every Nth beat, N = time-signature numerator (from `song-info/<slug>.json` `timeSignature`, default 4). Label `bar 0, bar 1, …`. |
| `<slug>_key_points.txt` | SPAN | `annotations/layers/<annotator>/<slug>.json` → all layers of type `cues`, `spans`, `loops`, merged and sorted. Cue items are points (`time` → start = end); span/loop items use `start`/`end`. Label = item `label`. |
| `<slug>_pattern.txt` | SPAN | Same layers file, layers of type `patterns`. |
| `<slug>_sections_labels.txt` | POINT | `annotations/manual/<annotator>/<slug>.json` → `sections[]` (`time`, `label`). |
| `<slug>_sections.json` | JSON | Structured sections: `{ song, annotated_at, sections: [{ time, type, label }] }`. |
| `bpm.txt` | number | `song-info/<slug>.json` `bpm`; else the chosen detector's `bpm`; else median of `gridSegments[].bpm`. |
| `<slug>_info.txt` | text | Free text for humans: title / artist / bpm / time signature / grid mode, then a one-line list of section labels. |
| `<slug>_annotations.json` | JSON manifest | Self-describing per-layer export — see below. |

### `<slug>_annotations.json` — the structured manifest
One entry per annotator-drawn layer, plus one for the manual sections. This is
the richest export (keeps layer identity that the flat label tracks flatten):

```json
{
  "song": "<slug>",
  "annotator": "<annotator id>",
  "generated_at": "<iso8601>",
  "lanes": [
    {
      "id": "layer:<layer uuid>",
      "source": "layers",
      "type": "cues | spans | patterns | loops",
      "name": "<layer name>",
      "count": <int>,
      "items": [ { "start": <sec>, "end": <sec>, "label": "<text>" } ]
    },
    {
      "id": "sections",
      "source": "manual",
      "type": "sections",
      "name": "Sections",
      "count": <int>,
      "items": [ { "start": <sec>, "end": <sec>, "label": "Intro 1", "kind": "intro" } ]
    }
  ]
}
```
- Cue items stay points (`end == start`). Items sorted by `start`.
- Section items carry the structural type as `kind` (intro / drop / breakdown / …).
- All times rounded to `timePrecisionDecimals`.

### Where to implement
- Match the existing pattern: a Node script `tools/export-timing-files.mjs`
  alongside the sibling `tools/migrate-*.mjs`, taking a slug plus `--annotator`,
  `--all`, `--out <dir>`. Optionally add a web-app "Export timing files" button
  that calls the same logic.
- Reuse existing data access (per-annotator scoping via `X-Annotator-Id` /
  `corpusForReq`, beat-grid utilities in `beatGrid.ts`).

## Acceptance
- `node tools/export-timing-files.mjs 5am_chediak --annotator local-curator`
  writes all files above; label tracks are TAB-separated, sorted, and times show
  the configured precision (e.g. `61.581`, not `61.58114285714285`).
- Setting `timePrecisionDecimals = 2` re-exports at 2 decimals; unset behaves
  as 3.
- Re-exporting is deterministic apart from `generated_at`.