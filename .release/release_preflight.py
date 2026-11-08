"""Require human review and a fresh history scan before publishing."""

import argparse
from pathlib import Path

from review_gate import ReviewError, verify_review
from scan_history import HistoryScanError, scan_history


def verify_publication(source: Path, assets: Path, notes: Path, record: Path, gitleaks: str) -> dict:
    reviewed = verify_review(source, assets, notes, record)
    expected = {(digest, name) for name, digest in reviewed['asset_sha256'].items() if name != 'SHA256SUMS'}
    try:
        sums = [tuple(line.split()) for line in (assets / 'SHA256SUMS').read_text(encoding='ascii').splitlines()]
    except (OSError, UnicodeError) as error:
        raise ReviewError('Could not read the release checksums.') from error
    if len(sums) != len(expected) or set(sums) != expected:
        raise ReviewError('SHA256SUMS does not match the reviewed release files.')
    scan_history(source, gitleaks)
    if verify_review(source, assets, notes, record) != reviewed:
        raise ReviewError('The review changed during the scan. Run the preflight again.')
    return reviewed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'assets', 'notes', 'review'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--gitleaks', default='gitleaks')
    args = parser.parse_args()
    try:
        verify_publication(args.source, args.assets, args.notes, args.review, args.gitleaks)
    except (ReviewError, HistoryScanError) as error:
        parser.exit(1, f'{error}\n')
    print('Publication preflight passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
