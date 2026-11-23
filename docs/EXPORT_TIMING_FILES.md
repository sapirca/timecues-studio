# Task — export a song's timing as standard label files (+ time-precision setting)

Add a feature that exports a song's annotations to **tool-agnostic timing files**:
Audacity-style label tracks (`.txt`) plus a structured JSON manifest. This lets
users take their work into DAWs, Audacity, visualizers, LED/lighting tools, or
any script — TimeCues becomes a source that emits open, standard formats. The
export also honors a new configurable **time precision** setting.

Everything below is defined purely in terms of TimeCues' own data (`data/` and
`data-default/`, per `docs/DATA.md`) and public formats. No downstream tool is
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
- TAB-separated. Seconds as floats, rounded to `timePrecisionDecimals` — or,
  with `--units beats`, beat positions (see *Exporting in beats* below).
- Label tracks are one record per line, **sorted by start time**, no header,
  labels unquoted (labels may contain spaces).
- **POINT** markers: `<time>\t<time>\t<label>` (start == end). Some point files
  historically use a two-column `<label>\t<time>` form; emit the three-column
  form.
- **SPAN** markers: `<start>\t<end>\t<label>`.

### Files and where each comes from (all sources are TimeCues' own `data/`)
| File | Kind | Source |
|---|---|---|
| `<slug>_beats.txt` | POINT | The annotator's grid from `song-info/<slug>.json` (BPM, grid offset, tempo segments, pinned beats), labelled `b<beat index>`. Only a song with no BPM yet falls back to `algorithm-outputs/bpm-detections/<slug>.json` → the chosen detector's `beat_times` (`madmom-rnn-beats`, else `librosa-beat-track`, else any algorithm with `ok` + `beat_times`). |
| `<slug>_bars.txt` | POINT | That grid's bar lines, `bar 1` at the downbeat; with the detector fallback, every Nth beat, N = the time-signature numerator (default 4). |
| `<slug>_key_points.txt` | SPAN | `annotations/layers/<annotator>/<slug>.json` → all layers of type `cues`, `spans`, `loops`, merged and sorted — except cue layers copied from a detector, which export as a one-line summary in the manifest's `summarized_lanes` (rows only with `--with-notes`). `--detectors` adds `<slug>_detectors.txt`, every detector's output summarised per group. Cue items are points (`time` → start = end); span/loop items use `start`/`end`. Label = item `label`. A layers file saved under Grid Lock (`"timebase": "beats"`) stores items by their beat alone; the exporter places them on the song's grid as it is now (`withSecondsFromBeats`, `web-app/src/utils/beatTimebase.ts`) before writing anything. |
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
- Every item also carries its beat position — `beat` on a point,
  `start_beat` / `end_beat` on a range — fractional beats from the grid origin
  (bar 1, beat 1 = `0`). A position within 1 ms of a 1/24-beat step (every snap
  the grid offers: 1/2, 1/3, 1/4, 1/6, 1/8) is written as that step, so a mark
  on the 4th 32nd of beat 12 reads `12.375`, not `12.37491`.
- `units` says what the positions are in: `"seconds"` (default) or `"beats"`.

#### The grid block (`grid`)
Every manifest opens with the grid its beats were counted on — without it a beat
number means nothing:

```json
"grid": {
  "bpm": 124, "bpm_source": "song-info", "detected_bpm": 125,
  "time_signature": "4/4", "beats_per_bar": 4,
  "grid_offset": 0.07,
  "grid_mode": "mapped", "beat_overrides": 0, "beats_source": "grid",
  "segments": [{ "start": 61.99, "bpm": 126, "time_signature": "4/4" }],
  "tempo_map": [{ "beat": 0, "time": 0.07, "bpm": 124 },
                { "beat": 128, "time": 61.99, "bpm": 126 }],
  "signature": "bpm=124;off=0.07;ts=4/4;mode=mapped;segs=61.99@126"
}
```
- `grid_offset` is in seconds: where bar 1, beat 1 sits (beat `0`).
- `tempo_map` is the grid as constant-tempo stretches: beat `b` is at
  `time + (b − beat) × 60 / bpm` seconds, with the last entry whose `beat ≤ b`
  (a beat before the first entry uses the first one). It is all a reader needs
  to turn a beat into a second, in any tempo mode. Pinned (hand-placed) beats
  are not part of it — beats are converted on the macro grid, as in the app.
- `signature` changes whenever the grid does; a consumer holding an older one is
  holding the old grid's seconds.

