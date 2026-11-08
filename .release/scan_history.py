"""Run the pinned Gitleaks rules against every commit reachable from local refs."""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

VERSION = '8.30.1'
FINDINGS_EXIT = 17


class HistoryScanError(RuntimeError):
    pass


def _run(args, env, timeout):
    try:
        return subprocess.run(args, env=env, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HistoryScanError('Could not complete the history scan.') from error


def scan_history(source: Path, gitleaks: str, report: Path | None = None) -> None:
    source = source.resolve()
    if report is not None:
        report = report.resolve()
        if report.is_relative_to(source):
            raise HistoryScanError('Store the private scan report outside the checkout.')
    executable = shutil.which(gitleaks)
    if not executable:
        raise HistoryScanError('The pinned Gitleaks executable is required.')
    env = {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}
    env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_TERMINAL_PROMPT='0')

    def git(*args):
        result = _run(['git', '-C', str(source), *args], env, 30)
        if result.returncode:
            raise HistoryScanError('A complete Git repository is required.')
        return result.stdout.strip()

    bare = git('rev-parse', '--is-bare-repository') == b'true'
    root = git('rev-parse', '--absolute-git-dir' if bare else '--show-toplevel')
    if Path(os.fsdecode(root)).resolve() != source:
        raise HistoryScanError('Run the scan at the repository root.')
    if git('rev-parse', '--is-shallow-repository') != b'false':
        raise HistoryScanError('Shallow history cannot pass the release scan.')
    git('rev-parse', '--verify', 'HEAD')
    grafts = Path(os.fsdecode(git('rev-parse', '--path-format=absolute', '--git-path', 'info/grafts')))
    if grafts.exists() or git('for-each-ref', '--format=%(refname)', 'refs/replace'):
        raise HistoryScanError('History overrides must be removed before the scan.')
    version = _run([executable, 'version'], env, 30)
    if version.returncode or version.stdout.strip() != VERSION.encode():
        raise HistoryScanError(f'Use Gitleaks {VERSION} for the release scan.')

    with tempfile.TemporaryDirectory(prefix='adl-history-scan-') as folder:
        temp = Path(folder)
        config = temp / 'defaults.toml'
        config.write_text('[extend]\nuseDefault = true\n', encoding='ascii')
        output = temp / 'findings.json'
        args = [executable, 'git', '--no-banner', '--redact=100', '--log-level=error',
                '--config', str(config), '--gitleaks-ignore-path', str(temp), '--ignore-gitleaks-allow',
                '--log-opts=--all --full-history --diff-merges=separate --no-ext-diff --no-textconv',
                '--exit-code', str(FINDINGS_EXIT), '--report-format', 'json', '--report-path', str(output), str(source)]
        result = _run(args, env, 600)
        if result.returncode not in (0, FINDINGS_EXIT):
            raise HistoryScanError('Gitleaks could not complete the full-history scan.')
        try:
            findings = json.loads(output.read_text(encoding='utf-8'))
            if not isinstance(findings, list) or bool(findings) != (result.returncode == FINDINGS_EXIT):
                raise ValueError('unexpected report')
            if report is not None:
                locations = [{key: row[key] for key in ('RuleID', 'File', 'Commit', 'StartLine')} for row in findings]
                with report.open('x', encoding='utf-8') as stream:
                    json.dump(locations, stream, indent=2)
                    stream.write('\n')
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise HistoryScanError('Could not verify or save the private Gitleaks report.') from error
        if findings:
            raise HistoryScanError('Gitleaks found potential secrets. Inspect a private report before publishing.')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--gitleaks', required=True)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    try:
        scan_history(args.source, args.gitleaks, args.report)
    except HistoryScanError as error:
        parser.exit(1, f'{error}\n')
    print('Gitleaks full-history scan passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
