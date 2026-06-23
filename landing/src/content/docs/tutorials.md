---
title: Tutorials
description: Step-by-step written walkthroughs of every TimeCues workflow — annotation, beat-grid alignment, algorithm comparison, auto-guess, custom detectors, self-hosting — plus a complete reference for flags, settings, and Docker compose profiles. Video screencasts land over time.
---

Every TimeCues workflow has a **complete step-by-step written walkthrough
on this page** — each one illustrated with screenshots of the actual UI,
and ready to follow today. **Click any card below to jump straight to its
tutorial**, or use the page outline on the right. Video screencasts will
land over time.

There is also a full reference for every **flag, environment variable, and
Docker compose profile** at the [bottom of this page](#flags-environment-variables--compose-profiles)
— the "what do I actually type and which knobs exist" companion to the
workflow guides.

If there's a screencast you'd like recorded first, [say so on the contact page](/contact/).

<div class="tutorial-grid">

  <a class="tutorial-stub tutorial-card" href="#getting-started-in-3-minutes">
    <h3><span class="stub-led ready"></span> Getting started in 3 minutes</h3>
    <p>Open a song, scrub the waveform, drop your first boundary, save. The shortest possible loop through the app.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#creating-a-new-dataset">
    <h3><span class="stub-led ready"></span> Creating a new dataset</h3>
    <p>From a fresh deploy to your first reviewed corpus — claiming the workspace, uploading audio, picking an access tier, inviting your team, and switching between datasets.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#aligning-the-beat-grid">
    <h3><span class="stub-led ready"></span> Aligning the beat grid</h3>
    <p>Bar-start anchor, Grid Offset, Static BPM vs Dynamic vs Manual modes, what to do with songs that drift, and how to read the red / amber / emerald grid-readiness glyph.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#annotating-boundaries-with-the-keyboard">
    <h3><span class="stub-led ready"></span> Annotating boundaries with the keyboard</h3>
    <p>The full keyboard-driven flow — M to add, snap-to-grid, the violet-halo tick when you snap, undo/redo, and how to think about the layer cards in the sidebar.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#comparing-algorithms">
    <h3><span class="stub-led ready"></span> Comparing algorithms</h3>
    <p>Toggle algorithm overlays, read the per-song F-measure and HitRate, and switch reference layers to see how scores shift.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#the-auto-guess-workflow--consensus--clustering">
    <h3><span class="stub-led ready"></span> The Auto-guess workflow</h3>
    <p>Generate an AutoGuess from the four clustered algorithms, then tick through point-by-point with ✓ / ✗ / @ to harvest a clean manual layer in a fraction of the time.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#eye-annotations-from-the-spectrogram">
    <h3><span class="stub-led ready"></span> Eye annotations from the spectrogram</h3>
    <p>Doing a quick by-eye pass on the spectrogram alone, when audio playback isn't an option, and how Eye annotations compare to Manual.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#writing-a-custom-detector">
    <h3><span class="stub-led ready"></span> Writing a custom detector</h3>
    <p>Drop a Python file in <code>tools/python/custom/</code>, reload, and have your algorithm show up as an overlay with full evaluation. No build step.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#multi-annotator-comparing-two-peoples-work">
    <h3><span class="stub-led ready"></span> Multi-annotator: comparing two people's work</h3>
    <p>Signing in, the per-annotator namespace, side-by-side comparison view, and resolving disagreements between annotators.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#bpm-auto-detection-chips">
    <h3><span class="stub-led ready"></span> BPM auto-detection chips</h3>
    <p>The five detectors (librosa + CPJKU-madmom), what the clickable chips do, and how to pick the right candidate when they disagree.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#stem-separation-with-demucs">
    <h3><span class="stub-led ready"></span> Stem separation with Demucs</h3>
    <p>Triggering the stems daemon, what the wait time looks like, and using the resulting vocal / drum / bass / other tracks in inspection.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#self-hosting-on-your-own-server">
    <h3><span class="stub-led ready"></span> Self-hosting on your own server</h3>
    <p>Bring up the Docker stack on any VM or homelab, put a TLS reverse proxy in front, and claim the first admin.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

  <a class="tutorial-stub tutorial-card" href="#settings--the-complete-tour">
    <h3><span class="stub-led ready"></span> Settings — the complete tour</h3>
    <p>Every panel, every toggle, every dropdown — the role banner, the five categories (User info / Annotation / Research / Corpus management / Danger Zone), what's admin-only, and where to flip each one.</p>
    <span class="card-cta">Read the walkthrough →</span>
  </a>

</div>

## Want one sooner?

The order above is roughly priority-first. If there's a specific
workflow you'd find most useful — or a wrinkle in the app that confused
you and would benefit from being shown rather than written — drop a note
on the [contact page](/contact/) and I'll bump it up.

---

# Step-by-step tutorials

The detailed walkthrough for every card above, plus a
[flags / settings / compose-profile reference](#flags-environment-variables--compose-profiles)
at the end. Skim the one that matches what you want to do — each section
is self-contained and references the deep-dive part of the
[user guide](/timecues/user-guide/) when the topic deserves more than a
screencast can give.

> ⚠ **Set BPM and lock the grid in Dataprep before anything else.** Every
> annotation snaps to the song's beat grid, and the Annotator Tool
> refuses to open without a BPM. The grid-readiness glyph on the song
> row in the sidebar turns **emerald ♩** once you're ready; amber ♩
> means the grid is not locked yet, red ♩ means BPM is still missing.

## Getting started in 3 minutes

![The TimeCues main page](timecues/images/main-page.png)
*The main page — “Enter Demo” to look around with no account, or “Start a new dataset” / “Enter your corpus” to work on real audio.*

![The Annotator Tool](timecues/images/annotate-overview.png)
*The Annotator Tool — press space to play and M at each transition to drop a boundary on the nearest beat.*

The shortest possible loop through the app — open a song, lock the
grid, drop your first boundary, save.

1. **Open the app** — [the live demo](__LIVE_DEMO_URL__)
   if you just want to look, or your own deploy from `docker compose up`.
   The main page shows two entry cards: *Enter Demo* and either *Start
   a new dataset* (fresh deploy) or *Enter `<corpus>`* (already claimed).
2. **Sign in or click Enter Demo.** Demo Mode needs no account and
   keeps every edit in `localStorage`; signing in writes annotations
   server-side under your annotator id.
3. **You land in Dataprep.** Pick a song in the left sidebar. If the
   manifest is empty, drop an MP3 into the upload zone.
4. **Open the *BPM and Grid ▸* disclosure** below the waveform. Click
   an `Auto-detected` chip (or type a value) to set BPM. Click *Set bar
   start (G)* at the first audible kick to align bar 1.
5. **Switch to the *Annotator Tool* tab.** The song's sidebar glyph
   should now read emerald ♩.
6. **Press space to play, press M when the song hits a section
   transition.** The boundary lands on the nearest beat; tab to give it
   a label.
7. **Auto-saves on every edit.** No save button. Refresh — the boundary
   is still there.

> **What you need:** Nothing beyond `docker compose up` — or just open the
> live demo, which needs no account and no install. No profile and no flags:
> this is the core loop, on by default.

## Creating a new dataset

![The main page entry cards](timecues/images/main-page.png)
*“Start a new dataset” claims the corpus on disk and makes your account its first admin.*

![Song sidebar header actions](timecues/images/sidebar-header-actions.png)
*Upload songs, import an existing dataset, or export — all from the sidebar header.*

![The Import dataset dialog](timecues/images/import-dataset-dialog.png)
*The Import dataset dialog — bring an existing folder of songs into the corpus.*

From a fresh deploy to your first reviewed corpus. This is the
"day-zero" path — the first thing you do on a TimeCues install where
nobody's claimed the workspace yet.

### Demo vs. claimed corpus

The landing page after sign-in shows two cards, so know which one you
want:

- **Enter Demo** — uses the three CC0 songs shipped in
  `data-default/songs/` (`edm-at-midnight`, `pantheon`, `phonk-remix`)
  with pre-computed BPM, grids, stems, and one Manual layer per song.
  Every edit lives only in your browser's `localStorage` — nothing
  hits disk. Use this to evaluate the tool with zero commitment;
  reset by clearing site data.
- **Start a new dataset** *(fresh deploy)* — claims the corpus on disk
  for your annotator id, with you as the first admin. Audio uploads,
  annotations, and BPM caches all persist to `data/songs/`,
  `data/annotations/`, and `data/algorithm-outputs/`.
- **Enter `<corpus name>`** *(already-claimed deploy)* — the corpus
  exists; you're joining as whatever tier the admin set for your
  email. If your email isn't on the allowlist you'll see a
  Public-tier read-only view of the demo songs only.

### Step by step — creating from scratch

1. **Open the app** at your deploy URL or
   [the live demo](__LIVE_DEMO_URL__). If this is a
   fresh deploy the landing page will show *Start a new dataset*. If
   someone's already claimed it you'll see *Enter `<corpus>`* and need
   that admin to add you to the team.
2. **Click *Start a new dataset*.** You'll be prompted to sign in via
   Google. Your email becomes the first admin's id; in
   `dataset-config.json` it lands under `peopleByEmail[<you>].tier =
   "admin"`.
3. **Name the corpus.** This is the human-readable string that shows
   in the sidebar title and the *Enter `<corpus>`* card. Stored at
   `data/dataset-config.json:datasetName`. Edit later from
   **Settings → Corpus management → Admin & access**.
4. **You land in Dataprep** with an empty song list. The viz canvas
   shows a placeholder.
5. **Drop audio into the upload zone** at the bottom of the song
   sidebar. MP3, WAV, FLAC, and M4A are supported; the file's slug is
   derived from the filename (lowercased, non-alphanumeric → `-`),
   and the file lands at `data/songs/<slug>/<filename>.<ext>`.
   *Drag-drop multiple files at once* to bulk-add — each one becomes
   its own song row.
6. **Click a song** in the sidebar to open it. The waveform draws,
   the audio decodes. If you uploaded files with embedded ID3 metadata
   the *Song Info Bar* pre-fills title and artist.
7. **Lock the grid for this song.** Open the *BPM and Grid ▸*
   disclosure (see [Aligning the beat grid](#aligning-the-beat-grid)
   below). The sidebar's per-song workflow glyph flips from red ♩
   to amber ♩ once BPM is set, and to emerald ♩ once you've
   confirmed the grid by anchoring the bar start.
8. **(Optional) Invite the team.** Go to **Settings → Corpus
   management → Admin & access → People** and add emails one row at
   a time. Each row chooses one of four tiers — admin, researcher,
   team, public. The added person sees the dataset the next time they
   sign in. See [Roles](/timecues/user-guide/#roles-admin-team-leader-vs-annotator)
   in the user guide for the full per-tier capability matrix.
9. **(Optional) Pre-compute the algorithm cache.** From the sidebar
   footer in Dataprep click **Run all algorithms** — every built-in
   detector runs on every song and the per-song cache fills. Useful
   before Auto-guess (it needs the per-detector outputs as input) and
   before any batch Inspect All run (instant load when the cache is
   warm).

### Switching between datasets

There's only one corpus per deploy — `data/dataset-config.json` is
the single source of truth for who's in and who's an admin. If you
want a *separate* corpus, run a second deploy with a different
`DATA_DIR` set in `.env` (e.g. `DATA_DIR=/Volumes/research-corpus`).
The same code, the same login, a different on-disk root.

### Where files land on disk

A claimed dataset writes to four subtrees under `DATA_DIR` (default
`./data/`):

| Path | Contents |
|---|---|
| `data/songs/<slug>/<filename>` | The original audio file, untouched. |
| `data/annotations/<layer>/<annotator>/<slug>.json` | One file per song per annotator per layer (Manual / Eye / Auto-guess). |
| `data/algorithm-outputs/<algorithm>/<slug>.json` | One file per algorithm per song — the detector run cache. |
| `data/dataset-config.json` | The single corpus-config — name, people-by-email, default vocabularies, BPM defaults. |
| `data/stems/<slug>/{vocals,drums,bass,other}.wav` | Demucs stems once extracted (admin runs *Run Demucs* in the source picker). |

Snapshot or export this directory and you have the entire dataset
state — the rest of the app is stateless code. See
[Data model](/timecues/data-model/) for the deep-dive.

### Export and migration

From the **Storage stats** panel in Settings → Corpus management, an
admin can export the entire corpus in any of five formats — JSON,
Audacity labels, Sonic Visualiser layers, JAMS, MIDI, REAPER project.
The exports are read-only at export time (no streaming sync). Useful
for handing the corpus to collaborators or moving to a fresh deploy.

Deep dive: [Main Page](/timecues/user-guide/#the-main-page) covers
the Dataprep workspace end-to-end, and
[Roles](/timecues/user-guide/#roles-admin-team-leader-vs-annotator)
covers the four-tier access model.

## Annotating boundaries with the keyboard

![The Annotator Tool](timecues/images/annotate-overview.png)
*The Annotator Tool — control bar, player, stacked signal rows, and the structure-sections editor.*

![The annotation edit toolbar](timecues/images/annotate-toolbar.png)
*The edit toolbar — undo/redo, split, auto-guess, list/grid view, and clear.*

![The keyboard shortcuts drawer](timecues/images/shortcuts-drawer.png)
*Press ? anywhere for the full keyboard map — playback, zoom, and annotation bindings.*

The full keyboard-driven flow. Faster than the mouse once you commit to it.

1. **Lock BPM and grid in Dataprep first** — section transitions snap
   to the grid you set up there.
2. **Switch to the Annotator Tool.** Pick *Boundaries → Manual* in the
   tab strip just under the waveform.
3. **Press space to play.** Listen for the first transition.
4. **Press `M` to drop a boundary** at the playhead. The boundary
   snaps to the nearest grid line — you'll see a brief violet halo at
   the snap target so you know which beat caught it.
5. **Use `Tab` to focus the label field** on the just-dropped boundary
   and type its label (`intro`, `verse`, `chorus`, …). Press `Enter` or
   `Escape` to return focus to the waveform.
6. **Navigate with `[` and `]`** to step backwards / forwards between
   boundaries. The playhead jumps to each one in turn.
7. **Mark importance** — `★` toggles a boundary between *critical*
   (the must-hit-it transitions) and *optional* (nice-to-have). Critical
   recall is scored separately in evaluation.
8. **Repair mistakes** — `Delete` removes the focused boundary, `S`
   splits an existing boundary into two candidates (multiple defensible
   start times for the same transition; matching uses whichever is
   closer).
9. **Undo / redo** with `Cmd/Ctrl-Z` and `Cmd/Ctrl-Shift-Z`.
10. **Flip the layer to *reviewed*** in the right rail when you're done.
    The sidebar's per-song workflow indicator goes emerald once every
    layer you've started is marked reviewed.

Deep dive: [Annotation Workspace](/timecues/user-guide/#annotation-workspace)
and [Keyboard Shortcuts](/timecues/user-guide/#keyboard-shortcuts).

## Comparing algorithms

![Algorithm Inspect overview](timecues/images/inspect-overview.png)
*Algorithm Inspect — each detector's predictions stacked as colored timelines over the waveform.*

![The Algorithms sidebar](timecues/images/algorithms-sidebar.png)
*Tick detectors in the right sidebar; every tick fires a run (cached by file hash, so repeats are instant).*

![Inspect sub-tabs and engine picker](timecues/images/inspect-subtabs.png)
*Pick the evaluation engine (mir_eval or Custom) and drag the tolerance slider τ.*

![The All-songs leaderboard](timecues/images/inspect-all-songs.png)
*The All songs sub-tab — a dataset-wide leaderboard you can re-sort by F1, precision, recall, MNBD, or CSR.*

The whole point of TimeCues — line every detector up against your
ground truth and see who wins, per song and across the corpus.

1. **Have a reference layer.** You need at least one of *Manual*,
   *Eye*, or *Auto-guess (reviewed)* on the song to evaluate against.
   Without that, every metric is meaningless — F1 against an empty
   reference is undefined.
2. **Switch to the *Algorithm Inspect* tab** and pick a song from the
   sidebar.
3. **Tick algorithms in the right sidebar.** Each one you tick fires a
   detector run (cached by file hash, so a repeat run is instant). Their
   predictions stack as colored timelines underneath the waveform.
4. **Pick a reference** in the *Reference* dropdown — Manual, Eye, or
   Auto-guess. The metrics panel below the canvas updates immediately.
5. **Pick the evaluation engine:**
   - **`mir_eval`** — the research-standard hit-rate / F1 / precision /
     recall computed by the [mir_eval](https://github.com/craffel/mir_eval)
     library. Use this when you want results that other papers can
     compare against.
   - **`Custom`** — adds Mean Nearest-Boundary Distance (MNBD,
     in seconds), Critical-Section Recall (CSR, restricted to
     ★-marked boundaries), candidate-aware matching (a boundary with
     multiple `S`-split candidates scores against whichever lands
     closest), and an optional-weight slider that lets you down-weight
     optional boundaries when computing F1.
6. **Drag the tolerance slider (τ)** to widen or narrow the matching
   window in seconds. Most published numbers use τ = 0.5 s or τ = 3 s.
7. **Switch to the *All songs* sub-tab** to batch-run the same
   selection across the whole corpus. The leaderboard sorts by F1 /
   precision / recall / MNBD / CSR — click a column header to re-sort.
   Each row expands to per-song scores so you can spot which songs an
   algorithm chokes on.
8. **Pre-compute the cache** in Dataprep first if you have many songs:
   the *Run all algorithms* button warms the cache for every detector ×
   every song, so the batch view loads instantly later.

> **What you need:** The default `docker compose up` stack covers MSAF,
> Ruptures, and the librosa / `mir` detectors — tick those with zero extra
> setup. **All-In-One** stays greyed out ("Demucs profile needed") until the
> stack is up with `--profile demucs-cpu` or `--profile demucs-gpu` (local
> dev: `pip install -r tools/requirements-allin1.txt`). The experimental
> detectors (BeatNet, Silero-VAD, PANNs, …) need **both** the
> `--profile experimental-models` sidecars **and** their per-family toggle in
> **Settings → Experimental annotation types & models** — every experimental
> flag is **off by default**. Full map:
> [Flags & compose profiles](#flags-environment-variables--compose-profiles).

Deep dive: [Inspect Workspace](/timecues/user-guide/#inspect-workspace)
and [Inspect All](/timecues/user-guide/#inspect-all).

## The Auto-guess workflow — consensus & clustering

![The Boundaries layer-type chips](timecues/images/layer-type-chips.png)
*Auto-guess lives alongside Manual and Eye under the Boundaries layer type.*

![Auto-guess defaults in Settings](timecues/images/settings-auto-guess-defaults.png)
*Auto-guess defaults — cluster tolerance τ, minimum agreement count, and the source-detector subset that feeds the consensus.*

Auto-guess is the fastest path from "I just dropped a song in" to
"I have clean ground truth boundaries." It runs 30+ detectors in
parallel, **clusters** their boundary predictions in time, and lets
you tick through the clusters one at a time with three keys: ✓ /
✗ / @. The output is a single, reviewed boundary layer.

### The mental model

Think of it as **wisdom of crowds for boundary detection**. No single
detector is reliable — librosa beat-based segmentation might miss a
break, MSAF SF might fire on every snare fill, allin1 has its own
priors. But if six different detectors all fire within 200 ms of each
other, **something** is happening there. Auto-guess turns that
agreement into a single candidate and asks you to confirm it.

### Step by step

1. **Lock BPM and grid in Dataprep first.** Auto-guess clusters in
   seconds, but candidates are still snapped to the grid you set up.
2. **Pre-compute the detector cache.** From Dataprep, click *Run all
   algorithms* to warm the cache for every built-in detector on this
   song. (You can also do it from Algorithm Inspect — the cache is
   shared.) Auto-guess won't run until the source detectors have
   results to consume.
3. **Switch to the Annotator Tool → Boundaries → Auto-guess** tab.
4. **Click *Generate AutoGuess*.** The server pulls every cached
   detector's output, clusters all the boundary times into groups
   within a **cluster tolerance τ** (default 3 s, slider exposes
   0.5 s – 10 s), and returns one candidate per cluster. Each candidate
   carries:
   - a **timestamp** (the cluster centroid, weighted by detector
     confidence when available);
   - an **agreement score** — how many of the 30+ detectors fired
     inside this cluster;
   - the **list of contributing detectors** so you can see who
     agrees.
5. **Tick through the candidates** with `J` / `K` (next / previous).
   At each candidate, press:
   - **`✓` (or `A` for accept)** — the candidate becomes a confirmed
     boundary in your Auto-guess layer.
   - **`✗` (or `R` for reject)** — the candidate is dropped. Use this
     for false positives: a swell that no human would call a section
     boundary, a snare fill that fooled three detectors, an outro
     fade-out that everyone agreed on but doesn't actually mark a
     transition.
   - **`@` (or `E` for edit)** — accept the candidate but **nudge it
     in time** before committing. Use this when the consensus is in
     the right neighborhood but the cluster centroid landed half a
     bar early.
6. **Adjust the cluster tolerance** if you're seeing too many
   candidates (lower τ) or too few (raise τ). Regenerating with a
   different τ is cheap — the per-detector cache is already warm, only
   the clustering re-runs.
7. **Flip the layer to *reviewed*** when you've ticked through every
   candidate. The Auto-guess layer is now eligible as a reference in
   Algorithm Inspect — meaning you can train new detectors against
   the boundaries the consensus revealed.

### Why this is faster than annotating from scratch

A typical 3-minute song has ~8–12 section boundaries. From scratch you
play the song through, drop M boundaries, then go back and refine each
one — usually 10–15 minutes per song. With Auto-guess, the consensus
typically surfaces ~80–90% of the true boundaries on the first pass,
plus a handful of false positives. Ticking through 12 candidates
(✓ ✓ ✗ ✓ @ ✓ …) takes 60–90 seconds. The remaining 1–2 missed
boundaries you add by hand using normal Manual workflow.

### Tuning the consensus

The **AutoGuess grid search** in *Inspect All* lets you sweep the
clustering parameters across your whole corpus to find the F1-optimal
tolerance and agreement-threshold settings. Use it once on a small
labeled subset, then apply the winning parameters to the rest of the
corpus.

> **What feeds the consensus:** Auto-guess clusters whatever detectors have
> *cached output*, so the pool depends on what's running. The default stack's
> detectors are always in; All-In-One joins only when a Demucs profile is up,
> and the experimental families only when `--profile experimental-models` is
> running **and** their flag is on (default off). More detectors → stronger
> agreement, so warm the cache with *Run all algorithms* first. See
> [Flags & compose profiles](#flags-environment-variables--compose-profiles).

Deep dive: [Auto-Guess Internals](/timecues/user-guide/#auto-guess-internals)
covers the full clustering algorithm, the per-detector confidence
weighting, and the exact grid-search procedure.

## Eye annotations from the spectrogram

![The SIGNALS dropdown](timecues/images/signals-dropdown.png)
*Enable the spectrogram (and the SSM row) from the SIGNALS menu — your only signal once audio is muted.*

![Eye-mode annotation](timecues/images/annotate-overview.png)
*Drop boundaries by eye at every visible transition; in Eye mode the audio is automatically muted.*

What does the *eye* — not the ear — recover from a waveform and
spectrogram alone? Useful for studying visual cues vs. audio cues, and
for noisy-environment annotation when you can't play audio.

1. **Lock BPM and grid in Dataprep first.**
2. **Switch to the Annotator Tool → Boundaries → Eye** tab.
3. **The audio is automatically muted** in Eye mode. The waveform and
   spectrogram are your only signal.
4. **Toggle the spectrogram on** from the *SIGNALS* menu in the top
   viz bar if it isn't already (Eye mode pre-enables it by default).
   Try also enabling the SSM (self-similarity matrix) row — large
   off-diagonal jumps are often boundaries the eye catches before the
   ear.
5. **Drop boundaries with `M`** at every transition you can *see* —
   a sudden change in spectral content, a brightening or darkening of
   the high frequencies, a visual restart in the SSM.
6. **Cross-reference against Manual afterwards.** Each layer is
   reviewed independently; the Compare sub-tab shows them side by
   side. Eye usually nails the macro transitions and misses the
   smooth-but-audible ones.

> **What you need:** Nothing extra — the spectrogram and SSM are computed in
> the browser, so Eye mode works in the default stack with no profile or
> install. The **SSM** row is **off by default**; switch it on per-song from
> the **SIGNALS** menu, or make it default-on under **Settings → Annotation →
> Default signals**.

Deep dive: [Annotation Workspace → Eye mode](/timecues/user-guide/#annotation-workspace).

## Writing a custom detector

![The Playground page](timecues/images/playground-page.png)
*The Playground — write, save, run, and inspect custom Python detectors against the corpus.*

![The detector code editor](timecues/images/playground-editor.png)
*Edit the detector source and manifest, then run it inline without a build step.*

![A custom detector row](timecues/images/playground-row.png)
*Each detector row — status, name, kind/version, and Edit / Run / Run all / Clear outputs / Delete.*

Drop a Python file in `tools/python/custom/`, reload, and your
algorithm shows up as an overlay alongside every built-in detector.

1. **Switch to the *Playground* tab.** Hidden in Demo Mode.
2. **Write a `.py` file** that exposes a function matching the
   detector contract — the [Custom Detectors](/timecues/user-guide/#custom-detectors)
   section of the user guide has the exact signature. Roughly:
   ```python
   def detect(audio, sr, **kwargs):
       """Return a list of Boundary objects (time + label)."""
       boundaries = my_segmentation(audio, sr)
       return [Boundary(time=t, label=lbl) for t, lbl in boundaries]
   ```
3. **Upload it** via the Playground UI's file picker (or drop it into
   `tools/python/custom/` on disk and click *Reload*). The registry
   hot-reloads and the new detector appears alongside built-ins in
   Algorithm Inspect, Auto-guess's source pool, and the Dataprep
   batch-run picker.
4. **Run it** on a song in Algorithm Inspect and check the overlay.
5. **Iterate** — edit the script, re-upload (or just re-save and
   *Reload*), re-run. Cached results are keyed by the script's file
   hash, so a tweaked script always produces a fresh run; reverting
   to a previous version transparently re-hits the cache.

> **What you need:** Nothing extra — the `custom` sidecar (`:8005`) ships in
> the default stack, so custom detectors run without any profile. Scripts are
> read from `CUSTOM_SCRIPTS_DIR` (default `./tools/python/custom`); set it to a
> persistent path in `.env` for production. The **Playground** tab is **hidden
> in Demo Mode** — sign in to a claimed corpus to see it. Any Python package
> your detector imports must be installed in the `custom` sidecar's
> environment (rebuild its image, or `pip install` it on the `./run.sh` host).

Deep dive: [Custom Detectors](/timecues/user-guide/#custom-detectors)
documents the full Python contract, the parameter schema for the UI,
and how cached results are stored.

## Multi-annotator: comparing two people's work

![The annotator identity dropdown](timecues/images/annotator-badge-dropdown.png)
*Each sign-in is a distinct annotator id, so two people's manual layers never clobber each other.*

![The Team dashboard](timecues/images/team-overview.png)
*The Team dashboard — per-annotator boundary, eye, and auto-guess progress at a glance.*

![Inter-annotator agreement](timecues/images/team-agreement.png)
*Inter-annotator agreement — where two people's boundaries pair up within τ, and where they disagree.*

The per-annotator namespace is what keeps two people's manual
annotations from clobbering each other; the Compare sub-tab is where
you put them side by side and resolve disagreements.

1. **Sign in with two different accounts** (two browsers, or one
   browser with a private window). Each becomes a distinct annotator
   id; annotations land at
   `data/annotations/<layer>/<annotator-id>/<slug>.json`.
2. **Each annotator does a Manual pass** on the same song.
3. **Open the Annotator Tool's *Compare* sub-tab** while signed in as
   an admin or researcher (regular team annotators only see their own
   work).
4. **Pick the two annotators in the Compare picker.** Their layers
   render as two stacked timelines on the waveform, in distinct
   colors.
5. **Per-boundary diff readout** appears in the panel below — every
   boundary that's within τ of a peer is paired, everything else is
   flagged as a disagreement.
6. **Adjudicate** by switching to either annotator's layer (top-right
   *View as* dropdown) and editing — or use the Team page's "Merge
   into Auto-guess" action to fold both annotators' boundaries into
   a shared Auto-guess layer that you can then review together.

> **What you need:** Real sign-in. Demo Mode is single-user (everything lives
> in `localStorage`), so it has no separate annotator namespaces. Google
> sign-in works out of the box on localhost via the `VITE_GOOGLE_CLIENT_ID`
> shipped in `docker-compose.yml`; on any other hostname set your own client
> ID in `.env` and add the origin to its *Authorized JavaScript origins*. The
> **Compare** sub-tab is **admin / researcher only**.

Deep dive: [Sign-In & Identity](/timecues/user-guide/#sign-in--identity)
and [Team Dashboard](/timecues/user-guide/#team-dashboard).

## BPM auto-detection chips

![The AUTO-DETECTED chip row](timecues/images/auto-detected-chips.png)
*The AUTO-DETECTED row — click a chip to adopt that detector's BPM; Re-run forces a fresh pass.*

![BPM detection settings](timecues/images/settings-bpm-detection.png)
*Choose which detectors appear in the chip row under Settings → Research → BPM detection.*

Five detectors race in parallel; you click the chip whose number
matches what you hear, and the song's BPM is set.

1. **In Dataprep, open the *BPM and Grid ▸* disclosure** below the
   waveform.
2. **A row of `Auto-detected` chips** appears just below the BPM
   input. As detectors finish, their chips light up:
   - **`client-wabd`** — runs in your browser via
     [web-audio-beat-detector](https://github.com/chrisguttandin/web-audio-beat-detector)
     the moment the audio decodes. Fastest, typically the first chip
     to appear.
   - **`librosa-beat-track`** — onset → beat tracking from
     [librosa](https://librosa.org/).
   - **`librosa-tempo-static`** — librosa's global tempo estimate.
   - **`librosa-tempo-dynamic`** — librosa's frame-wise tempo
     (dominant mode reported).
   - **`madmom-rnn-beats`** — RNN beat tracker from the
     [CPJKU madmom fork](https://github.com/CPJKU/madmom).
   - **`madmom-tempo`** — madmom tempo histogram.
3. **Click a chip to adopt its BPM** into the input. Click another
   chip to switch.
4. **Disagree on the octave?** Halve or double the value in the input
   manually — many detectors confuse half-time and double-time. The
   metronome panel below is the fastest way to verify: play the song
   with the metronome on and listen for the click to land on the
   kick.
5. **Click *↻ Re-run*** at the right of the chip row to force a fresh
   detection (ignores the cache). Useful after replacing the audio
   file.
6. **Filter which detectors appear** under
   [Settings → BPM Detection](/timecues/user-guide/#settings) — turn off
   detectors that are slow or that you don't trust on your corpus.

> **What you need:** Nothing extra — the five server-side detectors all live
> in the `bpm` sidecar (`:8004`), part of the default stack, and `client-wabd`
> runs entirely in your browser. No profile, no model download. Every detector
> is **enabled by default**; switch individual ones off under **Settings →
> Research → BPM detection**.

Deep dive: [Song Info Bar → BPM](/timecues/user-guide/#song-info-bar).

## Aligning the beat grid

![Grid alignment controls](timecues/images/grid-alignment.png)
*Grid alignment — Set bar start (G), Nudge, and the Grid offset (s) field for fine-tuning.*

![The Tempo mode tabs](timecues/images/grid-mode-tabs.png)
*Tempo mode — Static, Dynamic, or Manual; only the active mode's grid is drawn downstream.*

![The Metronome panel](timecues/images/metronome-panel.png)
*Verify the grid with the metronome — the click should land on the kick, not before or after.*

BPM tells the app the tempo, but not *where* bar 1 starts. Without an
anchor every snap lands on the closest grid line — which may be one
or two beats off the song's actual downbeat. Aligning the grid takes
ten seconds per song and prevents an entire category of annotation
drift.

### Why this matters

Every Manual / Eye boundary snaps to the song's beat grid when *Snap*
is on (which is the default — see [Snap toggle](/timecues/user-guide/#3-big-icon-controls-zoom--grid--snap--misc)).
If your grid is misaligned by 240 ms, every boundary you drop with `M`
lands 240 ms early. Then when you compare against algorithm output
they look "always slightly off" — and that's the grid's fault, not
the algorithm's. Catching this in Dataprep saves debugging in
Algorithm Inspect later.

### The grid-readiness glyph

Each song row in the sidebar carries a `♩` glyph that summarizes how
ready that song is for annotation:

- **🔴 red ♩** — no BPM set. Annotator Tool won't open.
- **🟡 amber ♩** — BPM is set but the bar start has not been
  confirmed. Annotation will work, but every boundary's snap may be
  one beat off the actual downbeat.
- **🟢 emerald ♩** — BPM set *and* bar start anchored. Safe to
  annotate.

The goal of the alignment workflow below is to get every song to
emerald before you start annotating.

### Step by step

1. **In Dataprep, pick the song** in the sidebar. The viz canvas
   loads, the audio decodes, the waveform draws.
2. **Open the *BPM and Grid ▸* disclosure** below the waveform if
   it's collapsed.
3. **Set BPM first** — click an `Auto-detected` chip or type a value.
   See [BPM auto-detection chips](#bpm-auto-detection-chips) above
   for the chip-by-chip details. The grid overlay on the waveform
   appears as soon as BPM is non-zero.
4. **Listen for the first kick** of the song's actual content
   (usually right after the intro / pickup). Press space to play,
   pause when you hear it.
5. **Press `G` at the playhead** to set the bar start. The grid
   overlay snaps so that beat is now beat 1 of bar 1. The sidebar
   glyph flips from amber ♩ to emerald ♩.
6. **Verify with the metronome.** Click **Metronome ▶** in the
   *BPM and Grid ▸* disclosure and press space. You should hear the
   click land *on* the kick, not slightly before or after. If the
   click drifts: nudge **Grid Offset** in 1 ms steps until it locks.

### Grid Offset — the fine-tuning slider

Below the BPM input is a **Grid Offset** field, in seconds, range
`≥ 0`, step `0.001`. This is where the grid's bar-1 boundary sits
relative to `t = 0` in the audio. Setting bar start with `G`
auto-fills it; you can also type a value directly if you're matching
to an existing JAMS/REAPER reference.

**When to nudge Grid Offset by hand:**

- **Audio file has a long silence at the start** — the first kick
  is 3 seconds in, but the producer intended bar 1 to be at exactly
  3.000 s. Type that.
- **Imported from another tool** — the JAMS file says `bar_offset =
  1.2375`. Type that.
- **The `G` placement is off by a few milliseconds** — you anchored
  near the kick but not exactly on it. Nudge ± 10 ms at a time and
  re-verify with the metronome.

### The three Grid Modes

The **Grid Mode** dropdown (below Grid Offset in the *BPM and Grid ▸*
disclosure) tells the app whether the song's tempo is constant or
drifts:

| Mode | When to pick | What it does |
|---|---|---|
| **Static BPM** *(default)* | DAW-produced music, EDM, hip-hop — anything with a click track at the source. | One BPM number, one bar-start anchor, one rigid grid for the whole song. The fastest and most precise. |
| **Dynamic** | Live recordings, expressive playing, songs that speed up or slow down across sections. | A *tempo curve* per song with a *sensitivity slider* to control how aggressively the curve follows local tempo. Annotations still snap, but to a curve, not a constant. |
| **Manual adjustment** | Studio takes stitched from multiple performances, songs with no consistent tempo at all (free jazz, ambient, noise). | A two-layer system — an underlying coarse grid plus per-section adjustments. Place anchors at every section start and the app fills in tempo between them. |

**Static BPM** handles ~95% of recorded music. Reach for the other
two only when the metronome consistently drifts off the kick across
the song.

### Common pitfalls

- **Anchoring on the pickup, not the downbeat.** Many songs begin with
  a pickup beat (a single drum hit or guitar strum before bar 1
  proper). Anchoring on that puts bar 1 a beat early. Listen for the
  *full kick + snare pattern* to know you're on the real downbeat.
- **Songs that drift but you stay in Static BPM mode.** The metronome
  starts on the kick at second 0 but is off by half a beat at second
  120. That's drift — switch to Dynamic mode and let the curve track
  the tempo.
- **BPM is half what it should be.** Many detectors report half-time
  for songs with strong off-beat snare patterns. Double the BPM
  manually and re-anchor; the metronome will tell you instantly if
  you guessed wrong.
- **Audio file has been re-encoded** and the start timestamp moved.
  Re-anchor; old `Grid Offset` values are stale.

> **What you need:** Just the default stack — BPM detection (the `bpm`
> sidecar, `:8004`) is always on, and all three Grid Modes (Static / Dynamic /
> Manual) are core features with no flag to enable and nothing extra to
> install.

Deep dive:
[Song Info Bar → BPM](/timecues/user-guide/#bpm-the-songs-tempo),
[Grid Offset](/timecues/user-guide/#grid-offset--where-bar-1-starts-in-seconds),
[Grid Mode (Static / Dynamic / Manual)](/timecues/user-guide/#grid-mode-static-bpm--dynamic--manual-adjustment),
[Manual mode is a two-layer system](/timecues/user-guide/#manual-mode-is-a-two-layer-system),
and [Metronome Panel](/timecues/user-guide/#metronome-panel-dataset-prep).

## Stem separation with Demucs

![The Source picker stems row](timecues/images/source-stems-row.png)
*Pick a stem — Vocals, Drums, Bass, or Other — from the Source picker in the top viz bar.*

![Optional GPU tooling settings](timecues/images/settings-gpu-tooling.png)
*Optional GPU tooling — the allin1 and Demucs install and acceleration status, set at compose time.*

Four stem tracks (vocals / drums / bass / other) extracted by
[Demucs](https://github.com/facebookresearch/demucs), available
everywhere a source picker is shown.

1. **Open the Source picker** in the top viz bar — the dropdown next
   to the waveform mode chooser.
2. **Pick a stem** — *Vocals*, *Drums*, *Bass*, or *Other*. If stems
   aren't cached yet for this song, Algorithm Inspect / Annotator
   Tool will show a "Stems not extracted" hint and (for admins) a
   *Run Demucs* button.
3. **Admin: click *Run Demucs*** to trigger the stems daemon on `:8006`.
   The daemon is **not** in the default stack — it only exists when you
   brought the stack up with a Demucs compose profile
   (`--profile demucs-cpu` or `--profile demucs-gpu`; see
   [Flags & compose profiles](#flags-environment-variables--compose-profiles)).
   With no Demucs profile the **▶ Stem this song** button is hidden
   entirely. Extraction takes roughly 3–5 minutes per song on the CPU
   profile and ~30–60 s on the GPU profile. Progress is streamed to the
   browser console; a failure raises a visible alert rather than silently
   swallowing (fixed 2026-05-20).
4. **Once stems exist**, switching between them in the Source picker
   is instant — the waveform redraws, the spectrogram re-renders, and
   every algorithm overlay re-evaluates against the chosen stem.
5. **Useful in practice:** running beat detection on the *Drums*
   stem alone often beats running it on the full mix; running
   boundary detection on *Vocals* surfaces verse / chorus transitions
   that the full-mix detector smears over.

Demo Mode ships with pre-extracted stems for the three sample songs
(`edm-at-midnight`, `pantheon`, `phonk-remix`) — switching stems in
demo is instant and does not run Demucs.

Deep dive: [Stems server](/timecues/user-guide/#dataset-prep)
and [Storage clear scopes](/timecues/user-guide/#the-clear-storage-dialog--three-levels-of-cleanup).

## Self-hosting on your own server

![Admin & access settings](timecues/images/settings-admin-access.png)
*Once the stack is up, the first sign-in claims admin — then manage the team from Settings → Corpus management → Admin & access.*

The Docker Compose stack runs anywhere Docker (plus Compose v2) runs —
a cloud VM, a homelab, or bare metal.

1. **Clone the repo** on the host and copy `.env.example` to `.env`. The
   defaults work for localhost as-is; the only flag you usually touch
   here is `VITE_GOOGLE_CLIENT_ID` (point sign-in at your own OAuth
   client) and, on a public host, `DATA_DIR` (a persistent disk, not the
   OS root). Full list under
   [Flags & compose profiles](#flags-environment-variables--compose-profiles).
2. **Bring up the minimal stack** — `docker compose up --build` starts
   the web app on `:5173` plus six lightweight analysis sidecars:
   `mir-eval` (`:8001`), `msaf` (`:8002`), `ruptures` (`:8003`), `bpm`
   (`:8004`), `custom` (`:8005`), and `mir` (`:8007`). Stem separation
   and the experimental detectors are **opt-in profiles** — they do not
   start here (see step 5).
3. **Put an HTTPS reverse proxy in front** (Caddy, Traefik, or nginx +
   certbot) pointing at `web:5173`, so sign-in and the app work over
   TLS on your public hostname. Remember to add that hostname to your
   OAuth client's *Authorized JavaScript origins*, or Google rejects the
   sign-in iframe.
4. **First sign-in claims admin.** Open the deployed URL, click
   *Start a new dataset*, sign in with Google. You're now the first
   admin; invite the rest of your team from the Team page.
5. **Optional heavy profiles (additive — combine freely):**
   - `--profile demucs-cpu` — stem separation + All-In-One, works on any
     host, ~3–5 min/song.
   - `--profile demucs-gpu` — same features, CUDA-accelerated
     (~30–60 s/song), needs an NVIDIA GPU and is amd64-only.
   - `--profile experimental-models` — the eight Phase-1+ MIR detector
     sidecars (BeatNet, Silero-VAD, Whisper, …).

   e.g. `docker compose --profile demucs-cpu --profile experimental-models up -d --build`
   matches the hosted instance.

Deep dive: the full install matrix lives in
[INSTALL.md](https://github.com/sapirca/timecues-studio/blob/main/INSTALL.md)
— Docker on localhost, local dev without Docker, Apple Silicon, the
optional `demucs-cpu` / `demucs-gpu` / `experimental-models` profiles, and
sign-in setup.

## Flags, environment variables & compose profiles

The "what do I actually type, and which knobs exist" companion to the
workflow guides above — every command-line flag, `.env` variable, compose
profile, and in-app feature flag in one place. The canonical,
always-current matrix lives in
[INSTALL.md](https://github.com/sapirca/timecues-studio/blob/main/INSTALL.md);
this is the quick version.

### Run modes at a glance

Pick a row — everything else is a knob layered on top. The two opt-in
dimensions are **Demucs** (stems + All-In-One) and **Experimental models**
(the extra MIR detectors); both are off by default so a first
`docker compose up` stays lean.

| Mode | Command | Demucs | Experimental | Disk (1st build) | Best for |
|---|---|:---:|:---:|---|---|
| Docker — minimal | `docker compose up --build` | ✘ | ✘ | ~1 GB | First evaluation; smallest footprint |
| Docker — Demucs CPU | `docker compose --profile demucs-cpu up --build` | ✔ (slow) | ✘ | ~2 GB | Stems on any host, no GPU |
| Docker — Demucs GPU | `docker compose --profile demucs-gpu up --build` | ✔ (fast) | ✘ | ~4 GB | Stemming a corpus on NVIDIA + Linux/WSL2 |
| Docker — Experimental | `docker compose --profile experimental-models up --build` | ✘ | ✔ | ~7 GB | The new MIR detectors, no stems |
| Docker — full | `docker compose --profile demucs-cpu --profile experimental-models up --build` | ✔ | ✔ | ~8 GB | Matches the hosted instance |
| Local dev — lean | `./run.sh` | ✘ | ✘ | tiny (core deps only) | Hot-reload editing; basic annotation + eval |
| Local dev — full | `./run_all.sh` | ✔ (CPU) | ✔ | ~3 GB pip | Capability-complete; ≡ `./run.sh --all` |

### Compose profiles — the "compilation profiles"

A compose **profile** decides which sidecar services get built and started.
A plain `docker compose up` activates **none** of them; you opt in per
`up` line. Profiles are **additive** — list as many as you want on one
command and order doesn't matter.

| Profile | Adds | Port(s) | Image cost | Requires |
|---|---|---|---|---|
| *(none — default)* | web + the six core analysis sidecars | 5173, 8001–8005, 8007 | ~1 GB | — |
| `demucs-cpu` | stems daemon + All-In-One batch (multi-arch) | 8006 | ~1 GB extra | any host |
| `demucs-gpu` | stems daemon + All-In-One batch (CUDA) | 8006 | ~3 GB extra | NVIDIA GPU + Container Toolkit; amd64 / Linux / WSL2 only |
| `experimental-models` | eight Phase-1+ MIR detector sidecars | 8009–8016 | ~6 GB extra | — |

- **Pick at most one `demucs-*` profile per host** — both expose the same
  `stems` network alias, so the web app reaches whichever flavor is active
  with no config change.
- **Switching later is just a restart:** `docker compose down`, then a new
  `up` line with a different profile set. Your audio / annotations / caches
  under `data/` persist across every profile.
- The default stack is enough for Manual / Eye / Auto-guess annotation,
  MSAF, Ruptures, BPM, MIR features, and custom detectors. Demucs only adds
  stems + All-In-One; experimental only adds the new detector families.

### Service → port map

Each Python sidecar speaks HTTP on its own port; the web container proxies
`/api/*` to them. Handy when a port is already in use or you're launching a
sidecar by hand.

| Service | Port | Profile | What it runs |
|---|---|---|---|
| `web` | 5173 | always | React + Vite dev server; proxies `/api/*` |
| `mir-eval` | 8001 | always | `mir_eval` precision / recall / F-measure scoring |
| `msaf` | 8002 | always | MSAF structure-segmentation algorithms |
| `ruptures` | 8003 | always | Change-point detection family |
| `bpm` | 8004 | always | librosa + CPJKU-madmom BPM detectors |
| `custom` | 8005 | always | Your uploaded custom detector scripts |
| `mir` | 8007 | always | MIR features (librosa + optional Essentia) |
| `stems` | 8006 | `demucs-cpu` / `demucs-gpu` | Demucs stems daemon + All-In-One batch |
| `span` | 8009 | `experimental-models` | Silero-VAD + JDCNet voicing spans |
| `beatnet` | 8010 | `experimental-models` | BeatNet beats / downbeats / meter |
| `pitch` | 8011 | `experimental-models` | basic-pitch polyphonic notes |
| `loop` | 8012 | `experimental-models` | chroma-autocorrelation loop finder |
| `panns` | 8013 | `experimental-models` | PANNs CNN14 AudioSet tagging |
| `cue-extras` | 8014 | `experimental-models` | librosa key / autochord / onsets |
| `percussive` | 8015 | `experimental-models` | HPSS percussive spans |
| `lyrics` | 8016 | `experimental-models` | Whisper-base vocal transcription |

### `.env` flags

Copy `.env.example` to `.env` and uncomment what you need. Every flag is
optional — the shipped defaults boot a working localhost install.

| Flag | Default | What it controls |
|---|---|---|
| `DATA_DIR` | `./data` | Host path where audio, annotations, and algorithm caches persist. Point it at a mounted disk for a server; an absolute path moves the whole corpus off the repo. |
| `HOST_UID` / `HOST_GID` | `0` / `0` (root) | **Linux only.** Run containers as your host user so files written into `data/` aren't root-owned. Set to `id -u` / `id -g`. Docker Desktop (Mac/Win) handles this automatically. |
| `VITE_GOOGLE_CLIENT_ID` | shipped demo client | Google OAuth client ID for sign-in. Override to point at your own client when serving on a domain other than localhost — and add that origin to the client's *Authorized JavaScript origins*. Public by design. |
| `CUSTOM_SCRIPTS_DIR` | `./tools/python/custom` | Where the `custom` sidecar reads uploaded detector `.py` files from. Override to a persistent path in production. |
| `VITE_COMMIT_SHA` | from `.git` | The build SHA shown in the landing-page footer. Resolved from the mounted `.git` in local dev; the prod build pipeline injects it explicitly. Leave unset locally. |
| `HTTP_PROXY` / `HTTPS_PROXY` | — | Forwarded to `pip` during the image build if you're behind a corporate proxy. Build-time only. |

### Local-dev (`./run.sh`) flags

Only relevant on the no-Docker, hot-reload path. `./run.sh` is **lean** — it
installs only the core deps (mir_eval / ruptures / librosa / sklearn /
soundfile), then starts every sidecar before handing off to Vite. Use
`./run_all.sh` (≡ `./run.sh --all`) to additionally install the heavy model
families (torch, Demucs, All-In-One, the experimental sidecars, the py311
venv) — ~3 GB of wheels on first run.

| Flag | What it does |
|---|---|
| `--all` / `TIMECUES_FULL_INSTALL=1` | Switch to the full install profile (every model family). Same as running `./run_all.sh`. |
| `--torch=cpu\|gpu\|none` | Which PyTorch build to install. Default: `none` in lean mode, `cpu` under `--all`. `--cpu` / `--gpu` / `--no-torch` are shorthands. |
| `SKIP_MODEL_INSTALL=1` | Skip the heavy `pip install` even under `--all` (use your own venv / Conda). Core deps still install; sidecars boot but ones whose deps aren't importable report `available=false` and the UI reads **Deps missing**. |
| `TIMECUES_PYTHON` | Absolute path to the interpreter Vite's capability probe should inspect. Set this to your venv's `python` if the UI insists Demucs is missing after a manual `pip install`. The launcher sets it for you when it does the install itself. |
| `PYTHON` | Which interpreter the launcher uses for sidecars (defaults to `python`, then `python3`). |

### In-app experimental flags

Running the `experimental-models` profile only makes the sidecars
*reachable* — each detector family stays hidden until you flip its flag in
**Settings → Experimental annotation types & models**. The flag and the
sidecar are linked: a family's toggle is **disabled** (with an install
hint) until its sidecar is live, and the inspector surface **auto-hides**
if the sidecar goes away — so you never see a detector you can't run.

| Settings flag | Surfaces these detectors |
|---|---|
| `experimentalSpanFamily` | Silero-VAD, JDCNet, PANNs, HPSS percussive |
| `experimentalCueExtras` | BeatNet, basic-pitch, librosa key, autochord, librosa onsets |
| `experimentalLoopFamily` | chroma-autocorrelation loop finder |
| `experimentalLyricsFamily` | Whisper-base transcription |

Without the profile running, the matching `/api/<family>/*` calls return
503 and the Initialize-models panel reads **Server off** — dimmed buttons,
no broken state.

Deep dive:
[INSTALL.md](https://github.com/sapirca/timecues-studio/blob/main/INSTALL.md)
for the canonical install matrix and per-feature pip recipes, and
[Experimental models](/timecues/experimental/) for the per-detector
reference (licences, weight sizes, output schemas).

## Settings — the complete tour

![The Settings page overview](timecues/images/settings-overview.png)
*The Settings page — the role banner plus the five collapsible, color-coded categories.*

Every personal preference and corpus-wide knob is on the Settings
page. The page is **self-saving** — there's no Save button; a
transient *Saved* pill flashes after every write. Personal preferences
land in your browser's `localStorage` under `timecues.settings.v1`;
corpus-wide settings (vocabularies, BPM defaults, access list) write
through to `data/dataset-config.json` on the server.

### The role banner

A colored banner at the top of the page tells you your current access
tier and bullets out what you can do at that tier. Out-of-tier
sections elsewhere on the page stay visible (so you know what's
there) but are interaction-suppressed with an **Admin only** pill.

| Tier | Banner accent | Headline capabilities |
|---|---|---|
| **Admin** | amber | Manage members, configure corpus-wide vocabularies, upload/export, clear caches, factory-reset the corpus. |
| **Researcher** | violet | Full corpus access, run any algorithm, view every annotator's output, upload/export. *Cannot* manage members or change dataset defaults. |
| **Team** | cyan | Full corpus access for your own annotations. *Cannot* see other annotators' work or run admin actions. |
| **Public** | slate | Annotate the shipped default songs only. Other corpus features unlock once an admin adds you to the team. |

### The five categories

Below the banner the page is grouped into five color-coded
collapsible categories. Only **Annotator profile** is expanded by
default — click any other section's chevron-and-title to open it.

#### 👤 User info  *(cyan)*

![User info settings](timecues/images/settings-theme.png)
*User info — your Annotator profile plus the dark / light / system theme switch.*

| Panel | Tier | What's inside |
|---|---|---|
| **Annotator profile** | all | Display name, email (auto-filled from Google sign-in), free-text role and affiliation, read-only id + auth method. Requires clicking *Save profile* (the only setting on the page that's not auto-saving). |
| **Theme** | all | Color scheme radio — `dark` / `light` / `system`. Default `dark`. `system` follows your OS `prefers-color-scheme`. |

#### ✎ Annotation  *(indigo)*

![Default signals settings](timecues/images/settings-default-signals.png)
*Annotation — the master overlay toggle, the twelve signal-row defaults, and the 3-Band palette.*

![Vocabularies and taxonomies settings](timecues/images/settings-vocabularies-taxonomies.png)
*Vocabularies & taxonomies — section, cue, and span labels, each with inline (admin) dataset-default controls.*

Everything that customizes how *you personally* see the workspace
and the annotation editors. Strictly browser-local — nothing here
syncs to the corpus.

| Panel | What's inside |
|---|---|
| **Display & playback** | Sidebar collapsed by default, show beat grid by default, default playback rate slider (0.5× – 2.0×, step 0.05, default 1.00×). |
| **Default signals** | Master "Signal overlays on" toggle plus 12 sub-toggles for which signal rows are pre-checked in the SIGNALS dropdown (3-Band waveform, Spectrogram, Cepstrogram/MFCC, Chromagram, Tempogram, SSM, Energy/RMS, Brightness, Novelty, Onsets, Spectral Flux, EQ). Plus a 3-Band palette picker (`Classic` / `Cool` / `Sunset` / `Forest` / `Mono`). |
| **Annotations — display** | Per-layer visibility defaults (Manual / Eye / Auto-guess) plus a time-unit picker for annotation editors (`Milliseconds` or `Beats & bars`). |
| **Vocabularies & taxonomies** | All label vocabularies in one place. Section vocabulary (genre cards plus a custom textarea), cue vocabulary, span vocabulary. Each row has a *Save as dataset default* / *Clear dataset default* button **visible only to admins**, plus a *Local override* pill that appears next to your row when your local value diverges from the admin default. |
| **Loops** | Default loop names, default cue labels for loops, opt-in for the loops/patterns marker family (experimental). |
| **BPM & grid protection (personal)** | When on, prevents accidental BPM or Grid Offset edits — the field becomes read-only until you toggle it back off. Useful once a song is fully annotated. |
| **Experimental annotation types** | Per-family feature flags — Loops, Patterns, Cue Extras, Span layers, etc. Off by default. Switching one on reveals its UI surface across the app. |

#### 🔬 Research  *(violet)*

![Research settings](timecues/images/settings-default-algorithms.png)
*Research — which detectors are pre-ticked in Algorithm Inspect, plus BPM-detection and Auto-guess defaults.*

Algorithm and detector defaults. **Visible to all tiers but
read-only for Team / Public** — each row carries an *Admin only*
pill at those tiers.

| Panel | What's inside |
|---|---|
| **Default algorithms** | Which algorithms are pre-ticked in Algorithm Inspect when a song opens. The order matters — the first ticked algorithm becomes the default reference in the diff readout. |
| **BPM detection** | Per-detector enable toggles (`client-wabd`, `librosa-beat-track`, `librosa-tempo-static`, `librosa-tempo-dynamic`, `madmom-rnn-beats`, `madmom-tempo`). Disabled detectors don't appear in the chip row. Useful for turning off detectors you don't trust on your corpus. |
| **Auto-guess defaults** | Default cluster tolerance τ in seconds (default 3), default minimum agreement count (default 1), default source-detector subset (which of the 30+ detectors feed into Auto-guess by default). |
| **Optional GPU tooling** | When the GPU profile is enabled at compose time, toggles here let you opt specific algorithms (allin1, demucs) into GPU acceleration. No effect when the profile is off. |

#### 🛡 Corpus management  *(amber)*

![Admin & access settings](timecues/images/settings-admin-access.png)
*Admin & access — the corpus display name and the per-email four-tier People list.*

![Storage stats settings](timecues/images/settings-storage-stats.png)
*Storage stats — on-disk usage by data bucket, plus export and per-category cache clears.*

**Admin-only.** Every panel here writes through to the server (i.e.
to `data/dataset-config.json`) and affects every annotator.

| Panel | What's inside |
|---|---|
| **Admin & access** | The corpus's display name, plus the **People** list — one row per email, four-tier dropdown (admin / researcher / team / public). Adding an email here is what unlocks an annotator on first sign-in. Removing an email demotes that annotator to Public the next time they sign in. |
| **Storage stats** | A read-out of total disk usage by `data/` subtree (songs, annotations, algorithm-outputs, stems, song-info), plus an **Export everything** button (JSON / Audacity / Sonic Visualiser / JAMS / MIDI / REAPER) and per-category **Clear cache** buttons. |

> Corpus-wide vocabulary defaults *used to* live here in a standalone
> *Dataset defaults — corpus-wide vocabularies* section. That was
> retired in 2026-05-18 — every admin "Save as dataset default" /
> "Clear dataset default" button now lives inline under the field it
> applies to in **Annotation → Vocabularies & taxonomies**.

#### ⚠ Danger Zone  *(rose)*

![Personal danger zone](timecues/images/settings-personal.png)
*Danger Zone — Reset to defaults, a personal reset that only affects this browser.*

![Corpus-wide danger zone](timecues/images/settings-corpus-wide.png)
*Danger Zone — corpus-wide destructive actions (clear caches, factory-reset), admin only.*

Destructive actions, split in two:

| Subpanel | Who can use it | What's there |
|---|---|---|
| **Personal — this browser only** | all | *Reset to defaults* — wipes `timecues.settings.v1` and restores every preference to the values in `DEFAULT_SETTINGS`. Annotator profile is unaffected (it's stored elsewhere). |
| **Corpus-wide — affects every annotator** | admin only | *Clear all algorithm caches*, *Clear all annotations for one annotator*, *Factory-reset the corpus* (drops the People list, vocabularies, defaults — leaves audio and annotations intact). |

### Self-save and the "Saved" pill

Every change other than Annotator profile commits immediately. The
*Saved* pill flashes for ~600 ms top-right after a write so you know
the value persisted. There's no "discard changes" — undo is by
re-toggling, or by *Reset to defaults* in the Danger Zone for a wider
revert.

### Where settings actually live

| Scope | Storage |
|---|---|
| Personal preferences | `localStorage` key `timecues.settings.v1` (one JSON blob). |
| Annotator profile | `AnnotatorContext` — separate `localStorage` key, requires *Save profile* click. |
| Dataset defaults + People list | `data/dataset-config.json` on the server. Edits via the inline admin buttons hit `PUT /api/dataset-config`. |
| Authentication | Google OAuth session cookie. Cleared on sign-out. |

### Common tasks — where to click

- **Make spectrogram on by default** → ✎ Annotation → Default
  signals → toggle *Spectrogram* on.
- **Switch the workspace to light mode** → 👤 User info → Theme →
  radio: `light`.
- **Add a researcher to the team** → 🛡 Corpus management → Admin &
  access → *Add row*, type email, tier dropdown → `researcher`.
- **Lock BPM on a finalized song** → ✎ Annotation → BPM & grid
  protection (personal) → toggle on.
- **Make `madmom-rnn-beats` the only BPM detector** → 🔬 Research →
  BPM detection → toggle every other detector off.
- **Add a custom section label like `pre-chorus`** to the corpus →
  ✎ Annotation → Vocabularies & taxonomies → Section vocabulary →
  *Custom* card → edit the textarea → (admin) *Save as dataset
  default*.
- **Export the whole dataset to JAMS** → 🛡 Corpus management →
  Storage stats → *Export everything* → JAMS.
- **Reset my preferences but keep my annotations** → ⚠ Danger Zone
  → Personal — this browser only → *Reset to defaults*.

Deep dive: [Settings — the full reference](/timecues/user-guide/#settings)
in the user guide enumerates every key, default, and the underlying
storage shape.
