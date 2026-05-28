# Custom detectors

User-authored Python detectors that plug into the TimeCues Studio inspector
without forking the repo. Drop a `.py` file in **this folder**; it shows up
as either a read-only algorithm row, an editable annotation tab, or both.

If you are an LLM (Claude Code) being asked to *write* a detector, **stop
reading this file** and open [CLAUDE.md](./CLAUDE.md) — that's the contract
reference. This README is for someone wiring up or maintaining the system.

---

## What's in this folder

| File | Audience | Purpose |
|---|---|---|
| `README.md` (this file) | Human / repo reader | Architecture overview, run/verify recipe, where things live. |
| [`CLAUDE.md`](./CLAUDE.md) | Detector author (human or LLM) | The contract. Every input/output field, every bound, every validation rule, two worked examples. |
| [`template.py`](./template.py) | Detector author | Copy-paste starter; also registered as a runnable detector named `template` so you can see one end-to-end. |
| [`example_energy.py`](./example_energy.py) | Detector author | Working boundary detector based on energy-curve jumps; registered as `example_energy`. |
| `__init__.py` | (mechanical) | Empty — keeps Python happy. |
| `<your_name>.py` | You | The actual user-authored detector(s). |

Every `.py` file in this folder is auto-registered. The loader skips only
`__init__.py` and dotfiles. Duplicate `name` values across files are flagged
on every conflicting file.

---

## Quick start

```bash
# 1. Copy the template (or write one from scratch).
cp tools/python/custom/template.py tools/python/custom/my_detector.py
$EDITOR tools/python/custom/my_detector.py

# 2. Start the dev server (auto-spawns the Python custom server on :8005).
cd web-app && npm run dev

# 3. Open the management page, click Run, watch validation.
open http://localhost:5173/custom
```

Or, if you'd rather upload through the UI, click **Upload .py** on the
`/custom` page and paste the source — the server writes it into this folder
and validates it immediately.

---

## How it fits together

```
┌──────────────────────┐  drop .py file        ┌──────────────────┐
│  user / Claude Code  │ ─────────────────────▶│ tools/python/    │
└──────────────────────┘                       │ custom/<name>.py │
            │                                  └──────────────────┘
            │ HTTP via /api/custom-scripts/*           │
            ▼                                          ▼
┌──────────────────────┐    discovers + validates    ┌──────────────────┐
│ web-app /custom page │ ──────────────────────────▶ │ custom_loader.py │
│ (CustomScriptsPage)  │                             │ scan() / load    │
└──────────────────────┘                             └──────────────────┘
            │                                                │
            │ POST /run/:name?slug=...                        │ load_detector(name)
            ▼                                                 ▼
┌──────────────────────┐  builds DetectionContext   ┌─────────────────────┐
│  custom_server.py    │ ──────────────────────────▶│ custom_runner.py    │
│  (port :8005)        │  catches exceptions,       │ validates each item │
└──────────────────────┘  validates output           └─────────────────────┘
            │                                                 │
            │  envelope written to                            │
            ▼  data/algorithm-outputs/custom/<name>/<slug>.json
┌──────────────────────────────────────────────────────────────┐
│  Frontend reads via /api/custom-scripts/result/:name/:slug   │
└──────────────────────────────────────────────────────────────┘
```

The contract (`CustomDetector` class + `Boundary` / `Cue` dataclasses) is
defined once in [`tools/python/custom_api.py`](../custom_api.py) and is
*the* boundary the user can't change. Everything else — discovery, audio
loading, feature extraction, persistence — happens around it.

---

## File layout on disk

| Where | What |
|---|---|
| `tools/python/custom/<name>.py` | User-authored detector source. |
| `tools/python/custom_api.py` | Frozen public types. Users import only from here. |
| `tools/python/custom_loader.py` | Discovery + load-time validation. |
| `tools/python/custom_runner.py` | Run + run-time validation + persistence. |
| `tools/python/custom_server.py` | HTTP server on `:8005`. Auto-spawned by Vite in dev. |
| `data/algorithm-outputs/custom/<name>/<slug>.json` | Cached run envelopes (algorithm-mode). |
| `data/annotations/custom/<name>/<annotator>/<slug>.json` | Editable annotations (annotation-mode, when `is_annotation=True`). |

