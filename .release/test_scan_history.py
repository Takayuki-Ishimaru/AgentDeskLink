import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from scan_history import HistoryScanError, scan_history

SCANNER = os.getenv('GITLEAKS_TEST_BIN')


@unittest.skipUnless(SCANNER, 'Set GITLEAKS_TEST_BIN to the pinned executable')
class ScanHistoryTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.temp = Path(folder.name)
        self.repo = self.temp / 'repo'
        self.repo.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Synthetic Test')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        (self.repo / 'safe.txt').write_text('sample', encoding='ascii')
        self.git('add', 'safe.txt')
        self.git('commit', '-qm', 'Initial')

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True, timeout=10)

    def test_scans_a_tag_only_commit_and_ignores_inline_allow(self):
        scan_history(self.repo, SCANNER)
        self.git('switch', '-qc', 'fixture')
        key = 'AKIA' + 'ABCDEFGHIJKLMNOP'
        (self.repo / 'fixture.txt').write_text(f'fixture={key} # gitleaks:allow\n', encoding='ascii')
        self.git('add', 'fixture.txt')
        self.git('commit', '-qm', 'Test fixture')
        self.git('tag', 'v0.0.1')
        self.git('switch', '-q', 'main')
        self.git('branch', '-D', 'fixture')
        report = self.temp / 'private.json'
        with self.assertRaisesRegex(HistoryScanError, 'potential secrets'):
            scan_history(self.repo, SCANNER, report)
        body = report.read_text(encoding='utf-8')
        self.assertNotIn(key, body)
        self.assertEqual([(row['RuleID'], row['File']) for row in json.loads(body)],
                         [('aws-access-token', 'fixture.txt')])

    def test_rejects_shallow_history(self):
        shallow = self.temp / 'shallow'
        self.git('clone', '-q', '--depth=1', self.repo.as_uri(), str(shallow))
        with self.assertRaisesRegex(HistoryScanError, 'Shallow history'):
            scan_history(shallow, SCANNER)


if __name__ == '__main__':
    unittest.main()
