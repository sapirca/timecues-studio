#!/usr/bin/env python3
"""Custom-Detector Server.

Serves user-authored detector scripts dropped into tools/python/custom/.

Endpoints
---------
  GET    /api/custom-scripts                    → registry list (each file's status + manifest)
  GET    /api/custom-scripts/file/:name         → raw source of <name>.py (for the UI editor)
  POST   /api/custom-scripts/reload             → re-scan tools/python/custom/
  POST   /api/custom-scripts/upload             → body {name, code} → write file + reload
  DELETE /api/custom-scripts/:name              → remove file + cached results
  DELETE /api/custom-scripts/:name/outputs      → wipe algorithm cache + this annotator's
                                                   annotations for the detector (keeps the .py)
  POST   /api/custom-scripts/run/:name          → query ?slug=...&force=1 → run + persist
  GET    /api/custom-scripts/result/:name/:slug → cached envelope, or 200 + null when nothing cached

  GET    /api/custom-annotations/:name/:slug    → editable annotation copy (X-Annotator-Id),
                                                   or 200 + null when none saved yet
  POST   /api/custom-annotations/:name/:slug    → write
  DELETE /api/custom-annotations/:name/:slug    → delete

  GET    /api/detector-outputs/index            → {[detector_name]: [slug, ...]}
                                                    of edited (in-progress) detector outputs for the
                                                    annotator. Polled on song load.
  GET    /api/detector-outputs/:name/:slug      → the editable detector-output envelope, or null
                                                    when no copy-on-write file exists yet.
  POST   /api/detector-outputs/:name/:slug      → write the envelope (copy-on-write moment).
  DELETE /api/detector-outputs/:name/:slug      → wipe the editable copy (the algorithm cache is kept).

  Re-running a detector that already has an editable copy on disk returns
  409 Conflict unless `?confirm_overwrite=1` is passed. The UI surfaces this
  as a "this will overwrite existing edited output" warning that suggests
  renaming the detector (detector_v01 / detector_v02) or deleting the
  editable file first.

The result envelope shape and validation rules are documented in custom_runner.

Usage
-----
  python tools/python/custom_server.py
  # → http://localhost:8005
"""

from __future__ import annotations

import json
import os
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, unquote, urlsplit

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from custom_loader import (  # noqa: E402
    CUSTOM_DIR,
    EXPERIMENTAL_LOOPS_PATTERNS_KINDS,
    NAME_RE,
    scan,
)
from custom_runner import (  # noqa: E402
    delete_results_for,
    get_cached,
    run,
)
from paths import (  # noqa: E402
    CUSTOM_ANNOTATIONS_DIR,
    DATA_DIR,
    DETECTOR_OUTPUTS_DIR,
    safe_segment,
)

DATASET_CONFIG_PATH = DATA_DIR / "dataset-config.json"

PORT = 8005
ANNOTATOR_ID_RE = re.compile(r"^[a-z0-9._@+\-]+$")
MAX_SCRIPT_BYTES = 256 * 1024  # 256 KB ought to be enough for any single detector
MAX_ANNOTATION_BYTES = 4 * 1024 * 1024  # 4 MB

# The web app uses this fixed id for the synthesized "Demo visitor" identity.
# Anything reaching this server under that id must not be allowed to upload,
# delete, modify, or execute Python — the Playground attack surface. The Vite
# proxy enforces the same block one layer up; this is the defense-in-depth
# copy in case the Python server is ever exposed directly (e.g. inside a
# container network) or the proxy gate is removed.
DEMO_ANNOTATOR_ID = "demo-anonymous"


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _cors() -> dict:
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Annotator-Id",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    }


