import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from review_gate import ReviewError, snapshot, verify_review
from release_preflight import verify_publication


class ReviewGateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root / 'source'
        self.source.mkdir()
        self.assets = root / 'assets'
        self.assets.mkdir()
        self.notes = root / 'release.md'
        self.notes.write_text('Public release note', encoding='utf-8')
        self.record = root / 'review.json'
        (self.source / 'package.json').write_text('{"version":"1.2.3"}', encoding='utf-8')
        self.git('init', '-q')
        self.git('add', 'package.json')
        self.git('-c', 'user.name=Synthetic Reviewer', '-c', 'user.email=reviewer@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial')
        for name in ('AgentDeskLink-1.2.3-docs.zip', 'agentdesklink-1.2.3.vsix', 'SHA256SUMS'):
            (self.assets / name).write_text(name, encoding='utf-8')

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.source), *args], check=True, capture_output=True, timeout=10)

    def save(self, approved=True):
        data = snapshot(self.source, self.assets, self.notes)
        if approved:
            data['reviews'] = {key: True for key in data['reviews']}
            data['reviewer'] = 'reviewer'
            data['reviewed_at'] = '2025-01-01T00:00:00Z'
        self.record.write_text(json.dumps(data), encoding='utf-8')
        return data

    def verify(self):
        return verify_review(self.source, self.assets, self.notes, self.record)

    def test_requires_real_record(self):
        with self.assertRaises(ReviewError): self.verify()
        data = self.save(approved=False)
        self.assertEqual(set(data['reviews']), {'company_customer_terms', 'business_design', 'examples_and_media', 'public_artifacts'})
        with self.assertRaises(ReviewError): self.verify()
        data = self.save()
        self.assertEqual(self.verify()['source_sha'], data['source_sha'])
        data['reviews']['business_design'] = 1
        self.record.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaises(ReviewError): self.verify()

    def test_changes_invalidate_review(self):
        self.save()
        self.notes.write_text('Changed note', encoding='utf-8')
        with self.assertRaises(ReviewError): self.verify()
        self.save()
        (self.assets / 'agentdesklink-1.2.3.vsix').write_bytes(b'changed')
        with self.assertRaises(ReviewError): self.verify()
        self.save()
        self.git('tag', 'v1.0.0')
        with self.assertRaises(ReviewError): self.verify()

    def test_dirty_source_and_record_inside_checkout_rejected(self):
        self.save()
        (self.source / 'package.json').write_text('{"version":"1.2.4"}', encoding='utf-8')
        with self.assertRaises(ReviewError): self.verify()
        self.git('checkout', '--', 'package.json')
        inside = self.source / 'review.json'
        inside.write_bytes(self.record.read_bytes())
        with self.assertRaises(ReviewError): verify_review(self.source, self.assets, self.notes, inside)

    def test_release_preflight_requires_matching_checksums_and_scan(self):
        self.save()
        with patch('release_preflight.scan_history') as scan:
            with self.assertRaisesRegex(ReviewError, 'SHA256SUMS'):
                verify_publication(self.source, self.assets, self.notes, self.record, 'gitleaks')
            scan.assert_not_called()
            sums = ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n'
                           for p in sorted(self.assets.iterdir()) if p.name != 'SHA256SUMS')
            (self.assets / 'SHA256SUMS').write_text(sums, encoding='ascii')
            self.save()
            verify_publication(self.source, self.assets, self.notes, self.record, 'gitleaks')
            scan.assert_called_once_with(self.source, 'gitleaks')
            scan.side_effect = lambda *_: self.notes.write_text('Changed during scan', encoding='utf-8')
            with self.assertRaisesRegex(ReviewError, 'stale'):
                verify_publication(self.source, self.assets, self.notes, self.record, 'gitleaks')


if __name__ == '__main__': unittest.main()
