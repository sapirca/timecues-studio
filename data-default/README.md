# data-default/

Read-only seed dataset shipped inside the docker image. Demo / public-tier
requests resolve exclusively under this directory; team / researcher / admin
requests resolve exclusively under `data/`. The two corpora are never merged
and there is no cross-corpus fallback in either direction — see the strict
separation contract in `corpusForReq()` in `web-app/vite.config.ts`.

Layout mirrors `data/`:

```
data-default/
  songs/<slug>/<file>.mp3          # audio (CC0-licensed only)
  song-info/<slug>.json            # metadata (bpm, time signature, license)
  annotations/
    manual/<annotator>/<slug>.json
    eye/<annotator>/<slug>.json
    auto-guess/<annotator>/<slug>.json
```

## Licensing

Every audio file in `songs/` MUST be CC0 / Public Domain so it can ship
freely with the container. The license is recorded in each track's
`song-info/<slug>.json` (`license`, `license_url`, `source` fields).

Current contents:

| Slug | Artist | Title | License |
| --- | --- | --- | --- |
| `edm-at-midnight` | Play House | EDM At Midnight | CC0 1.0 |
| `phonk-remix` | HoliznaCC0 | Phonk Remix | CC0 1.0 |
| `pantheon` | HoliznaCC0 | Pantheon | CC0 1.0 |

## Adding more defaults

1. Drop the audio under `songs/<slug>/<filename>.mp3`.
2. Add `song-info/<slug>.json` with at minimum `song`, `license`,
   `license_url`, `source`, `artist`, `title`.
3. Optionally add seed annotations under `annotations/<kind>/<annotator>/<slug>.json`.

## No cross-corpus fallback

A team / researcher / admin user with `data/songs/<slug>/` populated does
**not** see anything under `data-default/` — the team corpus stands on its
own. Likewise, demo / public visitors do not see anything under `data/`.
Slug collisions across the two trees are harmless because the two corpora
are served to disjoint sets of requests.