def _safe_annotator(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    v = raw.strip().lower()
    if not v or v in (".", "..") or "/" in v or "\\" in v:
        return None
    return v if ANNOTATOR_ID_RE.match(v) else None


def _safe_name(name: str) -> bool:
    return bool(NAME_RE.match(name))


def _safe_slug(slug: str) -> bool:
    # Use the shared validator so the proxy and sidecar agree on what a
    # valid slug looks like. Returns bool to keep the call-site shape.
    return safe_segment(slug) is not None


# ─── Tier resolution (mirror of tierForId in web-app/vite.config.ts) ─────────
# The web proxy is the only public entrypoint today, but the sidecar listens on
# the docker network and must enforce the same gate so a future misconfiguration
# (exposed port, co-located rogue container) can't bypass authorship rules.

def _read_dataset_config() -> Optional[dict]:
    try:
        if not DATASET_CONFIG_PATH.exists():
            return None
        return json.loads(DATASET_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _tier_for(annotator_id: Optional[str]) -> Optional[str]:
    """Returns 'admin' / 'researcher' / 'team' / None. Mirrors tierForId()."""
    if not annotator_id:
        return None
    # The synthetic demo id is always public — see DEMO_ANNOTATOR_ID note.
    if annotator_id == DEMO_ANNOTATOR_ID:
        return None
    cfg = _read_dataset_config()
    if not cfg:
        # Bootstrap mode: no config yet → first caller is admin so the deploy
        # can be configured. Same rule as the web side.
        return "admin"
    people = cfg.get("peopleByEmail")
    if isinstance(people, dict):
        entry = people.get(annotator_id)
        if isinstance(entry, dict):
            tier = entry.get("tier")
            if tier in ("admin", "researcher", "team"):
                return tier
        if people:
            return None
    admins = cfg.get("adminEmails") or []
    if annotator_id in admins:
        return "admin"
    team = cfg.get("teamEmails") or []
    if annotator_id in team:
        return "team"
    has_any = bool(admins) or bool(team) or bool(people)
    return None if has_any else "admin"


def _truthy(qs: dict[str, list[str]], key: str) -> bool:
    """Read a 0/1/true/false query-string flag. Missing → False."""
    raw = (qs.get(key, [""])[0] or "").strip().lower()
    return raw in ("1", "true", "yes")


def _filtered_registry(*, include_experimental_loops_patterns: bool) -> list[dict]:
    """Registry entries with loop/pattern detectors filtered out when the
    `experimentalLoopsAndPatterns` UI flag is off.

    Matches the gating used in web-app/src/components/inspector-v2/shared/
    tabConfig.ts — when the flag is off, the Loops/Patterns annotation tabs
    are hidden and so are the detectors that emit those kinds, keeping the
    registry and the UI consistent.
    """
    entries = scan()
    if not include_experimental_loops_patterns:
        entries = [
            e for e in entries
            if e.output_kind not in EXPERIMENTAL_LOOPS_PATTERNS_KINDS
        ]
    return [e.to_dict() for e in entries]


# ─── Custom-script source persistence ────────────────────────────────────────


def _resolve_script_file(name: str) -> Optional[Path]:
    """Find the .py file backing a detector whose class `name` is `name`.

    The class `name` attribute and the file stem are not required to match —
    a hand-created `blabla.py` with `name = "my_detector"` is legal. Walk the
    registry first; only fall back to `<name>.py` if scan() turned up nothing.
    """
    for entry in scan():
        if entry.name == name:
            p = Path(entry.file)
            if p.is_file():
                return p
    fallback = CUSTOM_DIR / f"{name}.py"
    return fallback if fallback.is_file() else None


def write_script(name: str, code: str) -> dict:
    """Write a detector source and return the registry entry for it.

    When a registry entry already exists with this class `name`, the file is
    rewritten in place at the existing path — even if its stem differs from
    `name` (e.g. a hand-created `blabla.py` whose class is named
    `my_detector`). Otherwise the file is created at `<name>.py`. This keeps
    the user's existing on-disk filename stable across edits without forcing
    a rename.

    Validates the name + body length here; defers everything else to scan().
    """
    if not _safe_name(name):
        raise ValueError(
            f"invalid name {name!r}: must match ^[a-z][a-z0-9_-]{{0,30}}$ — "
            "lowercase letters/digits/_/- only, starts with a letter, max 31 chars."
        )
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code must be a non-empty string.")
    if len(code.encode("utf-8")) > MAX_SCRIPT_BYTES:
        raise ValueError(f"code exceeds {MAX_SCRIPT_BYTES} bytes.")

    CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
    existing = _resolve_script_file(name)
    target = existing if existing is not None else (CUSTOM_DIR / f"{name}.py")
    target.write_text(code, encoding="utf-8")

    for entry in scan():
        if entry.name == name or Path(entry.file).stem == name:
            return entry.to_dict()
    # Should not happen — the file was just written.
    return {"name": name, "file": str(target), "status": "load_error",
            "errors": [{"index": None, "field": None,
                        "message": "loader did not see the file after write — try /reload",
                        "value": None}]}


_FLAG_RE = re.compile(
    r"^(?P<lead>[ \t]*)(?P<key>is_algorithm|is_annotation)(?P<gap>[ \t]*=[ \t]*)"
    r"(?:True|False)(?P<tail>[ \t]*(#.*)?)$",
    re.MULTILINE,
)


def patch_script_flags(name: str, *, is_algorithm: bool, is_annotation: bool) -> dict:
    """Rewrite is_algorithm / is_annotation on the named script and return its updated entry.

    Found via the regex above. Each match flips just the boolean literal; surrounding
    whitespace and any trailing inline comment are preserved verbatim. Raises if the
    file does not exist or either attribute line is missing (the contract requires both).
    """
    if not _safe_name(name):
        raise ValueError(f"invalid name {name!r}")
    if not (is_algorithm or is_annotation):
        raise ValueError("at least one of is_algorithm / is_annotation must be True.")

    target = _resolve_script_file(name)
    if target is None:
        raise FileNotFoundError(f"no detector with name={name!r} in {CUSTOM_DIR}")

    src = target.read_text(encoding="utf-8")
    values = {"is_algorithm": is_algorithm, "is_annotation": is_annotation}
    seen: set[str] = set()

    def _replace(m: "re.Match[str]") -> str:
        key = m.group("key")
        seen.add(key)
        literal = "True" if values[key] else "False"
        return f"{m.group('lead')}{key}{m.group('gap')}{literal}{m.group('tail')}"

    new_src = _FLAG_RE.sub(_replace, src)
    missing = [k for k in values if k not in seen]
    if missing:
        raise ValueError(
            f"could not find class attribute(s) {', '.join(missing)} in {name}.py — "
            "open the file in the editor and add them, then save."
        )

    if new_src != src:
        target.write_text(new_src, encoding="utf-8")

    for entry in scan():
        if entry.name == name or Path(entry.file).stem == name:
            return entry.to_dict()
    raise RuntimeError("loader did not see the file after patch — try /reload")


def delete_script(name: str) -> bool:
    if not _safe_name(name):
        return False
    target = _resolve_script_file(name)
    removed = False
    if target is not None:
        target.unlink()
        removed = True
    delete_results_for(name)  # also wipes cached algorithm-mode results
    return removed


def read_script(name: str) -> Optional[str]:
    if not _safe_name(name):
        return None
    target = _resolve_script_file(name)
    if target is None:
        return None
    try:
        return target.read_text(encoding="utf-8")
    except Exception:
        return None


# ─── Custom-annotation persistence (per-script + per-annotator) ──────────────


def _annotation_path(name: str, annotator: str, slug: str) -> Path:
    return CUSTOM_ANNOTATIONS_DIR / name / annotator / f"{slug}.json"


def read_annotation(name: str, annotator: str, slug: str) -> Optional[dict]:
    p = _annotation_path(name, annotator, slug)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def write_annotation(name: str, annotator: str, slug: str, data: Any) -> None:
    p = _annotation_path(name, annotator, slug)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2))


