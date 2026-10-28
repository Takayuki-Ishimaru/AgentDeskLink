import {selectors} from 'playwright';
import {BROWSER_PRIVACY_RULES} from './privacy.js';

// This engine lives in Playwright's isolated content-script world. Page
// prototypes cannot alter the captured node identities, geometry or privacy walk.
function pointEngine(){
  let current:{nonce:string;viewport:string;nodes:Map<Element,{x:number;y:number;width:number;height:number}>}|undefined;
  const viewport=()=>JSON.stringify([innerWidth,innerHeight,scrollX,scrollY,devicePixelRatio]);
  const box=(e:Element)=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const same=(a:ReturnType<typeof box>,b:ReturnType<typeof box>)=>a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height;
  const queryAll=(root:Document|Element,source:string):Element[]=>{
    const a=JSON.parse(source) as {op:'capture'|'validate'|'point';nonce:string;x?:number;y?:number;rules:typeof BROWSER_PRIVACY_RULES};
    const doc=root.ownerDocument??root as Document;
    if(a.op==='capture'){
      current=undefined;const nodes=new Map<Element,ReturnType<typeof box>>(),pending:Element[]=[doc.documentElement];let visited=0;
      while(pending.length){
        const e=pending.pop()!;if(++visited>20000||nodes.size>=5000)return [];
        const r=box(e);if(r.width>0&&r.height>0&&r.x<innerWidth&&r.y<innerHeight&&r.x+r.width>0&&r.y+r.height>0&&e.checkVisibility({visibilityProperty:true}))nodes.set(e,r);
        pending.push(...Array.from(e.children));if(e.shadowRoot)pending.push(...Array.from(e.shadowRoot.children));
      }
      current={nonce:a.nonce,viewport:viewport(),nodes};return [doc.documentElement];
    }
    if(!current||current.nonce!==a.nonce||current.viewport!==viewport())return [];
    if(a.op==='validate'){
      for(const [node,rect]of current.nodes)if(!node.isConnected||!same(rect,box(node)))return [];
      return [doc.documentElement];
    }
    if(!Number.isFinite(a.x)||!Number.isFinite(a.y)||a.x!<0||a.y!<0||a.x!>=innerWidth||a.y!>=innerHeight)return [];
    let e=doc.elementFromPoint(a.x!,a.y!);let depth=0;
    while(e?.shadowRoot&&depth++<32){const inside=e.shadowRoot.elementFromPoint(a.x!,a.y!);if(!inside||inside===e)break;e=inside;}
    if(!e||/^(iframe|frame)$/i.test(e.tagName))return [];
    const captured=current.nodes.get(e);if(!captured||!same(captured,box(e)))return [];
    let ancestor:Element|null=e,target:Element|undefined;depth=0;
    while(ancestor&&depth++<a.rules.ancestorCap){if(ancestor.matches(a.rules.regionSelector)||ancestor.getAttribute('aria-disabled')==='true'||ancestor.matches(':disabled'))return [];if(!target&&ancestor.matches('a[href],button,input,select,textarea,[role="button"],[role="link"],[onclick]'))target=ancestor;ancestor=ancestor.parentElement??(ancestor.getRootNode() as ShadowRoot).host??null;}
    if(ancestor)return [];
    target??=e;const targetBox=current.nodes.get(target);if(!targetBox||!same(targetBox,box(target)))return [];
    return [target];
  };
  return {queryAll,query:(root:Document|Element,source:string)=>queryAll(root,source)[0]??null};
}
let registration:Promise<void>|undefined;
export function ensurePointSelector(){return registration??=selectors.register('adlpoint',pointEngine,{contentScript:true});}
export function pointSelector(op:'capture'|'validate'|'point',nonce:string,x?:number,y?:number){return 'adlpoint='+JSON.stringify({op,nonce,x,y,rules:BROWSER_PRIVACY_RULES});}
