"""One-time GitHub Actions release publisher for AgentDeskLink v0.1.7.

Standard library only. Validates the approved payload locally, then drives a
GitHub API adapter (gh CLI in production) to publish one draft-then-published
prerelease. Fail-closed everywhere: no force pushes, no overwrites.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

VERSION = "0.1.7"
REPO = "Takayuki-Ishimaru/AgentDeskLink"
TAG = "v0.1.7"
TITLE = "AgentDeskLink v0.1.7 (beta)"
CI_WORKFLOW = "Beta validation"
CI_WORKFLOW_PATH = ".github/workflows/ci.yml"
EXPECTED_TARGETS = ["darwin-arm64", "win32-x64", "linux-x64"]
VSIX_NAME = f"agentdesklink-{VERSION}.vsix"
DOCS_NAME = f"AgentDeskLink-{VERSION}-docs.zip"
SUMS_NAME = "SHA256SUMS"
ASSET_NAMES = [VSIX_NAME, DOCS_NAME, SUMS_NAME]
DETERMINISTIC_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
INTERNAL_DOC_RE = re.compile(
        r"\binternal\b|\bscore\b|\bmemo\b|\bbenchmark\b|development metrics?|社内|内部|点数|開発指標|検証統計|メモ|開発メトリクス|\d+(?:\.\d+)?%",
    re.IGNORECASE,
)
DEV_DOC_NAMES = {"DEVELOPMENT.md", "DEVELOPMENT_en.md", "CHANGELOG_DEV.md", "ROADMAP.md"}
INTERNAL_TOP = {"docs", "tests", "src", "scripts", "benchmarks", "artifacts"}


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_path(path: Path) -> str:
    return _sha256_bytes(Path(path).read_bytes())


def _fail(message: str) -> None:
    raise ValueError(message)


def _safe_zip_names(zf: zipfile.ZipFile) -> list[str]:
    names = zf.namelist()
    lowered: dict[str, str] = {}
    for name in names:
        low = name.lower()
        if low in lowered:
            _fail(f"case-duplicate zip entries: {lowered[low]!r} and {name!r}")
        lowered[low] = name
        parts = name.split("/")
        if not name or "\\" in name or "\0" in name or name.startswith("/") or any(p in (".", "..") for p in parts) or (len(name) > 1 and name[1] == ":"):
            _fail(f"unsafe zip path: {name!r}")
    return names


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return (info.external_attr >> 16) & 0o170000 == 0o120000


def _check_privacy_text(text: str, label: str) -> None:
    # The approved proxy limitation uses this technical destination term.
    # It carries no engineering notes or evaluation data.
    match = INTERNAL_DOC_RE.search(text.replace("社内ホスト", "ホスト"))
    if match:
        _fail(f"{label} contains internal wording {match.group(0)!r}")


def _vsix_name(rel: str) -> str:
    if rel == "README.md":
        return "extension/readme.md"
    if rel == "LICENSE":
        return "extension/LICENSE.txt"
    return f"extension/{rel}"


def _document_names(source: Path) -> list[str]:
    names = []
    for rel in ["README.md", "README_en.md", "LICENSE"]:
        if (source / rel).is_file():
            names.append(rel)
    for sub in ("release-docs", "config", "media"):
        base = source / sub
        if base.is_dir():
            for path in sorted(base.rglob("*")):
                if path.is_file():
                    names.append(path.relative_to(source).as_posix())
    return names


def _build_files(source: Path) -> list[str]:
    names = []
    for sub in ("dist/src", "dist/extension"):
        base = source / sub
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if sub == "dist/extension" and path.suffix != ".cjs":
                continue
            if path.is_file():
                names.append(path.relative_to(source).as_posix())
    return names


def _check_runtime(rows) -> None:
    top_raw = rows.get("extension/runtime/manifest.json")
    if top_raw is None:
        _fail("VSIX missing extension/runtime/manifest.json")
    try:
        top = json.loads(top_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("runtime manifest is not valid JSON")
    if top.get("schemaVersion") != 3 or top.get("targets") != EXPECTED_TARGETS:
        _fail(f"universal runtime manifest must list exactly {EXPECTED_TARGETS}")
    for target in EXPECTED_TARGETS:
        raw = rows.get(f"extension/runtime/{target}/manifest.json")
        if raw is None:
            _fail(f"missing child manifest for {target}")
        try:
            child = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            _fail(f"child manifest for {target} is not valid JSON")
        if child.get("schemaVersion") != 2 or child.get("target") != target:
            _fail(f"child manifest mismatch for {target}")


def _validate_vsix(vsix: Path, source: Path, version: str) -> None:
    with zipfile.ZipFile(vsix) as zf:
        names = _safe_zip_names(zf)
        rows: dict[str, bytes] = {}
        for info in zf.infolist():
            if info.is_dir():
                continue
            if _is_symlink(info):
                _fail(f"symlink in VSIX: {info.filename!r}")
            rows[info.filename] = zf.read(info)
    for name in rows:
        parts = name.split("/")
        if name not in ("[Content_Types].xml", "extension.vsixmanifest"):
            allowed = {"package.json", "readme.md", "README_en.md", "LICENSE.txt", "config", "dist", "media", "node_modules", "release-docs", "runtime"}
            if len(parts) < 2 or parts[0] != "extension" or parts[1] not in allowed:
                _fail(f"unexpected VSIX payload: {name!r}")
        if len(parts) >= 2 and parts[0] == "extension" and parts[1].lower() in INTERNAL_TOP:
            _fail(f"internal payload directory in VSIX: {name!r}")
        if len(parts) >= 3 and parts[1] == "release-docs" and parts[2].casefold() in {n.casefold() for n in DEV_DOC_NAMES}:
            _fail(f"development doc in VSIX release-docs: {name!r}")
    expected_docs = {_vsix_name(rel) for rel in _document_names(source)}
    own_docs = {name for name in rows if name.startswith(("extension/release-docs/", "extension/config/", "extension/media/"))}
    if own_docs != {name for name in expected_docs if name.startswith(("extension/release-docs/", "extension/config/", "extension/media/"))}:
        _fail("VSIX public documentation/config/media file list differs from approved source")
    pkg_raw = rows.get("extension/package.json")
    if pkg_raw is None:
        _fail("VSIX missing extension/package.json")
    try:
        pkg = json.loads(pkg_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("VSIX package.json is not valid JSON")
    if pkg.get("version") != version:
        _fail(f"VSIX package version {pkg.get('version')!r} != {version!r}")
    for rel in _document_names(source):
        want = (source / rel).read_bytes()
        got = rows.get(_vsix_name(rel))
        if got is None:
            _fail(f"VSIX missing document {_vsix_name(rel)!r}")
        if got != want:
            _fail(f"VSIX document bytes differ from source: {rel}")
    for rel in _build_files(source):
        want = (source / rel).read_bytes()
        got = rows.get(f"extension/{rel}")
        if got is None:
            _fail(f"VSIX missing compiled file extension/{rel!r}")
        if got != want:
            _fail(f"compiled file differs from source build: {rel}")
    _check_runtime(rows)


def _validate_source(source: Path, version: str) -> None:
    pkg = json.loads((source / "package.json").read_text(encoding="utf-8"))
    if pkg.get("version") != version:
        _fail(f"source package.json version {pkg.get('version')!r} != {version!r}")
    for rel in ["README.md", "README_en.md", "LICENSE"]:
        if not (source / rel).is_file():
            _fail(f"source missing {rel}")
    for path in sorted((source / "release-docs").glob("*.md")):
        if path.name in DEV_DOC_NAMES:
            _fail(f"development doc in release-docs: {path.name}")


def _privacy_scan_source(source: Path) -> None:
    paths = [source / n for n in ["README.md", "README_en.md", "LICENSE"]]
    if (source / "release-docs").is_dir():
        paths += sorted((source / "release-docs").glob("*.md"))
    for path in paths:
        if path.is_file():
            _check_privacy_text(path.read_text(encoding="utf-8", errors="replace"), str(path.relative_to(source)))


def _docs_zip_members(source: Path) -> list[str]:
    names = [n for n in ["README.md", "README_en.md", "LICENSE"] if (source / n).is_file()]
    for sub in ("release-docs", "config", "media"):
        base = source / sub
        if base.is_dir():
            for path in sorted(base.rglob("*")):
                if path.is_file() and not (sub == "release-docs" and path.name in DEV_DOC_NAMES):
                    names.append(path.relative_to(source).as_posix())
    return names


def _write_docs_zip(source: Path, out: Path) -> None:
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in _docs_zip_members(source):
            info = zipfile.ZipInfo(rel, date_time=DETERMINISTIC_ZIP_TIME)
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, (source / rel).read_bytes())


def prepare_assets(source: Path, vsix: Path, notes: Path, out: Path, version: str, body_sha: str) -> dict:
    source, vsix, notes, out = map(Path, (source, vsix, notes, out))
    body = notes.read_bytes()
    if _sha256_bytes(body) != body_sha:
        _fail("notes digest does not match approved body_sha")
    _check_privacy_text(body.decode("utf-8", errors="replace"), "release notes")
    _validate_source(source, version)
    _privacy_scan_source(source)
    _validate_vsix(vsix, source, version)
    out.mkdir(parents=True, exist_ok=True)
    _write_docs_zip(source, out / DOCS_NAME)
    shutil.copyfile(vsix, out / VSIX_NAME)
    sums = "".join(f"{_sha256_path(out / n)}  {n}\n" for n in [VSIX_NAME, DOCS_NAME])
    (out / SUMS_NAME).write_text(sums, encoding="utf-8")
    assets = {}
    for name in ASSET_NAMES:
        path = out / name
        data = path.read_bytes()
        assets[name] = {"path": str(path), "sha256": _sha256_bytes(data), "bytes": len(data)}
    return {
        "body": body.decode("utf-8"),
        "version": version,
        "assets": assets,
        "sha256": _sha256_bytes("".join(f"{name}\n{a['sha256']}\n" for name, a in assets.items()).encode()),
    }


def _known_asset_state(name: str, asset: dict, expected: dict) -> str:
    if name not in ASSET_NAMES:
        _fail(f"unknown asset on existing release: {name!r}")
    if asset.get("state") != "uploaded":
        _fail(f"asset {name!r} is not uploaded")
    digest = asset.get("digest") or ""
    if not isinstance(digest, str) or not digest.startswith("sha256:"):
        _fail(f"asset {name!r} has no sha256 digest")
    state = asset.get("state")
    if digest[7:] != expected["sha256"]:
        _fail(f"asset {name!r} digest does not match approved payload")
    if asset.get("size") != expected["bytes"]:
        _fail(f"asset {name!r} size does not match approved payload")
    if state != "uploaded":
        _fail(f"asset {name!r} state {state!r} is not 'uploaded'; refusing to publish")
    return "ok"


def _verify_release(release: dict, plan: dict, complete: bool = False) -> None:
    if not isinstance(release, dict):
        _fail("release disappeared")
    if release.get("tag_name") != TAG or release.get("name") != TITLE:
        _fail("existing release tag/name does not match approved plan")
    if release.get("body") != plan["body"]:
        _fail("existing release body does not match approved notes")
    if release.get("prerelease") is not True:
        _fail("existing release is not a prerelease")
    seen: set[str] = set()
    for asset in release.get("assets", []):
        name = asset.get("name")
        if name in seen:
            _fail(f"duplicate asset on existing release: {name!r}")
        seen.add(name)
        expected = plan["assets"].get(name)
        if expected is None:
            _fail(f"unknown asset on existing release: {name!r}")
        _known_asset_state(name, asset, expected)
    if complete and seen != set(ASSET_NAMES):
        _fail("release does not contain exactly all three approved assets")


def _verify_local_assets(plan: dict) -> None:
    if plan.get("version") != VERSION or plan.get("repo") != REPO or set(plan.get("assets", {})) != set(ASSET_NAMES):
        _fail("unexpected release identity or asset list")
    for key in ("source_sha", "base_sha"):
        if not re.fullmatch(r"[0-9a-f]{40}", plan.get(key, "")):
            _fail(f"invalid {key}")
    if type(plan.get("ci_run_id")) is not int or plan["ci_run_id"] <= 0:
        _fail("invalid CI run id")
    for name, meta in plan["assets"].items():
        path = Path(meta["path"])
        if path.name != name or path.is_symlink():
            _fail(f"invalid asset path: {name}")
        if not path.is_file():
            _fail(f"local asset missing: {name}")
        data = path.read_bytes()
        if len(data) != meta["bytes"] or _sha256_bytes(data) != meta["sha256"]:
            _fail(f"local asset digest mismatch, refusing to publish: {name}")


def publish(plan: dict, api) -> dict:
    repo = plan["repo"]
    source_sha = plan["source_sha"]
    base_sha = plan["base_sha"]
    ci_run_id = plan["ci_run_id"]
    _verify_local_assets(plan)
    run = api.get(f"actions/runs/{ci_run_id}")
    if (
        not run
        or run.get("head_sha") != source_sha
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("name") != CI_WORKFLOW
        or run.get("path") != CI_WORKFLOW_PATH
        or (run.get("repository") or {}).get("full_name") != repo
    ):
        _fail(f"CI run {ci_run_id} does not prove {CI_WORKFLOW} success on source_sha")
    main_ref = api.get("git/ref/heads/main")
    main_sha = (main_ref or {}).get("object", {}).get("sha")
    tag_ref = api.get(f"git/ref/tags/{TAG}")
    if tag_ref is not None:
        target = tag_ref["object"]
        for _ in range(4):
            if target.get("type") != "tag":
                break
            target = api.get(f"git/tags/{target['sha']}")["object"]
        if target.get("type") != "commit" or target.get("sha") != source_sha:
            _fail(f"tag {TAG} exists on an unrelated commit")
    release = api.get(f"releases/tags/{TAG}")
    if release is None:
        drafts = [r for r in (api.get("releases?per_page=100") or []) if r.get("tag_name") == TAG]
        if len(drafts) > 1:
            _fail("multiple releases exist for the approved tag")
        release = drafts[0] if drafts else None
    if release is not None:
        # validates tag/body/prerelease and every asset before any mutation,
        # so an unrelated or changed release is never touched
        _verify_release(release, plan)
        if release.get("draft") is False:
            _verify_release(release, plan, complete=True)
            return {"status": "published", "release": release["html_url"], "changed": False}
    # Only a fully verified published release may skip the main-position guard;
    # anything left to mutate requires main at base_sha or source_sha.
    if main_sha not in (base_sha, source_sha):
        _fail("main is neither base_sha nor source_sha")
    if main_sha == base_sha:
        api.patch("git/refs/heads/main", {"sha": source_sha, "force": False})
    if tag_ref is None:
        api.post("git/refs", {"ref": f"refs/tags/{TAG}", "sha": source_sha})
    if release is None:
        release = api.post(
            "releases",
            {"tag_name": TAG, "name": TITLE, "body": plan["body"], "draft": True, "prerelease": True, "target_commitish": source_sha},
        )
    release_id = release["id"]
    for name in ASSET_NAMES:
        current = api.get(f"releases/{release_id}")
        _verify_release(current, plan)
        if current.get("draft") is not True:
            _fail("release was published concurrently; refusing further uploads")
        states = {}
        for asset in current.get("assets", []):
            name_ = asset.get("name")
            expected = plan["assets"].get(name_)
            if expected is None:
                _fail(f"unknown asset on existing release: {name_!r}")
            states[name_] = _known_asset_state(name_, asset, expected)
        to_upload = [n for n in ASSET_NAMES if states.get(n) != "ok"]
        if not to_upload:
            break
        api.upload(release_id, plan["assets"][to_upload[0]]["path"])
    final = api.get(f"releases/{release_id}")
    _verify_release(final, plan, complete=True)
    for asset in final.get("assets", []):
        if asset.get("state") != "uploaded":
            _fail(f"asset {asset.get('name')!r} not fully uploaded; leaving draft")
    if final.get("draft") is True:
        api.patch(f"releases/{release_id}", {"draft": False, "prerelease": True, "make_latest": "false"})
    final = api.get(f"releases/{release_id}")
    _verify_release(final, plan, complete=True)
    if final.get("draft") is not False:
        _fail("GitHub did not confirm publication")
    return {"status": "published", "release": final["html_url"], "changed": True}


class GhApi:
    """GitHub REST adapter over the gh CLI. GH_TOKEN comes only from the
    environment and is never printed, logged, or written to disk."""

    def __init__(self, repo: str, timeout: int = 60):
        self.repo = repo
        self.timeout = timeout

    def _env(self) -> dict:
        env = dict(os.environ)
        env.pop("GH_DEBUG", None)
        if not env.get("GH_TOKEN"):
            _fail("GH_TOKEN must be set in the environment")
        return env

    def _run(self, args: list[str], stdin: str | None = None, parse_json: bool = True) -> object:
        try:
            proc = subprocess.run(
                args, input=stdin, capture_output=True, text=True, timeout=self.timeout, env=self._env()
            )
        except subprocess.TimeoutExpired:
            _fail(f"gh timed out: {' '.join(args[:3])}")
        if proc.returncode != 0:
            message = proc.stderr.replace(os.environ.get("GH_TOKEN", "\0"), "[redacted]")
            raise RuntimeError(f"gh api failed ({' '.join(args[:4])}): {message.strip()[:400]}")
        out = proc.stdout.strip()
        return (json.loads(out) if out else None) if parse_json else out

    def _api(self, method: str, route: str, payload=None):
        args = ["gh", "api", "--method", method, f"repos/{self.repo}/{route}", "--input", "-"]
        return self._run(args, None if payload is None else json.dumps(payload))

    def get(self, route: str):
        try:
            proc = subprocess.run(
                ["gh", "api", f"repos/{self.repo}/{route}"],
                capture_output=True, text=True, timeout=self.timeout, env=self._env(),
            )
        except subprocess.TimeoutExpired:
            _fail(f"gh timed out on GET {route}")
        if proc.returncode != 0:
            if re.search(r"\bHTTP 404\b", proc.stderr):
                return None
            message = proc.stderr.replace(os.environ.get("GH_TOKEN", "\0"), "[redacted]")
            raise RuntimeError(f"gh api GET failed: {message.strip()[:400]}")
        out = proc.stdout.strip()
        return json.loads(out) if out else None

    def post(self, route: str, json_body):
        return self._api("POST", route, json_body)

    def patch(self, route: str, json_body):
        return self._api("PATCH", route, json_body)

    def upload(self, release_id, path):
        current = self.get(f"releases/{release_id}")
        if not current or current.get("id") != release_id or current.get("draft") is not True:
            _fail("upload target is not the expected draft release")
        previous_timeout = self.timeout
        self.timeout = 300
        try:
            self._run(["gh", "release", "upload", TAG, str(path), "--repo", self.repo], None, parse_json=False)
        finally:
            self.timeout = previous_timeout
        refreshed = self.get(f"releases/{release_id}")
        matches = [a for a in refreshed.get("assets", []) if a.get("name") == Path(path).name]
        if len(matches) != 1:
            _fail("GitHub did not confirm exactly one uploaded asset")
        return matches[0]


def load_config(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv=None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "publish"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--vsix", type=Path)
    parser.add_argument("--notes", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    if cfg.get("repo") != REPO or cfg.get("version") != VERSION:
        _fail("unexpected publisher configuration")
    if args.command == "prepare":
        plan = prepare_assets(args.source, args.vsix, args.notes, args.out, cfg["version"], cfg["body_sha"])
        plan.update(repo=cfg["repo"], source_sha=cfg["source_sha"], base_sha=cfg["base_sha"], ci_run_id=cfg["ci_run_id"])
        args.plan.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "prepared", "assets": sorted(plan["assets"])}))
        return 0
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    for key in ("repo", "version", "source_sha", "base_sha", "ci_run_id"):
        if plan.get(key) != cfg.get(key):
            _fail(f"publication plan differs from trusted config: {key}")
    if _sha256_bytes(plan["body"].encode()) != cfg["body_sha"]:
        _fail("publication body differs from approved notes")
    actual = subprocess.check_output(["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True).strip()
    if actual != cfg["source_sha"]:
        _fail("source checkout is not the validated commit")
    result = publish(plan, GhApi(plan["repo"]))
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