def delete_annotation(name: str, annotator: str, slug: str) -> bool:
    p = _annotation_path(name, annotator, slug)
    if not p.is_file():
        return False
    p.unlink()
    return True


def delete_outputs_for(name: str, annotator: str) -> dict:
    """Wipe one detector's algorithm cache + this annotator's annotation files.

    Leaves the .py source untouched. The algorithm cache is shared across
    annotators (it's just memoization of `run()`), so wiping it forces a
    re-run on next request — no other annotator loses authored work.
    """
    delete_results_for(name)

    ann_dir = CUSTOM_ANNOTATIONS_DIR / name / annotator
    removed = 0
    if ann_dir.exists():
        for p in ann_dir.glob("*.json"):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
        try:
            ann_dir.rmdir()
        except OSError:
            pass
    return {"annotations_removed": removed}


# ─── Detector-output edit storage (per-annotator copy-on-write) ──────────────
#
# When the user first Accept/Rejects an item on a detector's output, the
# algorithm cache envelope (which is shared and re-generated on every detector
# run) is copied here with an extra `review: {itemId: 'accepted'|'rejected'}`
# map and `in_progress: true`. Subsequent edits write through to this path
# only; the algorithm cache is never mutated. Re-running the detector while
# this file exists is blocked with 409 unless the caller passes
# `?confirm_overwrite=1` — see do_POST for the run handler.