#### Exporting in beats (`--units beats`)
`--units beats` writes every position as beats instead of seconds:
- **Label tracks** (`*.txt`): both columns are beat positions (`2\t2\tkick`).
- **`<slug>_sections.json`**: `beat` instead of `time`, and `"units": "beats"`.
- **Manifest**: `"units": "beats"`, and no seconds anywhere in an item —
  - a position with a beat twin drops its seconds (`start` beside `start_beat`
    goes; a point keeps only `beat`; a lyric onset keeps `beat`);
  - a position without one is converted and renamed so the key says so:
    `candidates` → `candidate_beats`, an envelope's `start` / `peak` /
    `decay_end` / `release` / `end` → `…_beat`, a prominence point's `at` →
    `at_beat` (its item-relative `t` is dropped), a vocal run's
    `start_beat` / `end_beat`, an ⚡ Energy curve point's `t_ms` → `at_beat`;
  - a length becomes beats at that point of the song: a cue's `decay` →
    `decay_beats`, an Energy reading's `duration_ms` → `duration_beats` and its
    envelope's `*_ms` → `*_beats`; a pulse drops `interval_ms` and keeps
    `period_beats`;
  - a riff node's note `start` / `end` were beats from the node's start all
    along, and stay as they are.
- The `grid` block is unchanged — it is what turns these beats back into
  seconds.
- A song with **no grid** (no BPM) is skipped with a warning: a beat position
  has nothing to count from, and the export does not guess one.

#### Where the beats come from
Under Grid Lock the annotation **is** the beat. The app saves such a song's
layers file with `"timebase": "beats"`: a stamped item stores only `beat` /
`startBeat` / `endBeat` (its candidates in beats too), and the file carries its
own `grid` (`bpm`, `gridOffset`, `timeSignature`, `beatsPerBar`, `gridMode`,
`tempoMap`). Lyrics and the fields that describe the sound (`decay`,
`envelope`, prominence offsets) keep their seconds. Every reader of the file —
the app (`utils/beatTimebase.ts`), this exporter, and the Python readers
(`tools/python/layers_timebase.py`) — turns the beats back into seconds on read.

#### A copied groove's rhythm (`nodes[].groove`)
A Riff Patterns lane carries its motif library as `nodes`. When the lane was
copied from a drum-groove lane (Copy to manual layer), every node also carries
the groove it plays as data — the structure behind the sentence the app writes
about it (*M's rhythm (2-bar loop): bar 1: hat 3, 7, 11, 15, 16 / bar 2: …*),
so a reader never has to parse that sentence back:

```json
"groove": {
  "groove": "M²",            // the figure: a letter, or a version of it
  "family": "M",             // the letter it belongs to
  "names": [],               // what a musician would call it; may be empty
  "loop_bars": 2,
  "steps": 32,               // steps in the whole loop
  "steps_per_bar": 16,       // 12 for a 3/4 bar of 16ths — never assumed 16
  "hits":    { "hat": [2, 6, 10, 14, 15, 16, 17, 18, 20, 22, 24, 26, 30] },
  "accents": { "hat": [0.94, 0.94, 0.94, 0.92, 0.81, 0.84, 0.75, 0.94, 0.87, 0.93, 0.94, 0.94, 0.92] },
  "dropped": [{ "drum": "hat", "step": 31 }]
}
```
- Steps count from 0 across the whole loop: bar 2 of a 2-bar loop starts at
  `steps_per_bar`. `hits` is keyed by drum (a copy is one layer per drum, so
  one key — the lane's `drum`).
- `accents` is 0..1, in the order of `hits`; `null` for a hit the detector has
  no accent for (one a version added). Absent when nothing was measured.
- `added` / `dropped` (`[{drum, step}]`) appear on a version only: what it
  strikes that its family's loop does not, and the reverse — against the loop
  played round when the version is longer (a 4-bar version of a 2-bar groove).
- A node whose hits were edited by hand is no longer the detector's figure and
  has no `groove`.
- Only the manifest carries it. The label tracks (`*.txt`) are three columns
  by contract and cannot; the Export Manager's JSON format carries the layer
  as stored (camelCase: `loopBars`, `stepsPerBar`), and its marker formats
  (Audacity, Sonic Visualiser, JAMS, mir_eval, MIDI, Reaper) skip riff layers.

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
- The same with `--units beats` writes every position in beats, with no seconds
  key left in any manifest item, and skips a song that has no grid.
- A Grid Lock layers file (beats only) exports the same seconds as the same
  annotation saved with seconds.
- Setting `timePrecisionDecimals = 2` re-exports at 2 decimals; unset behaves
  as 3.
- Re-exporting is deterministic apart from `generated_at`.