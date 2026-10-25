import {mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export interface OperationState {epoch:string;stopped:boolean;}
export function readOperationState(file:string):OperationState|undefined {
  try {
    const text=readFileSync(file,'utf8');if(text.length>512)return;
    const value=JSON.parse(text);
    if(typeof value?.epoch==='string'&&/^[a-f0-9-]{36}$/.test(value.epoch)&&typeof value.stopped==='boolean')return {epoch:value.epoch,stopped:value.stopped};
  }catch{}
  return undefined;
}
export function initializeOperationState(file:string):void {
  mkdirSync(dirname(file),{recursive:true});
  try {writeFileSync(file,JSON.stringify({epoch:randomUUID(),stopped:false}),{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
}
export function writeOperationState(file:string,stopped:boolean):OperationState {
  mkdirSync(dirname(file),{recursive:true});
  const state={epoch:randomUUID(),stopped},temporary=`${file}.${state.epoch}.tmp`;
  try {writeFileSync(temporary,JSON.stringify(state),{mode:0o600});renameSync(temporary,file);}
  finally {try{unlinkSync(temporary);}catch{}}
  return state;
}
// Any generation change permanently revokes this process, including a rapid stop/resume.
// A resumed extension must provide a fresh definition; an old process never resumes work.
export function watchOperationControl(file:string,epoch:string,stop:()=>void):{check:()=>boolean;dispose:()=>void} {
  let revoked=false;
  const check=()=>{
    if(revoked)return false;
    const state=readOperationState(file);
    if(!state||state.stopped||state.epoch!==epoch){revoked=true;stop();return false;}
    return true;
  };
  const timer=setInterval(check,50);timer.unref();check();
  return {check,dispose:()=>clearInterval(timer)};
}
