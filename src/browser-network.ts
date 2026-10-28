import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type {Duplex} from 'node:stream';
import {createGunzip, createInflate, createBrotliDecompress} from 'node:zlib';
import {AdlError} from './types.js';

export const MAX_BODY = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 5000;
export const HOP_RE = /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|content-length|content-encoding|host|set-cookie)$/i;

interface FetchResult { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

/** A fresh routed CSS import preserves the destination's encoding and URL base. */
export function redirectStylesheet(destination:URL):Buffer{
  if(!['http:','https:'].includes(destination.protocol)||destination.username||destination.password)throw new AdlError('E_POLICY_DENIED');
  return Buffer.from('@import url('+JSON.stringify(destination.href)+');\n','utf8');
}

// The proxy is trusted configuration. It receives a vetted literal IP, never
// the destination hostname for resolution, so target DNS policy stays pinned.
class PinnedTunnelAgent extends https.Agent{
  private connections=new Set<http.ClientRequest>();
  private tunnels=new Set<Duplex>();
  constructor(private proxy:URL,private target:URL,private ip:string,private signal:AbortSignal){super({keepAlive:false});}
  override createConnection(_options:https.RequestOptions,callback?:(error:Error|null,stream:Duplex)=>void):Duplex|undefined{
    const authority=(this.ip.includes(':')?'['+this.ip+']':this.ip)+':'+(this.target.port||'443');
    const transport=this.proxy.protocol==='https:'?https:http;
    let completed=false;
    const done=(error:Error|null,stream?:Duplex)=>{if(completed){if(stream)stream.destroy();return;}completed=true;callback?.(error,stream!);};
    const connect=transport.request({hostname:this.proxy.hostname.replace(/^\[|\]$/g,''),port:this.proxy.port||(this.proxy.protocol==='https:'?443:80),method:'CONNECT',path:authority,headers:{host:authority},signal:this.signal,agent:false,rejectUnauthorized:true});
    this.connections.add(connect);
    connect.once('error',()=>done(new AdlError('E_POLICY_DENIED')));
    connect.once('connect',(response,socket,head)=>{
      this.connections.delete(connect);this.tunnels.add(socket);socket.once('close',()=>this.tunnels.delete(socket));
      if(response.statusCode!==200){socket.destroy();done(new AdlError('E_POLICY_DENIED'));return;}
      if(head.length)socket.unshift(head);
      const secure=tls.connect({socket,servername:this.target.hostname.replace(/^\[|\]$/g,''),rejectUnauthorized:true});
      this.tunnels.add(secure);secure.once('close',()=>this.tunnels.delete(secure));
      secure.once('secureConnect',()=>done(null,secure));secure.once('error',()=>done(new AdlError('E_POLICY_DENIED')));
    });
    connect.end();return undefined;
  }
  override destroy():void{for(const request of this.connections)request.destroy();for(const socket of this.tunnels)socket.destroy();this.connections.clear();this.tunnels.clear();super.destroy();}
}

// Pin DNS to the vetted IP while retaining the original host and TLS identity.
// Return redirect responses to the adapter; never follow a Location here.
// The adapter vets and pins every hop instead of fulfilling an HTTP redirect,
// whose follow-up request can bypass Playwright's route interception.
export function pinnedFetch(url: URL, ip: string, method: string, headers: Record<string, string>, signal: AbortSignal, body?: Buffer,proxyServer?:string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    let lib = url.protocol === 'https:' ? https : http;
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (!HOP_RE.test(k)) outHeaders[k] = v;
    outHeaders.host = url.host;
    outHeaders['accept-encoding'] = 'identity';
    const options: https.RequestOptions = {
      hostname: url.hostname.replace(/^\[|\]$/g,''),
      port: url.port !== '' ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
      path: (url.pathname || '/') + (url.search || ''), method, headers: outHeaders, agent: false,
      lookup: (_h, lookupOptions, cb) => {
        const family=ip.includes(':')?6:4;
        if(typeof lookupOptions==='object'&&lookupOptions.all) (cb as unknown as (err:null,addresses:{address:string;family:number}[])=>void)(null,[{address:ip,family}]);
        else (cb as unknown as (err:null,address:string,family:number)=>void)(null,ip,family);
      },
      servername: url.hostname.replace(/^\[|\]$/g,''), rejectUnauthorized: true, signal,
    };
    let tunnel:PinnedTunnelAgent|undefined;
    if(proxyServer){
      let proxy:URL;
      try{proxy=new URL(proxyServer);if(!['http:','https:'].includes(proxy.protocol)||proxy.username||proxy.password||proxy.pathname!=='/'||proxyServer.includes('?')||proxyServer.includes('#'))throw new Error();}catch{reject(new AdlError('E_INVALID_ARGUMENT'));return;}
      if(url.protocol==='https:'){
        tunnel=new PinnedTunnelAgent(proxy,url,ip,signal);options.agent=tunnel;
      }else{
        lib=proxy.protocol==='https:'?https:http;
        options.hostname=proxy.hostname.replace(/^\[|\]$/g,'');options.port=proxy.port||(proxy.protocol==='https:'?443:80);
        options.path='http://'+(ip.includes(':')?'['+ip+']':ip)+':'+(url.port||'80')+(url.pathname||'/')+url.search;
        options.servername=proxy.hostname.replace(/^\[|\]$/g,'');delete options.lookup;
      }
    }
    let settled=false;
    let response: http.IncomingMessage | undefined;
    const finish=(error?:AdlError, result?:FetchResult)=>{
      if(settled)return;
      settled=true; clearTimeout(timer);
      tunnel?.destroy();
      if(error){response?.destroy();req.destroy();reject(error);}else resolve(result!);
    };
    const timer=setTimeout(()=>finish(new AdlError('E_TIMEOUT')),RESPONSE_TIMEOUT_MS);
    const req=lib.request(options,res=>{
      response=res;
      // HEAD and bodyless status responses may still advertise the encoding of
      // the corresponding GET; there is no compressed stream to decode.
      const bodyless=method==='HEAD'||res.statusCode===204||res.statusCode===304;
      const encoding=bodyless?'identity':String(res.headers['content-encoding']??'identity').trim().toLowerCase();
      let decoder: ReturnType<typeof createGunzip> | undefined;
      if(encoding==='gzip')decoder=createGunzip();
      else if(encoding==='deflate')decoder=createInflate();
      else if(encoding==='br')decoder=createBrotliDecompress();
      else if(encoding!==''&&encoding!=='identity')return finish(new AdlError('E_POLICY_DENIED'));
      let compressed=0, expanded=0;
      const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>{compressed+=chunk.length;if(compressed>MAX_BODY)finish(new AdlError('E_RESOURCE_LIMIT'));});
      res.on('error',()=>finish(new AdlError('E_POLICY_DENIED')));
      res.on('aborted',()=>finish(new AdlError('E_POLICY_DENIED')));
      const stream=decoder ? res.pipe(decoder) : res;
      stream.on('data',(chunk:Buffer)=>{expanded+=chunk.length;if(expanded>MAX_BODY)finish(new AdlError('E_RESOURCE_LIMIT'));else chunks.push(chunk);});
      stream.on('error',()=>finish(new AdlError('E_POLICY_DENIED')));
      stream.on('end',()=>finish(undefined,{status:res.statusCode??0,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error',()=>finish(new AdlError('E_POLICY_DENIED')));
    req.end(body);
  });
}
