import copy, hashlib, importlib, json, tempfile, unittest, zipfile
from pathlib import Path

p = importlib.import_module('publisher')
SHA='a'*40
BASE='b'*40

class API:
    def __init__(self):
        self.events=[]; self.main=BASE; self.tag=None; self.release=None
        self.ci={'head_sha':SHA,'status':'completed','conclusion':'success','name':'Beta validation','path':'.github/workflows/ci.yml','repository':{'full_name':'Takayuki-Ishimaru/AgentDeskLink'}}
        self.bad_upload=False
    def get(self, route):
        if route=='actions/runs/123': return copy.deepcopy(self.ci)
        if route=='git/ref/heads/main': return {'object':{'sha':self.main}}
        if route=='git/ref/tags/v0.1.5': return None if self.tag is None else {'object':{'sha':self.tag,'type':'commit'}}
        if route.startswith('releases/'): return copy.deepcopy(self.release)
        raise AssertionError(route)
    def patch(self, route, data):
        self.events.append(('patch',route,copy.deepcopy(data)))
        if route=='git/refs/heads/main':
            assert data['sha']==SHA and data['force'] is False
            self.main=data['sha']; return {'object':{'sha':self.main}}
        if route=='releases/1': self.release.update(data); return copy.deepcopy(self.release)
        raise AssertionError(route)
    def post(self, route, data):
        self.events.append(('post',route,copy.deepcopy(data)))
        if route=='git/refs':
            assert data['ref']=='refs/tags/v0.1.5' and data['sha']==SHA
            self.tag=data['sha']; return {'object':{'sha':self.tag}}
        if route=='releases':
            assert data['draft'] is True and data['prerelease'] is True
            self.release={**data,'id':1,'assets':[],'html_url':'https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases/tag/v0.1.5'}
            return copy.deepcopy(self.release)
        raise AssertionError(route)
    def upload(self, release_id, path):
        assert release_id==1
        path=Path(path); data=path.read_bytes()
        row={'name':path.name,'size':len(data),'digest':'sha256:'+hashlib.sha256(data).hexdigest(),'state':'uploaded'}
        if self.bad_upload: row['digest']='sha256:'+'0'*64
        self.events.append(('upload',path.name))
        self.release['assets'].append(row)
        return copy.deepcopy(row)

class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); self.source=self.root/'source'; self.source.mkdir()
        self.files={'README.md':'# Guide\n','README_en.md':'# Guide\n','LICENSE':'MIT\n','release-docs/RELEASE_NOTES_ja.md':'# Changes\n','release-docs/RELEASE_NOTES_en.md':'# Changes\n','release-docs/OPERATIONS.md':'# Operations\n','config/demo.json':'{}','media/icon.png':'png','dist/src/server.js':'server','dist/extension/extension.cjs':'extension'}
        for name,data in self.files.items():
            target=self.source/name; target.parent.mkdir(parents=True,exist_ok=True); target.write_text(data,newline='\n')
        (self.source/'package.json').write_text(json.dumps({'version':'0.1.5'}))
        self.vsix=self.root/'agentdesklink-0.1.5.vsix'; self.write_vsix()
        self.notes=self.root/'notes.md'; self.notes.write_text('# AgentDeskLink 0.1.5\n')
        self.body_sha=hashlib.sha256(self.notes.read_bytes()).hexdigest()
    def write_vsix(self, changes=None, extra=None):
        rows={'extension/'+('readme.md' if n=='README.md' else 'LICENSE.txt' if n=='LICENSE' else n):v.encode() for n,v in self.files.items()}
        rows['extension/package.json']=json.dumps({'version':'0.1.5'}).encode()
        rows['extension/runtime/manifest.json']=json.dumps({'schemaVersion':3,'targets':['darwin-arm64','win32-x64','linux-x64']}).encode()
        for target in ['darwin-arm64','win32-x64','linux-x64']:
            rows[f'extension/runtime/{target}/manifest.json']=json.dumps({'schemaVersion':2,'target':target}).encode()
        rows.update(changes or {}); rows.update(extra or {})
        with zipfile.ZipFile(self.vsix,'w') as z:
            for name,data in rows.items():z.writestr(name,data)
    def plan(self):
        plan=p.prepare_assets(self.source,self.vsix,self.notes,self.root/'assets','0.1.5',self.body_sha)
        plan.update(repo='Takayuki-Ishimaru/AgentDeskLink',source_sha=SHA,base_sha=BASE,ci_run_id=123)
        return plan