def _detector_output_path(name: str, annotator: str, slug: str) -> Path:
    return DETECTOR_OUTPUTS_DIR / name / annotator / f"{slug}.json"


def read_detector_output(name: str, annotator: str, slug: str) -> Optional[dict]:
    p = _detector_output_path(name, annotator, slug)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def write_detector_output(name: str, annotator: str, slug: str, data: Any) -> None:
    p = _detector_output_path(name, annotator, slug)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2))


def delete_detector_output(name: str, annotator: str, slug: str) -> bool:
    p = _detector_output_path(name, annotator, slug)
    if not p.is_file():
        return False
    p.unlink()
    return True


def list_detector_outputs_for_annotator(annotator: str) -> dict[str, list[str]]:
    """Return {detector_name: [slug, ...]} for every editable detector output
    file owned by this annotator. Powers the picker's "in progress" dot."""
    out: dict[str, list[str]] = {}
    if not DETECTOR_OUTPUTS_DIR.is_dir():
        return out
    for det_dir in sorted(DETECTOR_OUTPUTS_DIR.iterdir()):
        if not det_dir.is_dir():
            continue
        ann_dir = det_dir / annotator
        if not ann_dir.is_dir():
            continue
        slugs = sorted(p.stem for p in ann_dir.glob("*.json"))
        if slugs:
            out[det_dir.name] = slugs
    return out


