"""Per-annotator directory isolation tests for the custom-server backend.

The per-annotator subdir scheme is the multi-annotator safety guarantee:
two annotators writing the same song never overwrite each other because
their files land in `<base>/<annotator>/<slug>.json`. The HTTP layer
parses `X-Annotator-Id` via `_safe_annotator`, then passes the result to
path-builders (`_annotation_path`) and read/write/delete helpers.

A regression in any of:

  * `_safe_annotator` — must reject path-traversal (`../`, `/`, `\\`, `.`,
    `..`) and stay strictly within the ANNOTATOR_ID_RE alphabet,
  * path-builders — must always include the annotator segment so a write
    can't escape into another annotator's directory,
  * `_tier_for` — must mirror the TS-side tierForAnnotator branch matrix
    (bootstrap mode, demo carve-out, peopleByEmail precedence),

would cross the multi-annotator boundary silently. These tests pin the
contract end-to-end on a tmp-dir-backed CUSTOM_ANNOTATIONS_DIR.

(Annotation-LAYERS serving moved in-process to Vite; its isolation is no longer
exercised here — only the custom-detector annotation tree lives in this server.)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

import custom_server  # noqa: E402
from custom_server import (  # noqa: E402
    _safe_annotator,
    _safe_name,
    _safe_slug,
    _tier_for,
    _annotation_path,
    read_annotation,
    write_annotation,
    delete_annotation,
    delete_outputs_for,
    DEMO_ANNOTATOR_ID,
)


# ─── _safe_annotator — the path-traversal firewall ───────────────────────────


class TestSafeAnnotator:
    def test_accepts_valid_email_form(self):
        assert _safe_annotator("jane@example.com") == "jane@example.com"

    def test_accepts_handle_with_underscores_dots_dashes(self):
        assert _safe_annotator("jane_doe") == "jane_doe"
        assert _safe_annotator("jane.doe") == "jane.doe"
        assert _safe_annotator("jane-doe") == "jane-doe"

    def test_accepts_plus_tag(self):
        # peopleByEmail keys may include the +tag form Gmail uses; the
        # sanitizer keeps `+` in the alphabet so those entries reach the
        # right path on disk.
        assert _safe_annotator("user+work@example.com") == "user+work@example.com"

    def test_lowercases_input(self):
        # Critical: a mixed-case header must never land in a different dir
        # from its lower-case sibling, otherwise an annotator's work would
        # split across two directories.
        assert _safe_annotator("Jane@Example.COM") == "jane@example.com"

    def test_strips_whitespace(self):
        assert _safe_annotator("  jane@x.com  ") == "jane@x.com"

    def test_rejects_path_traversal_segments(self):
        # If `.` or `..` ever made it through, `<base>/<.>/<slug>.json` would
        # collapse to `<base>/<slug>.json` (Python's pathlib silently strips
        # `.`), and `..` would escape one directory level up.
        assert _safe_annotator(".") is None
        assert _safe_annotator("..") is None

    def test_rejects_slashes_and_backslashes(self):
        # The most direct path-traversal attempt.
        assert _safe_annotator("a/b") is None
        assert _safe_annotator("..\\other") is None
        assert _safe_annotator("/etc/passwd") is None

    def test_rejects_characters_outside_the_alphabet(self):
        # ANNOTATOR_ID_RE = [a-z0-9._@+\-]. Anything else (spaces, !, #, etc.)
        # must be refused — otherwise a future filesystem op might choke on
        # the unsafe character.
        assert _safe_annotator("jane doe") is None
        assert _safe_annotator("jane!") is None
        assert _safe_annotator("jane#x") is None
        assert _safe_annotator("jane/../root") is None

    def test_returns_none_for_empty_or_none_input(self):
        assert _safe_annotator(None) is None
        assert _safe_annotator("") is None
        assert _safe_annotator("   ") is None


# ─── _safe_name and _safe_slug — supporting path-component guards ────────────


class TestSafeSlug:
    def test_accepts_typical_song_slugs(self):
        assert _safe_slug("my-song-2024") is True
        assert _safe_slug("song_1") is True

    def test_rejects_path_traversal(self):
        assert _safe_slug("..") is False
        assert _safe_slug(".") is False
        assert _safe_slug("a/b") is False
        assert _safe_slug("a\\b") is False

    def test_rejects_empty(self):
        assert _safe_slug("") is False


# ─── _tier_for — mirror of TS-side tierForAnnotator ──────────────────────────


class TestTierFor:
    def _write_cfg(self, monkeypatch, cfg_path: Path, body: dict | None) -> None:
        if body is None:
            # No file at all → bootstrap mode.
            if cfg_path.exists():
                cfg_path.unlink()
        else:
            cfg_path.write_text(json.dumps(body))
        monkeypatch.setattr(custom_server, "DATASET_CONFIG_PATH", cfg_path)

    def test_bootstrap_mode_promotes_first_user_to_admin(self, tmp_path, monkeypatch):
        self._write_cfg(monkeypatch, tmp_path / "cfg.json", None)
        assert _tier_for("anyone@example.com") == "admin"

    def test_demo_id_is_always_public(self, tmp_path, monkeypatch):
        # Even in bootstrap mode the demo synthetic id must NOT be promoted —
        # otherwise the demo visitor would land in `data/` instead of
        # `data-default/` and lose access to the shipped CC0 seed corpus.
        self._write_cfg(monkeypatch, tmp_path / "cfg.json", None)
        assert _tier_for(DEMO_ANNOTATOR_ID) is None

    def test_unsigned_user_is_public(self, tmp_path, monkeypatch):
        self._write_cfg(monkeypatch, tmp_path / "cfg.json", None)
        assert _tier_for(None) is None
        assert _tier_for("") is None

    def test_peopleByEmail_resolves_listed_tier(self, tmp_path, monkeypatch):
        self._write_cfg(monkeypatch, tmp_path / "cfg.json", {
            "peopleByEmail": {
                "a@x.com": {"tier": "admin"},
                "r@x.com": {"tier": "researcher"},
                "t@x.com": {"tier": "team"},
            }
        })
        assert _tier_for("a@x.com") == "admin"
        assert _tier_for("r@x.com") == "researcher"
        assert _tier_for("t@x.com") == "team"

    def test_peopleByEmail_treats_unlisted_as_public(self, tmp_path, monkeypatch):
        self._write_cfg(monkeypatch, tmp_path / "cfg.json", {
            "peopleByEmail": {"a@x.com": {"tier": "admin"}}
        })
        assert _tier_for("nobody@x.com") is None

    def test_legacy_admin_emails_fallback(self, tmp_path, monkeypatch):
        self._write_cfg(monkeypatch, tmp_path / "cfg.json", {
            "adminEmails": ["boss@x.com"]
        })
        assert _tier_for("boss@x.com") == "admin"
        assert _tier_for("outsider@x.com") is None

    def test_legacy_team_emails_fallback(self, tmp_path, monkeypatch):
        self._write_cfg(monkeypatch, tmp_path / "cfg.json", {
            "teamEmails": ["t@x.com"]
        })
        assert _tier_for("t@x.com") == "team"

    def test_malformed_config_falls_through_to_bootstrap(self, tmp_path, monkeypatch):
        # An on-disk JSON syntax error must not crash the tier check — it
        # falls through to None (no tier resolvable).
        cfg = tmp_path / "cfg.json"
        cfg.write_text("{this-is-not-json")
        monkeypatch.setattr(custom_server, "DATASET_CONFIG_PATH", cfg)
        # _read_dataset_config returns None on parse error → bootstrap path.
        assert _tier_for("a@x.com") == "admin"


# ─── Path-builders always include the annotator segment ─────────────────────


class TestPathBuilders:
    def test_annotation_path_includes_annotator_segment(self, tmp_path, monkeypatch):
        monkeypatch.setattr(custom_server, "CUSTOM_ANNOTATIONS_DIR", tmp_path)
        p = _annotation_path("detector", "jane@x.com", "song-1")
        parts = p.relative_to(tmp_path).parts
        # <detector>/<annotator>/<slug>.json — three segments, annotator in middle.
        assert parts == ("detector", "jane@x.com", "song-1.json")

    def test_distinct_annotators_resolve_to_distinct_paths(self, tmp_path, monkeypatch):
        monkeypatch.setattr(custom_server, "CUSTOM_ANNOTATIONS_DIR", tmp_path)
        a = _annotation_path("det", "alice@x.com", "song-1")
        b = _annotation_path("det", "bob@x.com",   "song-1")
        assert a != b
        assert "alice@x.com" in a.parts
        assert "bob@x.com"   in b.parts


# ─── Read/Write/Delete round-trips per annotator ────────────────────────────


class TestAnnotationRoundtrip:
    @pytest.fixture(autouse=True)
    def _isolate_dirs(self, tmp_path, monkeypatch):
        # Every test in this class gets its own empty annotations root.
        self.ann_root = tmp_path / "annotations"
        self.ann_root.mkdir()
        monkeypatch.setattr(custom_server, "CUSTOM_ANNOTATIONS_DIR", self.ann_root)

    def test_write_then_read_returns_same_payload(self):
        payload = {"items": [{"time_ms": 1000, "label": "drop"}]}
        write_annotation("my-detector", "alice@x.com", "song-1", payload)
        assert read_annotation("my-detector", "alice@x.com", "song-1") == payload

    def test_read_returns_none_when_no_file(self):
        assert read_annotation("never-written", "alice@x.com", "song-1") is None

    def test_read_returns_none_when_file_is_garbage(self):
        # A truncated/corrupted on-disk file must not crash the reader —
        # downstream callers expect None as "no data".
        p = _annotation_path("my-detector", "alice@x.com", "song-1")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{this is not json")
        assert read_annotation("my-detector", "alice@x.com", "song-1") is None

    def test_two_annotators_writing_same_song_dont_overwrite_each_other(self):
        # THE multi-annotator safety guarantee. If this ever breaks, two
        # users opening the same song will silently destroy each other's
        # work on the next save.
        alice_payload = {"items": [{"time_ms": 1000, "by": "alice"}]}
        bob_payload   = {"items": [{"time_ms": 2000, "by": "bob"}]}

        write_annotation("my-detector", "alice@x.com", "song-1", alice_payload)
        write_annotation("my-detector", "bob@x.com",   "song-1", bob_payload)

        assert read_annotation("my-detector", "alice@x.com", "song-1") == alice_payload
        assert read_annotation("my-detector", "bob@x.com",   "song-1") == bob_payload

    def test_delete_only_affects_the_named_annotator(self):
        write_annotation("det", "alice@x.com", "song-1", {"ok": "a"})
        write_annotation("det", "bob@x.com",   "song-1", {"ok": "b"})

        assert delete_annotation("det", "alice@x.com", "song-1") is True
        assert read_annotation("det", "alice@x.com", "song-1") is None
        # Bob's file is untouched.
        assert read_annotation("det", "bob@x.com", "song-1") == {"ok": "b"}

    def test_delete_returns_false_when_nothing_to_delete(self):
        assert delete_annotation("det", "alice@x.com", "song-1") is False

    def test_delete_outputs_for_only_wipes_named_annotators_files(self, monkeypatch):
        # `delete_outputs_for` is the per-annotator destructive op — it
        # wipes one annotator's annotation files for one detector. It must
        # not touch a different annotator's files for the same detector,
        # otherwise removing your own work would clobber a collaborator's.
        # Stub delete_results_for so this test doesn't depend on the cache
        # path (we only care about the annotation side).
        monkeypatch.setattr(custom_server, "delete_results_for", lambda name: None)

        write_annotation("det", "alice@x.com", "song-1", {"ok": "a1"})
        write_annotation("det", "alice@x.com", "song-2", {"ok": "a2"})
        write_annotation("det", "bob@x.com",   "song-1", {"ok": "b"})

        result = delete_outputs_for("det", "alice@x.com")
        assert result["annotations_removed"] == 2

        # Alice is wiped, bob remains.
        assert read_annotation("det", "alice@x.com", "song-1") is None
        assert read_annotation("det", "alice@x.com", "song-2") is None
        assert read_annotation("det", "bob@x.com",   "song-1") == {"ok": "b"}
