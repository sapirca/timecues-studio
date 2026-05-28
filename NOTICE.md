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

All of the above are MIT-compatible and may be redistributed under the terms
of TimeCues Studio's MIT license, subject to preserving their upstream copyright
notices (which `pip` and `npm` retain automatically inside each package's
installation directory).

## Optional, opt-in dependencies — not bundled

Some advanced features are gated behind `try / except ImportError` blocks and
are **not** installed by default. Installing them is the user's choice and
subjects the user's local installation to the upstream package's license:

| Package | License | What it unlocks |
|---|---|---|
| **Essentia** | **AGPL-3.0** | `danceability`, `dynamic_complexity`, `inharmonicity` features in [tools/python/mir_server.py](tools/python/mir_server.py) |

If you `pip install essentia`, your running deployment must comply with the
AGPL. For most research / single-host evaluator setups this is a non-issue;
for SaaS redistribution it is. TimeCues Studio itself does not require or
import Essentia at install time.

## Pretrained model checkpoints

The code is MIT-licensed, but several models download **pretrained weights**
at runtime from upstream releases. Weights carry their own licenses, which
the user accepts when the code triggers the download:

| Model | Code license | Weight license | Used by |
|---|---|---|---|
| Demucs (Hybrid Transformer v4) | MIT | MIT | `stems` daemon, `tools/run_demucs_songs.py` |
| `allin1` (`mir-aidj/all-in-one`) | MIT | See upstream release notes | `tools/run_allin1.py`, fold-comparison panel |
| BeatNet | MIT | See upstream release notes | experimental `beatnet` sidecar |
| Silero-VAD | MIT | MIT | experimental `span` sidecar |
| JDCNet (scaffolded) | MIT | See upstream release notes | experimental `span` sidecar |
| CPJKU-madmom-fork pretrained beat trackers | BSD-3-Clause | Mixed — some checkpoints historically carried CC-BY-NC restrictions | `bpm` daemon |

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
