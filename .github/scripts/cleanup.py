"""Delete the captured branch refs only after their integration CI passes."""
import json, os, re, subprocess, time
from pathlib import Path

REPO='Takayuki-Ishimaru/AgentDeskLink'
SHA=re.compile(r'[0-9a-f]{40}\Z')

def remote_refs(text, prefix):
    result={}
    for line in text.splitlines():
        oid,ref=line.split('\t',1)
        if not SHA.fullmatch(oid) or not ref.startswith(prefix):
            raise ValueError('Unexpected remote reference')
        name=ref[len(prefix):]
        if name in result:raise ValueError('Duplicate remote reference')
        result[name]=oid
    return result

def deletion_plan(expected, actual, main_sha, ancestor):
    if not SHA.fullmatch(main_sha) or actual.get('main')!=main_sha:
        raise ValueError('main changed since the integration run')
    if set(actual)-set(expected)-{'main'}:
        raise ValueError('A new branch appeared; review it before cleanup')
    result=[]
    for name,oid in sorted(expected.items()):
        if not name.startswith('codex/') or '..' in name or not re.fullmatch(r'codex/[A-Za-z0-9._/-]+',name) or not SHA.fullmatch(oid):
            raise ValueError('Invalid captured branch')
        if not ancestor(oid,main_sha):
            raise ValueError('Captured branch is not integrated into main: '+name)
        if name not in actual:continue
        if actual[name]!=oid:raise ValueError('Branch advanced: '+name)
        result.append((name,oid))
    return result

def push_arguments(plan, dry_run=False):
    if not plan:raise ValueError('No branch deletion requested')
    args=['git','push','--atomic']
    if dry_run:args.append('--dry-run')
    args += ['--force-with-lease=refs/heads/'+name+':'+oid for name,oid in plan]
    return args+['origin','--delete',*[name for name,_ in plan]]

def run(args, timeout=60):
    result=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if result.returncode:
        raise RuntimeError('Command failed: '+' '.join(args[:3])+'\n'+result.stderr[-3000:])
    return result.stdout

def get_refs(kind):
    return remote_refs(run(['git','ls-remote','--refs','--'+kind,'origin']), 'refs/'+kind+'/')

def ancestor(oid, main):
    result=subprocess.run(['git','merge-base','--is-ancestor',oid,main],timeout=30)
    if result.returncode not in (0,1):raise RuntimeError('Could not verify commit ancestry')
    return result.returncode==0

def await_ci(main_sha):
    deadline=time.monotonic()+35*60
    previous=None
    while time.monotonic()<deadline:
        data=json.loads(run(['gh','api',f'repos/{REPO}/actions/runs?head_sha={main_sha}&event=push&per_page=100']))
        candidates=[r for r in data['workflow_runs'] if r['head_sha']==main_sha and r['head_branch']=='main' and r['name']=='Beta validation' and r['path']=='.github/workflows/ci.yml']
        if candidates:
            current=max(candidates,key=lambda r:r['id'])
            state=(current['id'],current['status'],current['conclusion'])
            if state!=previous:print('Integration CI:',state,flush=True);previous=state
            if current['status']=='completed':
                if current['conclusion']!='success':raise ValueError('Integration CI did not pass; branches retained')
                return current['id']
        time.sleep(20)
    raise TimeoutError('Integration CI did not finish; branches retained')

def main():
    if os.environ.get('GITHUB_REPOSITORY')!=REPO or os.environ.get('GITHUB_REF')!='refs/heads/main':
        raise ValueError('Cleanup must run in the intended main branch')
    main_sha=os.environ['GITHUB_SHA']
    if run(['git','rev-parse','HEAD']).strip()!=main_sha:raise ValueError('Checkout is not the integration commit')
    config=json.loads(Path('.github/branch-cleanup-20261029.json').read_text())
    if config['repository']!=REPO:raise ValueError('Wrong repository')
    if get_refs('tags')!=config['tags']:raise ValueError('Release tags changed; branches retained')
    ci=await_ci(main_sha)
    plan=deletion_plan(config['branches'],get_refs('heads'),main_sha,ancestor)
    if plan:
        run(push_arguments(plan,True),120)
        if get_refs('tags')!=config['tags']:raise ValueError('Release tags changed; branches retained')
        if deletion_plan(config['branches'],get_refs('heads'),main_sha,ancestor)!=plan:
            raise ValueError('Branch state changed during dry run; branches retained')
        print('Deleting integrated refs with exact SHA leases:',[name for name,_ in plan],flush=True)
        print(run(push_arguments(plan),120),flush=True)
    remaining=get_refs('heads')
    if remaining!={'main':main_sha}:raise ValueError('Unexpected final branches: '+repr(remaining))
    if get_refs('tags')!=config['tags']:raise ValueError('Release tags differ after cleanup')
    print(json.dumps({'status':'integrated-and-cleaned','main':main_sha,'integration_ci_run':ci,'deleted':[name for name,_ in plan],'remaining':['main'],'release_tags':'unchanged'}),flush=True)

if __name__=='__main__':main()
