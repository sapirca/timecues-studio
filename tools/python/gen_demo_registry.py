"""Regenerate data-default/demo-custom-registry.json.

The static Cloudflare demo mirror has no Python backend, so it cannot call the
custom-scripts server's registry endpoint. assemble-cf-demo.mjs bakes a
committed snapshot of that registry instead (filtered to detectors that have a
demo output) and serves it at /api/custom-scripts. This script produces that
snapshot from the live detector metadata via scan().

Run from the repo root:
    PYTHONPATH=tools/python python tools/python/gen_demo_registry.py

The `file` field is reduced to its basename so no local/maintainer path leaks
into the public OSS mirror.
"""

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools" / "python"))

from custom_server import _filtered_registry  # noqa: E402

OUT = REPO_ROOT / "data-default" / "demo-custom-registry.json"


def main() -> None:
    reg = _filtered_registry(include_experimental_loops_patterns=True)
    for d in reg:
        d["file"] = os.path.basename(d.get("file", ""))
    reg = [d for d in reg if d.get("status") == "ok"]
    out = {
        "_comment": (
            "Demo-only snapshot of the custom-detector registry. Baked into the "
            "static Cloudflare mirror by web-app/scripts/assemble-cf-demo.mjs, "
            "which filters it to detectors that actually have a demo output and "
            "serves it at /api/custom-scripts. Regenerate when detectors change: "
            "PYTHONPATH=tools/python python tools/python/gen_demo_registry.py. "
            "The live VM builds this registry live via scan(); only the "
            "backend-less mirror needs it."
        ),
        "detectors": sorted(reg, key=lambda d: d["name"]),
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(f"wrote {len(reg)} detectors to {OUT.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
