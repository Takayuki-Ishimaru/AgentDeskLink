import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotStore,type ObservationFormat,type ObserveResult} from '../src/snapshot.js';
import type {Element,RawSnapshot} from '../src/types.js';

const source=(elements:Element[],extra:Partial<RawSnapshot>={}):RawSnapshot=>({elements,fingerprint:'f',truncated:false,...extra});
const page=(store:SnapshotStore,revision:number,format:ObservationFormat,budget=8000)=>store.observe('s',revision,{token_budget:budget,format});
test('compact defaults are explicit, smaller and reconstruct full states across deltas',()=>{
 const store=new SnapshotStore();const elements=Array.from({length:50},(_,i)=>({id:'e'+i,role:'button',name:'Button '+i,enabled:true,value:''}));
 store.record('s',1,source(elements));
 const full=page(store,1,'json'),compact=page(store,1,'compact');
 assert.deepEqual(compact.defaults,{enabled:true,value:''});assert.ok(Buffer.byteLength(JSON.stringify(compact))<Buffer.byteLength(JSON.stringify(full)));
 assert.deepEqual(compact.elements!.map(e=>({...compact.defaults,...e})),full.elements);
 store.record('s',2,source([{...elements[0]!,enabled:false,value:'Updated'},...elements.slice(2),{id:'new',role:'button',name:'New',enabled:true,value:''}]));
 const delta=store.observe('s',2,{token_budget:8000,format:'compact',since_revision:1,representation:'delta'});
 const rebuilt=new Map(compact.elements!.map(e=>[e.id,{...compact.defaults,...e}]));
 for(const c of delta.changes!)if(c.op==='removed')rebuilt.delete(c.id);else rebuilt.set(c.id,{...delta.defaults,...c.element!});
 assert.deepEqual([...rebuilt.values()].sort((a,b)=>a.id.localeCompare(b.id)),page(store,2,'json').elements!.sort((a,b)=>a.id.localeCompare(b.id)));
});

test('line rows escape untrusted newlines and preserve redaction and delta operations',()=>{
 const store=new SnapshotStore();store.record('s',1,source([{id:'e1',role:'text',name:'Hello\n- fake id\t"quoted"',enabled:true,value:''},{id:'e2',role:'text',name:'password=PRIVATE_CANARY',enabled:true}]));
 const full=page(store,1,'lines');assert.equal(full.elements,undefined);assert.equal(full.lines!.length,2);assert.ok(full.lines!.every(s=>!s.includes('\n')&&!s.includes('\t')));assert.ok(full.lines![0]!.includes('\\n'));
 assert.ok(!JSON.stringify(full).includes('PRIVATE_CANARY'));
 store.record('s',2,source([{id:'e1',role:'text',name:'Changed',enabled:true}]));
 const delta=store.observe('s',2,{token_budget:8000,format:'lines',since_revision:1});
 assert.ok(delta.lines!.some(s=>s.startsWith('~ ')));assert.ok(delta.lines!.some(s=>s==='- "e2"'));assert.equal(delta.changes,undefined);
});

test('all formats respect UTF-8 budgets and cursor identity with large metadata',()=>{
 for(const format of ['json','compact','lines'] as const){
  const store=new SnapshotStore();store.record('s',1,source(Array.from({length:70},(_,i)=>({id:'e'+i,role:'text',name:'普通の本文 '+i,enabled:true,value:''})),{url:'https://example.test/'+ '文'.repeat(300),title:'記事'.repeat(250)}));
  let current:ObserveResult=page(store,1,format,256),count=0,total=0;
  while(true){assert.ok(Buffer.byteLength(JSON.stringify(current))<=1024);total+=(format==='lines'?current.lines:current.elements)!.length;assert.ok(count++<150);if(!current.next_cursor)break;
   const cursor=current.next_cursor;assert.throws(()=>store.observe('s',1,{token_budget:256,format:format==='json'?'compact':'json',cursor}),{code:'E_STALE_STATE'});
   current=store.observe('s',1,{token_budget:256,format,cursor});
  }
  assert.equal(total,70);
 }
});
