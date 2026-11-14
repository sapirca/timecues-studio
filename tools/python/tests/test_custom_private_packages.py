"""A package marked "public": false is seen only by signed-in team members.

The demo visitor and an anonymous caller get a registry without its detectors
and a cache miss for its outputs — through the real handler, not a helper.
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

MEMBER = "member@example.com"
DEMO = "demo-anonymous"


def detector(name: str) -> str:
    return (
        "from custom_api import CustomDetector\n"
        "class D(CustomDetector):\n"
        f"    name = {name!r}\n"
        f"    label = {name!r}\n"
        "    output_kind = 'cue'\n"
        "    def detect(self, ctx):\n"
        "        return []\n"
    )


def put(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


@pytest.fixture
def server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import custom_loader
    import custom_runner
    import custom_server

    user, default = tmp_path / "custom", tmp_path / "custom-default"
    default.mkdir()
    put(user / "secret" / "package.json", json.dumps({"title": "Secret", "public": False}))
    put(user / "secret" / "hidden_det.py", detector("hidden_det"))
    put(user / "open" / "package.json", json.dumps({"title": "Open"}))
    put(user / "open" / "shown_det.py", detector("shown_det"))
    results = tmp_path / "results"
    for name in ("hidden_det", "shown_det"):
        put(results / name / "song.json", json.dumps({"detector": name, "items": []}))
    config = tmp_path / "dataset-config.json"
    config.write_text(json.dumps({"adminEmails": [MEMBER]}))

    monkeypatch.setattr(custom_loader, "CUSTOM_DIR", user)
    monkeypatch.setattr(custom_loader, "DEFAULT_CUSTOM_DIR", default)
    monkeypatch.setattr(custom_runner, "CUSTOM_RESULTS_DIR", results)
    monkeypatch.setattr(custom_runner, "DEFAULT_CUSTOM_RESULTS_DIR", tmp_path / "none")
    monkeypatch.setattr(custom_server, "DATASET_CONFIG_PATH", config)
    monkeypatch.setattr(custom_server, "_private_names", None)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), custom_server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    custom_loader._activate_package(None)


def get(base: str, path: str, who: str | None):
    req = urllib.request.Request(base + path, headers={"X-Annotator-Id": who} if who else {})
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as err:
        return err.code, None


def names(base: str, who: str | None) -> set[str]:
    return {d["name"] for d in get(base, "/api/custom-scripts", who)[1]["detectors"]}


def test_a_member_sees_the_private_package(server):
    assert names(server, MEMBER) == {"hidden_det", "shown_det"}
    assert get(server, "/api/custom-scripts/result/hidden_det/song", MEMBER)[1]["detector"] == "hidden_det"
    pkgs = {p["id"]: p["public"] for p in get(server, "/api/custom-scripts/packages", MEMBER)[1]["packages"]}
    assert pkgs == {"secret": False, "open": True}


@pytest.mark.parametrize("who", [DEMO, None])
def test_the_demo_and_anonymous_never_see_it(server, who):
    assert names(server, who) == {"shown_det"}
    assert get(server, "/api/custom-scripts/result/hidden_det/song", who) == (200, None)
    assert get(server, "/api/custom-scripts/result/shown_det/song", who)[1]["detector"] == "shown_det"
    assert get(server, "/api/custom-scripts/file/hidden_det", who)[0] == 404
    assert get(server, "/api/custom-scripts/packages/secret/export", who)[0] == 404
    pkgs = {p["id"] for p in get(server, "/api/custom-scripts/packages", who)[1]["packages"]}
    assert pkgs == {"open"}


def test_hidden_before_any_registry_read(server):
    # A hand-crafted request that skips the registry still gets nothing.
    assert get(server, "/api/custom-scripts/result/hidden_det/song", DEMO) == (200, None)


def test_a_per_stem_run_of_a_private_detector_is_hidden(server):
    import custom_server
    custom_server._remember_private(custom_server.scan())
    assert custom_server._is_private_detector("hidden_det__vocals")
    assert not custom_server._is_private_detector("shown_det__vocals")