Paths are wired through [`tools/python/paths.py`](../paths.py) (Python side)
and [`web-app/dataPaths.ts`](../../../web-app/dataPaths.ts) (TS side). If
you move a folder, update those two files and nowhere else.

---

## Validation philosophy

The contract is strict because user code is untrusted-by-default:

- **Load-time** (in `custom_loader.py`): the file must define exactly one
  `CustomDetector` subclass. `name` must match `^[a-z][a-z0-9_-]{0,30}$`
  and be unique. `label` is non-empty and ≤ 80 chars. `output_kind` is one
  of `"boundary"` / `"cue"`. At least one of `is_algorithm` /
  `is_annotation` is `True`. `detect()` is overridden.
- **Run-time** (in `custom_runner.py`): every returned item is validated
  field-by-field against `Boundary` / `Cue`. Out-of-bounds times, wrong
  types, bad `importance` values — each produces a structured error with
  `{index, field, value, message}` and is dropped. Good items in the same
  list are kept.
- **Exceptions** inside `detect()` are caught and reported as `fatal` in
  the result envelope (with full traceback). The server keeps running.

The result envelope shape is documented in the docstring of
[`custom_runner.py`](../custom_runner.py) and mirrored on the TS side in
[`web-app/src/types/customScript.ts`](../../../web-app/src/types/customScript.ts).

---

## Verifying the system

```bash
# Unit tests for loader + runner validation.
python -m pytest tools/python/tests/ -q
# → 29 passed

# Live server smoke-test.
python tools/python/custom_server.py &
curl -s http://localhost:8005/api/custom-scripts | python -m json.tool

# Upload a deliberately-broken detector to see the error envelope.
curl -s -X POST http://localhost:8005/api/custom-scripts/upload \
  -H 'Content-Type: application/json' \
  -d '{"name":"BAD NAME","code":"from custom_api import CustomDetector\nclass X(CustomDetector): name=\"\"; label=\"\"; output_kind=\"section\"; is_algorithm=False; is_annotation=False"}' \
  | python -m json.tool
```

End-to-end against a real song:

```bash
# Pick any slug from data/songs/ or data-default/songs/.
SLUG=$(ls data/songs 2>/dev/null | head -1 || ls data-default/songs | head -1)
curl -s -X POST "http://localhost:8005/api/custom-scripts/run/example_energy?slug=$SLUG&force=1" \
  | python -m json.tool | head -40
```

(`example_energy` is shipped pre-registered, so you can run it without copying.
The `template` detector is also registered — useful for sanity-checking the
pipeline end-to-end. Both can be deleted from the `/custom` page when you no
longer need them.)

---

## When something is wrong

- **The `/custom` page is empty even though I have files.**
  The loader skips files starting with `_` or `.`, plus `__init__.py`. Rename.
- **Detector shows `Validation error`.**
  Open the row — every problem is listed inline (field name, bad value,
  exact rule violated). Fix and click **Reload**, or just save the file
  again from the upload form.
- **Detector shows `Load error`.**
  The file failed to import. Click the row — the error includes the
  exception type and (for syntax errors) the line number.
- **Run returns `fatal`.**
  Your `detect()` raised. The envelope's `fatal.traceback` has the full
  Python stack. The cached result file under
  `data/algorithm-outputs/custom/<name>/` records this so re-opening the
  page shows the same error.
- **Server won't start.**
  Custom server depends on `librosa` (and the rest of the audio stack
  declared in `tools/python/requirements.txt`). Without it, the server
  still boots but every run returns `fatal: ImportError`. Run
  `pip install -r tools/python/requirements.txt`.

---

## Adding a new feature to this system

| Want to… | Where to look |
|---|---|
| Change the input shape (`DetectionContext`) | Edit `custom_api.py` AND mirror in TS types AND update CLAUDE.md. Major version bump. |
| Add a new output kind beyond boundary / cue | Update `custom_api.py`, the validator in `custom_runner.py`, and the `output_kind` set in `custom_loader.py`. |
| Surface custom detectors in the inspector as annotation tabs | Wire `AnnotationType` in [InspectorPageV2.tsx](../../../web-app/src/pages/InspectorPageV2.tsx) — see the open follow-up in the project plan. |
| Change the result-envelope shape | `custom_runner.py` is the source of truth. Update `web-app/src/types/customScript.ts` and the rendering in `CustomScriptsPage.tsx`. |
