import {parsePolicy} from './policy.js';
import type {PolicyConfig} from './types.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The host supplies an installed helper; the policy still supplies every permission.
// Standalone launches retain the existing requirement for an explicit helperPath.
export function parseStartupPolicy(input: unknown, helperPath?: string, platform: string = process.platform): PolicyConfig {
  const key = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : undefined;
  if (helperPath && key && object(input) && object(input[key]) && !Object.hasOwn(input[key], 'helperPath')) {
    return parsePolicy({...input, [key]: {...input[key], helperPath}});
  }
  return parsePolicy(input);
}

// Only extension-managed launches opt into this profile. Standalone CLI policy stays explicit.
export function extensionPolicy(helperPath?:string,platform:string=process.platform):PolicyConfig {
  const desktop=helperPath?{helperPath,appId:'*',appPath:helperPath,classification:'PUBLIC',allowAllOperations:true,
    visual:{enabled:true,allowUnredacted:true},interactive:{enabled:true,surfaces:[{id:'desktop',region:{x:0,y:0,width:4096,height:4096},kinds:['drag','swipe']}]}}:undefined;
  return parsePolicy({allowAllOperations:true,allowLoopback:true,allowPrivateNetwork:true,
    browserTargets:[{id:'browser',label:'ブラウザ / Browser',url:'https://example.com',classification:'PUBLIC',visual:{enabled:true},
      gestures:{enabled:true,surfaces:[{id:'page',selector:'body',kinds:['drag','swipe']}]}}],
    ...(desktop&&platform==='darwin'?{macos:desktop}:desktop&&platform==='win32'?{windows:desktop}:{})});
}
