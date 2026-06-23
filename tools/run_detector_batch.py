#!/usr/bin/env python3
"""
Generic corpus batch driver for the experimental MIR sidecar servers.

Every experimental sidecar exposes the same contract:
    POST /api/<family>/detect  { "slug": str, "algo": str, "force"?: bool }
and writes its result to data/algorithm-outputs/<family>/<slug>/<algo>.json
itself (the data dir is bind-mounted into the container). So a batch sweep is
just: for every song folder, POST each algo. Cached results are returned
without recompute unless --force.

Run this INSIDE the target sidecar container so localhost:<port> reaches that
server, e.g.:
    docker exec timecues-span python /tmp/run_detector_batch.py \
        --port 8009 --family span --algos silero-vad,jdcnet-voicing

The driver only needs the data mount + a running server on localhost; it has no
heavy deps (stdlib urllib), so it runs in any of the sidecar images.
"""
import argparse
import json
import os
import urllib.request

SONGS = "/app/data/songs"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--family", required=True, help="URL family, e.g. span / cue-extras / lyrics")
    p.add_argument("--algos", required=True,
                   help="comma-separated algo ids; use a single dummy value for "
                        "servers that ignore 'algo' (bpm, beatnet, mir)")
    p.add_argument("--endpoint", default="detect",
                   help="path verb after the family (default: detect; mir uses 'extract')")
    p.add_argument("--stem", default="mix",
                   help="run against a Demucs stem instead of the full mix: "
                        "mix (default) | vocals | drums | bass | other. The stem "
                        "must already be cached under web-app/public/stems/<slug>/ "
                        "(or data-default/stems/<slug>/); results are written to "
                        "<family>/<slug>/<algo>__<stem>.json.")
    p.add_argument("--force", action="store_true")
    p.add_argument("--slugs", default="",
                   help="comma-separated song slugs to limit the sweep to "
                        "(default: every song folder under /app/data/songs).")
    p.add_argument("--timeout", type=int, default=1800, help="per-request seconds (whisper is slow)")
    args = p.parse_args()

    algos = [a for a in args.algos.split(",") if a]
    only = {s for s in args.slugs.split(",") if s}
    slugs = sorted(d for d in os.listdir(SONGS) if os.path.isdir(os.path.join(SONGS, d)))
    if only:
        missing = only - set(slugs)
        if missing:
            print(f"WARN: unknown slugs ignored: {sorted(missing)}", flush=True)
        slugs = [s for s in slugs if s in only]
    url = f"http://localhost:{args.port}/api/{args.family}/{args.endpoint}"
    print(f"START {args.family}: {len(slugs)} songs x {len(algos)} algos "
          f"= {len(slugs)*len(algos)} runs (stem={args.stem})", flush=True)

    ok = err = 0
    for i, slug in enumerate(slugs, 1):
        for algo in algos:
            body = json.dumps({"slug": slug, "algo": algo,
                               "stem": args.stem, "force": args.force}).encode()
            req = urllib.request.Request(
                url, data=body, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=args.timeout) as r:
                    json.loads(r.read())
                ok += 1
            except Exception as e:
                err += 1
                print(f"[{i}/{len(slugs)}] {slug}/{algo}: ERR {e}", flush=True)
        if i % 10 == 0:
            print(f"...{i}/{len(slugs)} songs (ok={ok} err={err})", flush=True)
    print(f"DONE {args.family} ok={ok} err={err}", flush=True)


if __name__ == "__main__":
    main()
