import unittest
from cleanup import deletion_plan,push_arguments,remote_refs

M='a'*40
B='b'*40
class Cleanup(unittest.TestCase):
    def test_only_integrated_exact_refs(self):
        p=deletion_plan({'codex/old':B},{'main':M,'codex/old':B},M,lambda *a:True)
        self.assertEqual(p,[('codex/old',B)])
        args=push_arguments(p)
        self.assertIn('--atomic',args);self.assertIn('--force-with-lease=refs/heads/codex/old:'+B,args)
        self.assertEqual(args[-3:],['origin','--delete','codex/old']);self.assertNotIn('main',args)
    def test_unmerged_branch_is_retained(self):
        with self.assertRaises(ValueError):deletion_plan({'codex/old':B},{'main':M,'codex/old':B},M,lambda *a:False)
    def test_advanced_branch_is_retained(self):
        with self.assertRaises(ValueError):deletion_plan({'codex/old':B},{'main':M,'codex/old':'c'*40},M,lambda *a:True)
    def test_main_race_retains_branches(self):
        with self.assertRaises(ValueError):deletion_plan({'codex/old':B},{'main':'c'*40,'codex/old':B},M,lambda *a:True)
    def test_new_unreviewed_branch_retains_all(self):
        with self.assertRaises(ValueError):deletion_plan({'codex/old':B},{'main':M,'codex/old':B,'codex/new':B},M,lambda *a:True)
    def test_main_and_other_names_never_deleted(self):
        for name in ['main','feature/other','codex/../main','codex/bad name']:
            with self.assertRaises(ValueError):deletion_plan({name:B},{'main':M},M,lambda *a:True)
    def test_retry_with_deleted_refs_is_safe(self):
        self.assertEqual(deletion_plan({'codex/old':B},{'main':M},M,lambda *a:True),[])
    def test_no_empty_push(self):
        with self.assertRaises(ValueError):push_arguments([])
    def test_remote_parser_exact_sha_and_prefix(self):
        self.assertEqual(remote_refs(M+'\trefs/heads/main\n','refs/heads/'),{'main':M})
        for text in ['bad\trefs/heads/main\n',M+'\trefs/tags/v0.1.5\n',M+'\trefs/heads/main\n'+M+'\trefs/heads/main\n']:
            with self.assertRaises(ValueError):remote_refs(text,'refs/heads/')
    def test_dry_run_carries_the_same_leases(self):
        p=[('codex/old',B)]
        a=push_arguments(p,True);a.remove('--dry-run')
        self.assertEqual(a,push_arguments(p))

if __name__=='__main__':unittest.main()
