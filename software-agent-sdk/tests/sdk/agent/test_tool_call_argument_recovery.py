"""Tests for recovery heuristics on malformed file_editor tool arguments.

Weak models (e.g. Gemma) occasionally mangle the JSON of a tool call: the real
absolute path lands in a leftover key, or the ``path`` field itself is filled
with a stray value (like the security_risk ``"LOW"``). These heuristics keep
such calls alive instead of failing validation and stalling the run.
"""

from openhands.sdk.agent.utils import _normalize_arguments, parse_tool_call_arguments


def test_path_field_filled_with_stray_low_is_recovered():
    """`path` contains a stray non-path value; the real path is elsewhere."""
    args = {
        "command": "str_replace",
        "path": "LOW",  # stray value the model glued into path
        "old_str": "Chapter 1",
        "new_str": "Chapter 1 + 2",
        "/projects/hex/saas_book.md": "LOW",  # leftover absolute-path key
        "security_risk": "LOW",
    }
    normalized = _normalize_arguments(args)
    assert normalized["path"] == "/projects/hex/saas_book.md"
    assert normalized["command"] == "str_replace"


def test_path_missing_and_leftover_key_is_used():
    """No `path` key; a leftover key carries the absolute path."""
    args = {
        "command": "view",
        "/home/openhands/workspace/project/abc/index.html": "LOW",
        "security_risk": "LOW",
    }
    normalized = _normalize_arguments(args)
    assert normalized["path"] == "/home/openhands/workspace/project/abc/index.html"


def test_valid_absolute_path_is_kept():
    """A proper absolute path must not be disturbed."""
    args = {"command": "view", "path": "/projects/hex/saas_book.md"}
    normalized = _normalize_arguments(args)
    assert normalized["path"] == "/projects/hex/saas_book.md"


def test_parse_tool_call_arguments_recovers_stray_path():
    """End-to-end through parse_tool_call_arguments with real JSON."""
    raw = (
        '{"command": "str_replace", "path": "LOW", '
        '"old_str": "a", "new_str": "b", '
        '"/projects/hex/book.md": "LOW", "security_risk": "LOW"}'
    )
    parsed = parse_tool_call_arguments(raw)
    assert parsed["path"] == "/projects/hex/book.md"