# ─── HTTP handler ────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "CustomDetectorServer/0.1"

    def log_message(self, fmt, *args):
        # Quiet successful requests, echo errors only.
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body: Any) -> None:
        if isinstance(body, (str, bytes)):
            data = body.encode() if isinstance(body, str) else body
            mime = "text/plain; charset=utf-8"
        else:
            data = json.dumps(body).encode()
            mime = "application/json"
        self.send_response(code)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self, max_bytes: int) -> Optional[bytes]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, {"error": "invalid Content-Length"})
            return None
        if length > max_bytes:
            self._send(413, {"error": f"body too large (>{max_bytes} bytes)"})
            return None
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _read_json(self, max_bytes: int) -> Optional[Any]:
        body = self._read_body(max_bytes)
        if body is None:
            return None
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"invalid JSON: {e}"})
            return None

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.end_headers()

    def _is_demo_caller(self) -> bool:
        """True when the request's X-Annotator-Id is the synthetic demo id.

        Used to refuse Playground-mutation endpoints — upload, run, delete,
        flag toggles, reload — for demo visitors, since they would otherwise
        let an anonymous client write or execute arbitrary Python on the
        host. GET endpoints (registry, cached results, source view) stay
        open so Algorithm Inspect still works in demo on shipped detectors.
        """
        raw = self.headers.get("X-Annotator-Id")
        return _safe_annotator(raw) == DEMO_ANNOTATOR_ID

    def _refuse_demo_playground(self) -> None:
        self._send(403, {
            "error": "playground_disabled_in_demo",
            "message": "Demo Mode cannot upload, modify, delete, or run custom detectors.",
        })

    def _caller_tier(self) -> tuple[Optional[str], Optional[str]]:
        """Returns (annotator_id, tier). Both None if id is missing/invalid."""
        annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
        return annotator, _tier_for(annotator)

    def _require_researcher_or_admin(self) -> bool:
        """Gate for authorship mutations (upload, reload, flags, DELETE).
        Returns True if the response has been sent (caller should return)."""
        annotator, tier = self._caller_tier()
        if not annotator:
            self._send(401, {"error": "missing or invalid X-Annotator-Id header"})
            return True
        if tier not in ("admin", "researcher"):
            self._send(403, {
                "error": "researcher_or_admin_required",
                "message": "Uploading, modifying, or deleting custom detectors requires researcher access.",
            })
            return True
        return False

    def _require_team(self) -> bool:
        """Gate for detector execution. Returns True if response already sent."""
        annotator, tier = self._caller_tier()
        if not annotator:
            self._send(401, {"error": "missing or invalid X-Annotator-Id header"})
            return True
        if tier not in ("admin", "researcher", "team"):
            self._send(403, {
                "error": "team_required",
                "message": "Running custom detectors requires team membership.",
            })
            return True
        return False

    # ── GET ────────────────────────────────────────────────────────────────

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        qs = parse_qs(url.query)

        if path == "/api/custom-scripts" or path == "/api/custom-scripts/":
            include_lp = _truthy(qs, "include_experimental_loops_patterns")
            self._send(200, {"detectors": _filtered_registry(
                include_experimental_loops_patterns=include_lp,
            )})
            return

        m = re.fullmatch(r"/api/custom-scripts/file/([^/]+)", path)
        if m:
            name = unquote(m.group(1))
            if not _safe_name(name):
                self._send(400, {"error": "invalid name"}); return
            src = read_script(name)
            if src is None:
                self._send(404, {"error": "not found"}); return
            self._send(200, src)
            return

        m = re.fullmatch(r"/api/custom-scripts/result/([^/]+)/(.+)", path)
        if m:
            name, slug = unquote(m.group(1)), unquote(m.group(2))
            if not _safe_name(name) or not _safe_slug(slug):
                self._send(400, {"error": "invalid name or slug"}); return
            cached = get_cached(name, slug)
            # Cache-miss is 200 + null, not 404 — these endpoints are polled on
            # every song load and a missing cache entry is the expected case.
            self._send(200, cached)
            return

        m = re.fullmatch(r"/api/custom-annotations/([^/]+)/(.+)", path)
        if m:
            name, slug = unquote(m.group(1)), unquote(m.group(2))
            if not _safe_name(name) or not _safe_slug(slug):
                self._send(400, {"error": "invalid name or slug"}); return
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if not annotator:
                self._send(401, {"error": "missing or invalid X-Annotator-Id header"}); return
            data = read_annotation(name, annotator, slug)
            self._send(200, data)
            return

        # Index of in-progress detector outputs for the current annotator.
        # Polled on song load — the result drives the small "in progress" dot
        # next to detector entries in the source picker.
        if path == "/api/detector-outputs/index":
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if not annotator:
                self._send(401, {"error": "missing or invalid X-Annotator-Id header"}); return
            self._send(200, list_detector_outputs_for_annotator(annotator))
            return

        m = re.fullmatch(r"/api/detector-outputs/([^/]+)/(.+)", path)
        if m:
            name, slug = unquote(m.group(1)), unquote(m.group(2))
            if not _safe_name(name) or not _safe_slug(slug):
                self._send(400, {"error": "invalid name or slug"}); return
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if not annotator:
                self._send(401, {"error": "missing or invalid X-Annotator-Id header"}); return
            self._send(200, read_detector_output(name, annotator, slug))
            return

        self._send(404, {"error": "not found"})

    # ── POST ───────────────────────────────────────────────────────────────

    def do_POST(self):
        url = urlsplit(self.path)
        path = url.path
        qs = parse_qs(url.query)

        # Demo-mode Playground lockdown — see _is_demo_caller. Reject every
        # POST under /api/custom-scripts (upload, run, reload, flag toggles)
        # before we touch the filesystem or invoke run(). Annotation writes
        # are still allowed — those land in the demo annotator's own per-id
        # directory and don't execute code.
        if path.startswith("/api/custom-scripts") and self._is_demo_caller():
            self._refuse_demo_playground(); return

        if path == "/api/custom-scripts/reload":
            if self._require_researcher_or_admin():
                return
            include_lp = _truthy(qs, "include_experimental_loops_patterns")
            self._send(200, {"detectors": _filtered_registry(
                include_experimental_loops_patterns=include_lp,
            )})
            return

        if path == "/api/custom-scripts/upload":
            if self._require_researcher_or_admin():
                return
            body = self._read_json(MAX_SCRIPT_BYTES)
            if body is None:
                return
            try:
                entry = write_script(
                    name=str(body.get("name", "")).strip(),
                    code=body.get("code", ""),
                )
                self._send(200, {"detector": entry})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {
                    "error": f"upload failed: {type(e).__name__}: {e}",
                    "traceback": traceback.format_exc(),
                })
            return

        m = re.fullmatch(r"/api/custom-scripts/run/([^/]+)", path)
        if m:
            if self._require_team():
                return
            name = unquote(m.group(1))
            if not _safe_name(name):
                self._send(400, {"error": "invalid name"}); return
            slug = (qs.get("slug", [""])[0] or "").strip()
            if not _safe_slug(slug):
                self._send(400, {"error": "slug query param is required"}); return
            force = _truthy(qs, "force")
            confirm_overwrite = _truthy(qs, "confirm_overwrite")
            # Block re-run when this annotator has an edited copy on disk
            # unless they've explicitly confirmed the overwrite. Keeps the
            # algorithm cache regenerable without silently nuking review
            # work. The X-Annotator-Id header is optional here — only used
            # to scope the conflict check; if absent we don't block.
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if annotator and not confirm_overwrite:
                edited = _detector_output_path(name, annotator, slug)
                if edited.is_file():
                    self._send(409, {
                        "error": "edited_output_exists",
                        "detector": name,
                        "slug": slug,
                        "path": str(edited),
                        "message": (
                            "This will overwrite existing edited output. Consider "
                            f"renaming the detector (e.g. {name}_v01, {name}_v02) or "
                            f"deleting the existing edited file at {edited}."
                        ),
                    })
                    return
            try:
                envelope = run(name, slug, force=force)
                self._send(200, envelope)
            except Exception as e:
                self._send(500, {
                    "error": f"run failed: {type(e).__name__}: {e}",
                    "traceback": traceback.format_exc(),
                })
            return

        m = re.fullmatch(r"/api/custom-scripts/([^/]+)/flags", path)
        if m:
            if self._require_researcher_or_admin():
                return
            name = unquote(m.group(1))
            if not _safe_name(name):
                self._send(400, {"error": "invalid name"}); return
            body = self._read_json(MAX_SCRIPT_BYTES)
            if body is None:
                return
            try:
                entry = patch_script_flags(
                    name,
                    is_algorithm=bool(body.get("is_algorithm", False)),
                    is_annotation=bool(body.get("is_annotation", False)),
                )
                self._send(200, {"detector": entry})
            except (ValueError, FileNotFoundError) as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"flag patch failed: {type(e).__name__}: {e}"})
            return

        m = re.fullmatch(r"/api/custom-annotations/([^/]+)/(.+)", path)
        if m:
            name, slug = unquote(m.group(1)), unquote(m.group(2))
            if not _safe_name(name) or not _safe_slug(slug):
                self._send(400, {"error": "invalid name or slug"}); return
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if not annotator:
                self._send(401, {"error": "missing or invalid X-Annotator-Id header"}); return
            data = self._read_json(MAX_ANNOTATION_BYTES)
            if data is None:
                return
            try:
                write_annotation(name, annotator, slug, data)
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(500, {"error": f"write failed: {type(e).__name__}: {e}"})
            return

        m = re.fullmatch(r"/api/detector-outputs/([^/]+)/(.+)", path)
        if m:
            name, slug = unquote(m.group(1)), unquote(m.group(2))
            if not _safe_name(name) or not _safe_slug(slug):
                self._send(400, {"error": "invalid name or slug"}); return
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if not annotator:
                self._send(401, {"error": "missing or invalid X-Annotator-Id header"}); return
            data = self._read_json(MAX_ANNOTATION_BYTES)
            if data is None:
                return
            try:
                write_detector_output(name, annotator, slug, data)
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(500, {"error": f"write failed: {type(e).__name__}: {e}"})
            return

        self._send(404, {"error": "not found"})

    # ── DELETE ─────────────────────────────────────────────────────────────

    def do_DELETE(self):
        url = urlsplit(self.path)
        path = url.path

        # Same demo lockdown as do_POST — block every DELETE under
        # /api/custom-scripts (full delete + /outputs wipe). Other DELETEs
        # (annotation, detector-outputs) remain scoped to the demo
        # annotator's own files.
        if path.startswith("/api/custom-scripts") and self._is_demo_caller():
            self._refuse_demo_playground(); return

        m = re.fullmatch(r"/api/custom-scripts/([^/]+)/outputs", path)
        if m:
            if self._require_researcher_or_admin():
                return
            name = unquote(m.group(1))
            if not _safe_name(name):
                self._send(400, {"error": "invalid name"}); return
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if not annotator:
                self._send(401, {"error": "missing or invalid X-Annotator-Id header"}); return
            info = delete_outputs_for(name, annotator)
            self._send(200, {"ok": True, **info})
            return

        m = re.fullmatch(r"/api/custom-scripts/([^/]+)", path)
        if m:
            if self._require_researcher_or_admin():
                return
            name = unquote(m.group(1))
            if not _safe_name(name):
                self._send(400, {"error": "invalid name"}); return
            removed = delete_script(name)
            self._send(200 if removed else 404, {"ok": removed})
            return

        m = re.fullmatch(r"/api/custom-annotations/([^/]+)/(.+)", path)
        if m:
            name, slug = unquote(m.group(1)), unquote(m.group(2))
            if not _safe_name(name) or not _safe_slug(slug):
                self._send(400, {"error": "invalid name or slug"}); return
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if not annotator:
                self._send(401, {"error": "missing or invalid X-Annotator-Id header"}); return
            removed = delete_annotation(name, annotator, slug)
            self._send(200 if removed else 404, {"ok": removed})
            return

        m = re.fullmatch(r"/api/detector-outputs/([^/]+)/(.+)", path)
        if m:
            name, slug = unquote(m.group(1)), unquote(m.group(2))
            if not _safe_name(name) or not _safe_slug(slug):
                self._send(400, {"error": "invalid name or slug"}); return
            annotator = _safe_annotator(self.headers.get("X-Annotator-Id"))
            if not annotator:
                self._send(401, {"error": "missing or invalid X-Annotator-Id header"}); return
            removed = delete_detector_output(name, annotator, slug)
            self._send(200 if removed else 404, {"ok": removed})
            return

        self._send(404, {"error": "not found"})


