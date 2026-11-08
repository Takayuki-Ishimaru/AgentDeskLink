"""Offline human signoff gate: snapshot a release, verify a private review record."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
REVIEW_KEYS = (
    "company_customer_terms",
    "business_design",
    "examples_and_media",
    "public_artifacts",
)
_CHUNK = 1 << 16
_HEX40 = re.compile(r"\A[0-9a-f]{40}\Z")
_HEX64 = re.compile(r"\A[0-9a-f]{64}\Z")


class ReviewError(Exception):
    """Raised when the release state or review record is not acceptable."""


def _git(source, *args):
    env = {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}
    env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_TERMINAL_PROMPT='0')
    try:
        proc = subprocess.run(
            ["git", "-C", str(source), *args],
            capture_output=True, timeout=15,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        raise ReviewError("git unavailable")
    if proc.returncode != 0:
        raise ReviewError("not a git checkout")
    return proc.stdout.decode("utf-8", "replace")


def _sha256_file(path):
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(_CHUNK), b""):
                digest.update(chunk)
    except OSError:
        raise ReviewError("file unreadable")
    return digest.hexdigest()


def _check_clean_full(source):
    if Path(_git(source, "rev-parse", "--show-toplevel").strip()).resolve() != source.resolve():
        raise ReviewError("source must be the checkout root")
    if _git(source, "rev-parse", "--is-shallow-repository").strip() != "false":
        raise ReviewError("shallow checkout")
    if _git(source, "for-each-ref", "--format=%(refname)", "refs/replace").strip():
        raise ReviewError("history replacement refs are present")
    if _git(source, "status", "--porcelain", "--untracked-files=all").strip():
        raise ReviewError("dirty checkout")


def _refs_digest(source):
    lines = _git(source, "for-each-ref",
                 "--format=%(refname) %(objectname)").splitlines()
    payload = "\n".join(sorted(line for line in lines if line.strip()))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _release_version(source):
    try:
        data = json.loads((source / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ReviewError("package.json unreadable")
    version = data.get("version") if isinstance(data, dict) else None
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ReviewError("invalid package version")
    return version


def snapshot(source, assets, notes):
    source, assets, notes = Path(source), Path(assets), Path(notes)
    _check_clean_full(source)
    head = _git(source, "rev-parse", "HEAD").strip()
    if not _HEX40.match(head):
        raise ReviewError("bad HEAD")
    version = _release_version(source)
    names = (
        "agentdesklink-%s.vsix" % version,
        "AgentDeskLink-%s-docs.zip" % version,
        "SHA256SUMS",
    )
    asset_sha256 = {}
    for name in names:
        path = assets / name
        if path.is_symlink() or not path.is_file():
            raise ReviewError("asset missing")
        asset_sha256[name] = _sha256_file(path)
    if notes.is_symlink() or not notes.is_file():
        raise ReviewError("release note missing")
    return {
        "schema_version": SCHEMA_VERSION,
        "source_sha": head,
        "refs_sha256": _refs_digest(source),
        "version": version,
        "asset_sha256": asset_sha256,
        "release_note_sha256": _sha256_file(notes),
        "reviewer": "",
        "reviewed_at": "",
        "reviews": {key: False for key in REVIEW_KEYS},
    }


def _valid_utc(value):
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        return False
    try:
        timestamp = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return timestamp <= datetime.now(timezone.utc)


def _validate_record(record):
    if not isinstance(record, dict):
        raise ReviewError("malformed record")
    if type(record.get("schema_version")) is not int or record["schema_version"] != SCHEMA_VERSION:
        raise ReviewError("schema mismatch")
    value = record.get("source_sha")
    if not isinstance(value, str) or not _HEX40.match(value):
        raise ReviewError("malformed record")
    for key in ("refs_sha256", "release_note_sha256"):
        value = record.get(key)
        if not isinstance(value, str) or not _HEX64.match(value):
            raise ReviewError("malformed record")
    if not isinstance(record.get("version"), str) or not record["version"]:
        raise ReviewError("malformed record")
    assets = record.get("asset_sha256")
    if not isinstance(assets, dict) or not assets:
        raise ReviewError("malformed record")
    for value in assets.values():
        if not isinstance(value, str) or not _HEX64.match(value):
            raise ReviewError("malformed record")
    reviewer = record.get("reviewer")
    if not isinstance(reviewer, str) or not reviewer.strip():
        raise ReviewError("reviewer required")
    if not _valid_utc(record.get("reviewed_at")):
        raise ReviewError("reviewed_at invalid")
    reviews = record.get("reviews")
    if not isinstance(reviews, dict) or set(reviews) != set(REVIEW_KEYS):
        raise ReviewError("reviews malformed")
    if not all(reviews[key] is True for key in REVIEW_KEYS):
        raise ReviewError("review not approved")


def verify_review(source, assets, notes, record):
    source, assets, notes, record = (Path(p) for p in (source, assets, notes, record))
    try:
        resolved = record.resolve()
    except OSError:
        raise ReviewError("record unreadable")
    if source.resolve() in resolved.parents:
        raise ReviewError("record must stay outside the checkout")
    if assets.resolve() in resolved.parents:
        raise ReviewError("record must stay outside the release assets")
    if not resolved.is_file():
        raise ReviewError("record missing")
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ReviewError("malformed record")
    _validate_record(data)
    current = snapshot(source, assets, notes)
    if set(data) != set(current):
        raise ReviewError("unexpected review fields")
    for key in ("schema_version", "source_sha", "refs_sha256", "version",
                "asset_sha256", "release_note_sha256"):
        if data[key] != current[key]:
            raise ReviewError("review stale")
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(prog="review_gate")
    parser.add_argument("command", choices=("snapshot", "verify"))
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--notes", required=True, type=Path)
    parser.add_argument("--record", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "snapshot":
            json.dump(snapshot(args.source, args.assets, args.notes),
                      sys.stdout, sort_keys=True, indent=2)
            sys.stdout.write("\n")
        else:
            if args.record is None:
                raise ReviewError("record required")
            verify_review(args.source, args.assets, args.notes, args.record)
            print("review verified")
    except ReviewError as exc:
        print("review gate: refused (%s)" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
