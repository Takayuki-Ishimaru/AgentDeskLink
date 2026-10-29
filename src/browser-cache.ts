import type {FetchResult} from './browser-network.js';

/** Session-only HTTP cache for explicitly public static assets. Policy/DNS checks precede every lookup. */
export class BrowserResourceCache {
  private readonly entries=new Map<string,{response:FetchResult;expires:number}>();
  private bytes=0;
  key(url:URL,ip:string,method:string,type:string,headers:Record<string,string>):string|undefined{
    if(method!=='GET'||!['script','stylesheet','image','font'].includes(type)||Object.keys(headers).some(k=>/^(cookie|authorization|proxy-authorization|cache-control|pragma)$/i.test(k)))return;
    const key=JSON.stringify([url.href,ip,type,Object.entries(headers).sort(([a],[b])=>a.localeCompare(b))]);
    return key.length<=16384?key:undefined;
  }
  get(key:string|undefined,now=Date.now()):FetchResult|undefined{
    if(!key)return;const entry=this.entries.get(key);if(!entry)return;
    if(entry.expires<=now){this.entries.delete(key);this.bytes-=entry.response.body.length;return;}
    this.entries.delete(key);this.entries.set(key,entry);return entry.response;
  }
  put(key:string|undefined,response:FetchResult,now=Date.now()):void{
    if(!key||response.status!==200||response.headers['set-cookie']||response.headers.vary)return;
    const control=String(response.headers['cache-control']??'');
    if(!/(?:^|,)\s*public\s*(?:,|$)/i.test(control)||/\b(?:no-store|no-cache|private)\b/i.test(control))return;
    const ages=[...control.matchAll(/(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?=,|$)/gi)];if(ages.length!==1)return;
    const age=Number(response.headers.age??0),date=response.headers.date?Date.parse(response.headers.date):now;
    if(!Number.isFinite(age)||age<0||!Number.isFinite(date))return;
    const remaining=Math.min(300,Number(ages[0]![1]))-Math.max(age,Math.max(0,(now-date)/1000));
    if(remaining<=0||response.body.length>32*1024*1024)return;
    const old=this.entries.get(key);if(old){this.entries.delete(key);this.bytes-=old.response.body.length;}
    this.entries.set(key,{response,expires:now+remaining*1000});this.bytes+=response.body.length;
    while(this.entries.size>64||this.bytes>32*1024*1024){const first=this.entries.keys().next().value!;this.bytes-=this.entries.get(first)!.response.body.length;this.entries.delete(first);}
  }
  clear():void{this.entries.clear();this.bytes=0;}
}