def _another_instance_is_healthy(host: str) -> bool:
    """Return True iff something on (host, PORT) responds as a custom_server.

    Used when bind() fails with EADDRINUSE — distinguishes the benign
    "vite spawned us twice" race from a real port conflict with an
    unrelated process.
    """
    import http.client
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "") else host
    try:
        conn = http.client.HTTPConnection(probe_host, PORT, timeout=2.0)
        conn.request("GET", "/api/custom-scripts")
        resp = conn.getresponse()
        body = resp.read(2048)
        conn.close()
        # Both 200 (registry list) and 401 (annotator header required on
        # some deployments) prove it's a custom_server, not some other
        # service that happens to squat on 8005.
        if resp.status in (200, 401):
            return True
        # 200 with a JSON list is the definitive shape.
        if resp.status == 200 and body.lstrip().startswith(b"["):
            return True
        return False
    except OSError:
        return False


def main() -> None:
    host = os.environ.get("HOST", "localhost")
    print(f"Starting custom-detector server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  scripts dir:    {CUSTOM_DIR}", file=sys.stderr)
    print(f"  annotations:    {CUSTOM_ANNOTATIONS_DIR}", file=sys.stderr)
    print(f"  detector edits: {DETECTOR_OUTPUTS_DIR}", file=sys.stderr)
    try:
        server = ThreadingHTTPServer((host, PORT), Handler)
    except OSError as e:
        # errno 98 (Linux) / 48 (macOS) = EADDRINUSE. If another
        # custom_server is already healthy on this port, exit 0 so the
        # parent (Vite's auto-spawn) treats this as a clean no-op
        # instead of crash-looping.
        if e.errno in (48, 98) and _another_instance_is_healthy(host):
            print(
                f"custom-detector server already running on http://{host}:{PORT} — exiting cleanly.",
                file=sys.stderr,
            )
            return
        raise
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
