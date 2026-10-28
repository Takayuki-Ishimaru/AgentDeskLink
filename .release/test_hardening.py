import copy, json, os, subprocess, unittest, zipfile
from pathlib import Path
from unittest.mock import patch
from test_publisher import API, Fixture, SHA
import publisher as p

class PublicationGuards(Fixture):
    def seed(self,plan,api):
        api.tag=SHA
        api.release={'id':1,'tag_name':p.TAG,'name':p.TITLE,'body':plan['body'],'draft':True,'prerelease':True,'assets':[],'html_url':'https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases/tag/v0.1.5'}
    def test_missing_upload_is_never_published(self):
        plan=self.plan();api=API();api.upload=lambda *args:None
        with self.assertRaises(ValueError):p.publish(plan,api)
        self.assertTrue(api.release['draft'])
    def test_published_missing_asset_is_refused(self):
        plan=self.plan();api=API();self.seed(plan,api);api.release['draft']=False
        with self.assertRaises(ValueError):p.publish(plan,api)
        self.assertEqual(api.events,[])
    def test_bad_state_with_bad_digest_is_refused_before_mutations(self):
        plan=self.plan();api=API();self.seed(plan,api)
        api.release['assets']=[{'name':p.VSIX_NAME,'size':plan['assets'][p.VSIX_NAME]['bytes'],'digest':'sha256:'+'0'*64,'state':'new'}]
        with self.assertRaises(ValueError):p.publish(plan,api)
        self.assertEqual(api.events,[])
    def test_unknown_and_duplicate_assets_are_refused(self):
        plan=self.plan()
        for assets in [[{'name':'private-report.json'}],[{'name':p.VSIX_NAME,'size':plan['assets'][p.VSIX_NAME]['bytes'],'digest':'sha256:'+plan['assets'][p.VSIX_NAME]['sha256'],'state':'uploaded'}]*2]:
            api=API();self.seed(plan,api);api.release['assets']=assets
            with self.assertRaises(ValueError):p.publish(plan,api)
            self.assertEqual(api.events,[])
    def test_partial_draft_uploads_only_missing_assets(self):
        plan=self.plan();api=API();self.seed(plan,api)
        api.release['assets']=[{'name':p.VSIX_NAME,'size':plan['assets'][p.VSIX_NAME]['bytes'],'digest':'sha256:'+plan['assets'][p.VSIX_NAME]['sha256'],'state':'uploaded'}]
        p.publish(plan,api)
        self.assertEqual(len([e for e in api.events if e[0]=='upload']),2)
        self.assertFalse(api.release['draft'])
    def test_annotated_tag_on_source_is_accepted(self):
        plan=self.plan();api=API();get=api.get
        def annotated(route):
            if route=='git/ref/tags/'+p.TAG:return {'object':{'type':'tag','sha':'c'*40}}
            if route=='git/tags/'+'c'*40:return {'object':{'type':'commit','sha':SHA}}
            return get(route)
        api.get=annotated;p.publish(plan,api);self.assertFalse(api.release['draft'])
    def test_unapproved_asset_list_is_refused(self):
        plan=self.plan();plan['assets'].pop(p.SUMS_NAME);api=API()
        with self.assertRaises(ValueError):p.publish(plan,api)
        self.assertEqual(api.events,[])
    def test_extra_public_document_is_refused(self):
        self.write_vsix(extra={'extension/release-docs/private.md':b'private memo'})
        with self.assertRaises(ValueError):self.plan()
    def test_backslash_and_unknown_root_are_refused(self):
        for name in ['extension\\release-docs\\private.md','private.txt']:
            self.write_vsix(extra={name:b'x'})
            with self.assertRaises(ValueError):self.plan()
    def test_gh_upload_uses_tag_and_never_clobbers(self):
        plan=self.plan();api=p.GhApi(p.REPO);path=Path(plan['assets'][p.VSIX_NAME]['path']);calls=[]
        def get(route):
            return {'id':1,'draft':True,'assets':[{'name':path.name}]}
        api.get=get
        def run(args,**kwargs):
            calls.append((args,kwargs))
            return subprocess.CompletedProcess(args,0,'Uploaded successfully','')
        with patch.dict(os.environ,{'GH_TOKEN':'private-test-token'}),patch('publisher.subprocess.run',side_effect=run):
            api.upload(1,path)
        self.assertEqual(calls[0][0][:4],['gh','release','upload','v0.1.5'])
        self.assertNotIn('--clobber',calls[0][0]);self.assertEqual(calls[0][1]['timeout'],300)
        self.assertFalse(calls[0][1].get('shell',False))
    def test_403_or_500_is_never_treated_as_missing(self):
        for stderr in ['Forbidden (HTTP 403)','Server error (HTTP 500)']:
            with patch.dict(os.environ,{'GH_TOKEN':'test'}),patch('publisher.subprocess.run',return_value=subprocess.CompletedProcess([],22,'',stderr)):
                with self.assertRaises(RuntimeError):p.GhApi(p.REPO).get('releases/tags/'+p.TAG)
    def test_404_is_missing(self):
        with patch.dict(os.environ,{'GH_TOKEN':'test'}),patch('publisher.subprocess.run',return_value=subprocess.CompletedProcess([],1,'','Not Found (HTTP 404)')):
            self.assertIsNone(p.GhApi(p.REPO).get('releases/tags/'+p.TAG))
    def test_json_stdin_preserves_notes_and_does_not_use_shell(self):
        calls=[]
        def run(args,**kwargs):
            calls.append((args,kwargs));return subprocess.CompletedProcess(args,0,'{}','')
        body={'body':'literal `code` $(command)\n日本語'}
        with patch.dict(os.environ,{'GH_TOKEN':'test'}),patch('publisher.subprocess.run',side_effect=run):p.GhApi(p.REPO).post('releases',body)
        self.assertEqual(json.loads(calls[0][1]['input']),body);self.assertFalse(calls[0][1].get('shell',False));self.assertNotIn(body['body'],calls[0][0])
    def test_error_output_redacts_token(self):
        with patch.dict(os.environ,{'GH_TOKEN':'secret-token'}),patch('publisher.subprocess.run',return_value=subprocess.CompletedProcess([],1,'','HTTP 403 secret-token')):
            with self.assertRaises(RuntimeError) as caught:p.GhApi(p.REPO).post('releases',{})
        self.assertNotIn('secret-token',str(caught.exception))
    def test_timeout_cannot_publish(self):
        with patch.dict(os.environ,{'GH_TOKEN':'test'}),patch('publisher.subprocess.run',side_effect=subprocess.TimeoutExpired(['gh'],1)):
            with self.assertRaises(ValueError):p.GhApi(p.REPO).post('releases',{})
    def test_draft_hidden_from_tag_route_resumes_by_id(self):
        plan=self.plan();api=API();self.seed(plan,api);get=api.get
        def hidden(route):
            if route=='releases/tags/'+p.TAG:return None
            return get(route)
        api.get=hidden;p.publish(plan,api)
        self.assertFalse(api.release['draft'])
        self.assertFalse(any(e[0]=='post' and e[1]=='releases' for e in api.events))

    def test_fully_published_release_noop_after_main_advances(self):
        plan=self.plan();api=API();self.seed(plan,api)
        api.release['draft']=False
        api.release['assets']=[{'name':n,'size':plan['assets'][n]['bytes'],'digest':'sha256:'+plan['assets'][n]['sha256'],'state':'uploaded'} for n in p.ASSET_NAMES]
        api.main='c'*40;api.events=[]
        result=p.publish(plan,api)
        self.assertFalse(result['changed']);self.assertEqual(api.events,[])
    def test_draft_release_still_refuses_advanced_main_before_mutations(self):
        plan=self.plan();api=API();self.seed(plan,api);api.main='c'*40
        with self.assertRaises(ValueError):p.publish(plan,api)
        self.assertEqual(api.events,[])
    def test_published_release_with_bad_asset_still_refuses_advanced_main(self):
        plan=self.plan();api=API();self.seed(plan,api)
        api.release['draft']=False
        api.release['assets']=[{'name':n,'size':plan['assets'][n]['bytes'],'digest':'sha256:'+'0'*64,'state':'uploaded'} for n in p.ASSET_NAMES]
        api.main='c'*40
        with self.assertRaises(ValueError):p.publish(plan,api)
        self.assertEqual(api.events,[])

if __name__=='__main__':unittest.main()
