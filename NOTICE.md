# Third-Party Notices

TimeCues Studio bundles, links against, or downloads at runtime a number of
third-party software libraries and pretrained model checkpoints. This file
acknowledges the upstream licenses and flags a small number of constraints
that downstream redistributors should be aware of.

The TimeCues Studio source code itself is licensed under the MIT License —
see [LICENSE](LICENSE).

## Bundled runtime dependencies

### Web app (Node / npm)

| Package | License |
|---|---|
| React, ReactDOM, React Router | MIT |
| Vite, Vitest, TypeScript, Tailwind CSS, PostCSS, autoprefixer | MIT |
| @codemirror/\*, @uiw/react-codemirror | MIT |
| @radix-ui/react-dialog | MIT |
| wavesurfer.js | BSD-3-Clause |
| papaparse | MIT |
| jszip | MIT (dual-licensed; MIT chosen) |
| realtime-bpm-analyzer | MIT |
| web-audio-beat-detector | MIT |
| @astrojs/starlight, astro | MIT |
| sharp | Apache-2.0 |
| Playwright, jsdom (dev only) | Apache-2.0 / MIT |

### Python sidecars (pip)

| Package | License |
|---|---|
| numpy, scipy, scikit-learn, soundfile, ruptures | BSD |
| librosa | ISC |
| audioread, pytest, beautifulsoup4 | MIT |
| requests | Apache-2.0 |
| mir_eval | MIT |
| demucs | MIT |
| pyloudnorm | MIT |
| allin1, natten | MIT |
| madmom (CPJKU fork: `github.com/CPJKU/madmom`) | BSD-3-Clause |
| beat-this (`github.com/CPJKU/beat_this`) | MIT |
| pyaudio (BeatNet's realtime input; stubbed out for offline use — see `tools/python/pyaudio_shim.py`) | MIT |
| Cython (build-time prereq for the CPJKU madmom fork in the `beatnet` / `beat-transformer` images) | Apache-2.0 |
| tensorflow (`~=2.14` in the Python 3.11 venv basic-pitch runs on) | Apache-2.0 |
| setuptools (pinned `<81` in the sidecar venvs — older deps import `pkg_resources`, which 81 removed) | MIT |
| torch, torchaudio, torchcodec (CPU wheels in the experimental sidecars) | BSD-3-Clause / BSD-2-Clause / BSD-3-Clause |
| openai-whisper, tiktoken (`lyrics` sidecar) | MIT |
| faster-whisper, ctranslate2 (Ivrit on int8 weights, `lyrics` sidecar) | MIT |
| transformers (converts Ivrit, backs the CTC aligner; `lyrics` sidecar) | Apache-2.0 |
| ctc-forced-aligner (`github.com/MahmoudAshraf97/ctc-forced-aligner`) | BSD-2-Clause |
| panns-inference (`panns` sidecar) | MIT |
| PyYAML (deploy tooling only: `archive/gcp/sidecar_images.py` in Cloud Build) | MIT |

All of the above are MIT-compatible and may be redistributed under the terms
of TimeCues Studio's MIT license, subject to preserving their upstream copyright
notices (which `pip` and `npm` retain automatically inside each package's
installation directory).

### System packages in the Docker images (apt)

| Package | License | Used by |
|---|---|---|
| git | GPL-2.0 | `web` image — shared-song annotation history |
| ffmpeg (Debian build) | LGPL-2.1+ / GPL-2.0+ | `web` image — re-encodes an uploaded VBR mp3 to constant bitrate; `core-mir` and other sidecar images — audio decoding |

These are installed from the Debian archive and run as separate programs; no
TimeCues code links against them, so their licenses do not reach the MIT
source. A redistributed image carries them under their own terms, with the
corresponding source available from Debian.

## Optional, opt-in dependencies — not bundled

Some advanced features are gated behind `try / except ImportError` blocks and
are **not** installed by default. Installing them is the user's choice and
subjects the user's local installation to the upstream package's license:

| Package | License | What it unlocks |
|---|---|---|
| **Essentia** | **AGPL-3.0** | `danceability`, `dynamic_complexity`, `inharmonicity` features in [tools/python/mir_server.py](tools/python/mir_server.py) |
| **autochord** + the **NNLS-Chroma** Vamp plugin | autochord: MIT · NNLS-Chroma: **GPL** | the `autochord-chords` detector in [tools/python/cue_extras_server.py](tools/python/cue_extras_server.py) |

If you `pip install essentia`, your running deployment must comply with the
AGPL. For most research / single-host evaluator setups this is a non-issue;
for SaaS redistribution it is. TimeCues Studio itself does not require or
import Essentia at install time.

**autochord** is labelled MIT, but what it actually runs on is the NNLS-Chroma
Vamp plugin (Mauch & Dixon, QMUL), which is GPL — autochord's wheel carries a
Linux x86-64 build of it inside the package. So neither `run.sh` nor any
Dockerfile or requirements file installs it. Without it, `autochord-chords`
shows *Deps missing*; every other detector is unaffected. To opt in, install
it into the interpreter the cue-extras sidecar runs on — the Python 3.11 venv
`run.sh --all` builds (`.cache/py311-cue/`) on a Python 3.12+ host, otherwise
your main interpreter:

```bash
PY=.cache/py311-cue/bin/python   # or your main python on 3.11 and older
uv pip install --python "$PY" numpy "setuptools<81"
uv pip install --python "$PY" --no-build-isolation "tensorflow<2.16" vamp autochord
```

The pins matter: autochord's chord model is a legacy Keras-2 SavedModel that
TensorFlow 2.16+ (Keras 3) cannot load, autochord imports `pkg_resources`
(gone in setuptools 81), and `vamp`'s source build needs numpy present without
declaring it. On **macOS or ARM Linux** the bundled plugin will not load; get a
build of NNLS-Chroma for your platform (from the Vamp plugin pack at
[vamp-plugins.org](https://www.vamp-plugins.org/), or built from source) and
put it on the Vamp path — `~/Library/Audio/Plug-Ins/Vamp/` on macOS,
`~/vamp/` on Linux. In Docker, add the second line to a derived image of
`docker/cue-extras.Dockerfile`.

## Vendored third-party source

Two model files are copied into this tree rather than installed, because
upstream ships no package. Each carries its upstream LICENSE next to the
code, and the subpackage docstring records any change made to it.

| Path | Upstream | License |
|---|---|---|
| [tools/python/vendor/beat_transformer/](tools/python/vendor/beat_transformer/) | [zhaojw1998/Beat-Transformer](https://github.com/zhaojw1998/Beat-Transformer) — `code/DilatedTransformer.py`, `code/DilatedTransformerLayer.py` | MIT (© 2022 Zhao Jingwei) |

Both files are byte-for-byte upstream except one line: the flat
`from DilatedTransformerLayer import ...` is made relative so the files
import as a package. The change is marked inline.

## Pretrained model checkpoints

The code is MIT-licensed, but several models download **pretrained weights**
at runtime from upstream releases. Weights carry their own licenses, which
the user accepts when the code triggers the download:

| Model | Code license | Weight license | Used by |
|---|---|---|---|
| Demucs (Hybrid Transformer v4) | MIT | MIT | `stems` daemon, `tools/run_demucs_songs.py` |
| `allin1` (`mir-aidj/all-in-one`) | MIT | See upstream release notes | `tools/run_allin1.py`, fold-comparison panel |
| BeatNet | MIT | See upstream release notes | experimental `beatnet` sidecar |
| Beat This! (`CPJKU/beat_this`) | MIT | MIT | experimental `beat-this` sidecar |
| Beat Transformer (`zhaojw1998/Beat-Transformer`) | MIT | MIT | experimental `beat-transformer` sidecar |
| Silero-VAD | MIT | MIT | experimental `span` sidecar |
| JDCNet (scaffolded) | MIT | See upstream release notes | experimental `span` sidecar |
| CPJKU-madmom-fork pretrained beat trackers | BSD-3-Clause | Mixed — some checkpoints historically carried CC-BY-NC restrictions | `bpm` daemon |
| Whisper `base` (`openai/whisper`) | MIT | MIT | experimental `lyrics` sidecar (`whisper-base`) |
| Ivrit — `ivrit-ai/whisper-large-v3-turbo`, converted to int8 at image build | MIT | Apache-2.0 | experimental `lyrics` sidecar (`ivrit`) |
| `facebook/wav2vec2-base-960h` (pinned so the CC-BY-NC MMS_FA default is never fetched) | Apache-2.0 | Apache-2.0 | experimental `lyrics` sidecar (`ctc-forced-aligner`) |

Researchers redistributing reproducibility bundles that include downloaded
weights should verify each model's then-current upstream license. The
TimeCues Studio source distribution does **not** include any pretrained
weights — they are fetched on first use and cached on disk.

## Audio recordings

TimeCues Studio's evaluation corpus references commercial electronic dance
music tracks. The dataset is **not** published as part of this distribution —
neither the audio files nor any track-identifying metadata (YouTube / Spotify
links, titles, artist names) are redistributed. Copyright in audio recordings
remains with the respective rights-holders. The release-prep tooling itself is
maintained separately from the OSS distribution and is not shipped here.

## Verification

To regenerate this notice from the current dependency manifests:

```bash
# Node
cd web-app && npx license-checker --production --summary
cd landing  && npx license-checker --production --summary

# Python
pip install pip-licenses
pip-licenses --from=mixed --format=markdown --packages \
  $(awk -F'[<>=#]' '/^[a-zA-Z]/ {print $1}' tools/python/requirements.txt)
```

The handwritten table above is the source of truth at the time of release;
the commands above are provided for downstream re-verification.
