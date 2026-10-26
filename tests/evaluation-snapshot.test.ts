import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotStore} from '../src/snapshot.js';
import type {Element} from '../src/types.js';

const element=(id:string,name:string):Element=>({id,role:'status',name,enabled:true});
test('scoped deltas reconstruct scope exits, entries, changes and removals before projection',()=>{
  const store=new SnapshotStore();
  const before=[element('exit','Ready'),element('stay','Ready'),element('delete','Ready'),element('enter','Done')];
  const after=[element('exit','Done'),{...element('stay','Ready'),enabled:false},element('enter','Ready')];
  store.record('s',1,{elements:before,fingerprint:'1',truncated:false});
  store.record('s',2,{elements:after,fingerprint:'2',truncated:false});
  for(const include of [undefined,['id','enabled']]){
    const options={token_budget:1800,scope:'name:Ready',include};
    const initial=store.observe('s',1,options);
    const delta=store.observe('s',2,{...options,since_revision:1});
    const actual=new Map(initial.elements?.map(e=>[e.id,e]));
    for(const change of delta.changes??[])if(change.op==='removed')actual.delete(change.id);else actual.set(change.id,change.element!);
    assert.deepEqual([...actual].sort(),store.observe('s',2,options).elements?.map(e=>[e.id,e]).sort());
    assert.deepEqual(delta.changes?.filter(c=>c.op==='removed').map(c=>c.id).sort(),['delete','exit']);
    assert.equal(delta.changes?.find(c=>c.id==='enter')?.op,'added');
  }
});

test('auto representation resets large deltas and keeps small deltas with bounded cursor pages',()=>{
  for(const token_budget of [256,1800,8000]){
    const store=new SnapshotStore();
    const before=Array.from({length:200},(_,i)=>element(`e${i}`,`Ready ${i}`));
    store.record('s',1,{elements:before,fingerprint:'1',truncated:false});
    store.record('s',2,{elements:before.map(e=>({...e,name:e.name.replace('Ready','Done')})),fingerprint:'2',truncated:false});
    const collect=(extra:Record<string,unknown>)=>{
      let cursor:string|undefined;const pages:any[]=[];
      do{const p=store.observe('s',2,{token_budget,...extra,...(cursor?{cursor}:{})} as any);pages.push(p);assert.ok(Buffer.byteLength(JSON.stringify(p))<=token_budget*4);cursor=p.next_cursor??undefined;assert.ok(pages.length<100);}while(cursor);
      return pages;
    };
    const automatic=collect({since_revision:1,representation:'auto'});
    assert.ok(automatic.every(p=>p.representation==='full'&&p.reset===true));
    assert.deepEqual(automatic.flatMap(p=>p.elements??[]),collect({}).flatMap(p=>p.elements??[]));
    store.record('s',3,{elements:before,fingerprint:'3',truncated:false});
    const unchanged=store.observe('s',3,{token_budget,since_revision:1,representation:'auto'} as any) as any;
    assert.equal(unchanged.representation,'delta');assert.deepEqual(unchanged.changes,[]);assert.notEqual(unchanged.reset,true);
  }
});

test('legacy deltas remain compatible; auto without a baseline is full; cursors bind representation',()=>{
  const store=new SnapshotStore();const elements=Array.from({length:30},(_,i)=>element(`e${i}`,`Ready ${i}`));
  store.record('s',1,{elements,fingerprint:'1',truncated:false});
  store.record('s',2,{elements:elements.map(e=>({...e,name:'Done'})),fingerprint:'2',truncated:false});
  const legacy=store.observe('s',2,{token_budget:256,since_revision:1});
  assert.ok(legacy.changes);assert.equal(legacy.reset,undefined);assert.equal(legacy.representation,undefined);
  const first=store.observe('s',1,{token_budget:256,representation:'auto'});
  assert.equal(first.representation,'full');assert.ok(first.elements);assert.ok(!first.reset);assert.ok(first.next_cursor);
  assert.throws(()=>store.observe('s',1,{token_budget:256,representation:'full',cursor:first.next_cursor!}),{code:'E_STALE_STATE'});
});