class PayloadTests(Fixture):
    def test_valid_payload_and_docs_zip(self):
        plan=self.plan(); self.assertEqual(set(plan['assets']),{'agentdesklink-0.1.5.vsix','AgentDeskLink-0.1.5-docs.zip','SHA256SUMS'})
        with zipfile.ZipFile(plan['assets']['AgentDeskLink-0.1.5-docs.zip']['path']) as z:
            self.assertIn('release-docs/OPERATIONS.md',z.namelist()); self.assertNotIn('dist/src/server.js',z.namelist())
            self.assertEqual(z.read('README.md'),(self.source/'README.md').read_bytes())
    def test_body_hash(self):
        self.notes.write_text('changed')
        with self.assertRaises(ValueError):self.plan()
    def test_document_bytes(self):
        self.write_vsix({'extension/release-docs/OPERATIONS.md':b'changed'})
        with self.assertRaises(ValueError):self.plan()
    def test_version(self):
        self.write_vsix({'extension/package.json':b'{"version":"0.1.4"}'})
        with self.assertRaises(ValueError):self.plan()
    def test_internal_paths(self):
        for name in ['extension/docs/internal.md','extension/tests/report.txt','extension/release-docs/DEVELOPMENT.md','../escape']:
            with self.subTest(name=name):
                self.write_vsix(extra={name:b'internal'})
                with self.assertRaises(ValueError):self.plan()
    def test_internal_scores(self):
        self.notes.write_text('Internal score: 99%\n'); self.body_sha=hashlib.sha256(self.notes.read_bytes()).hexdigest()
        with self.assertRaises(ValueError):self.plan()
    def test_compiled_code(self):
        self.write_vsix({'extension/dist/src/server.js':b'other build'})
        with self.assertRaises(ValueError):self.plan()
    def test_runtime_targets(self):
        self.write_vsix({'extension/runtime/manifest.json':b'{"schemaVersion":3,"targets":["linux-x64"]}'})
        with self.assertRaises(ValueError):self.plan()

class PublicationTests(Fixture):
    def test_publish_and_idempotent_retry(self):
        plan=self.plan(); api=API(); p.publish(plan,api)
        self.assertFalse(api.release['draft']); self.assertTrue(api.release['prerelease']); self.assertEqual(api.tag,SHA)
        self.assertEqual(len(api.release['assets']),3)
        calls=len(api.events);p.publish(plan,api);self.assertEqual(len(api.events),calls)
    def test_ci_guards_precede_every_mutation(self):
        plan=self.plan()
        for field,value in [('head_sha','c'*40),('status','in_progress'),('conclusion','failure'),('name','Other'),('path','untrusted.yml')]:
            with self.subTest(field=field):
                api=API();api.ci[field]=value
                with self.assertRaises(ValueError):p.publish(plan,api)
                self.assertEqual(api.events,[])
    def test_advanced_main(self):
        api=API();api.main='c'*40
        with self.assertRaises(ValueError):p.publish(self.plan(),api)
        self.assertEqual(api.events,[])
    def test_wrong_tag(self):
        api=API();api.tag='c'*40
        with self.assertRaises(ValueError):p.publish(self.plan(),api)
        self.assertEqual(api.events,[])
    def test_tampered_local_asset(self):
        plan=self.plan();Path(plan['assets']['agentdesklink-0.1.5.vsix']['path']).write_bytes(b'changed');api=API()
        with self.assertRaises(ValueError):p.publish(plan,api)
        self.assertEqual(api.events,[])
    def test_bad_uploaded_digest_never_publishes(self):
        api=API();api.bad_upload=True
        with self.assertRaises(ValueError):p.publish(self.plan(),api)
        self.assertTrue(api.release['draft'])
        self.assertFalse(any(e[0]=='patch' and e[1]=='releases/1' for e in api.events))
    def test_unrelated_release_body(self):
        api=API();api.release={'id':1,'tag_name':'v0.1.5','body':'other','draft':True,'prerelease':True,'assets':[]};api.tag=SHA
        with self.assertRaises(ValueError):p.publish(self.plan(),api)
        self.assertEqual(api.events,[])
    def test_main_ref_race_stops_before_release(self):
        plan=self.plan();api=API()
        original=api.patch
        def race(route,data):
            if route=='git/refs/heads/main':raise RuntimeError('non fast forward')
            return original(route,data)
        api.patch=race
        with self.assertRaises(RuntimeError):p.publish(plan,api)
        self.assertIsNone(api.release)

if __name__=='__main__':unittest.main()
