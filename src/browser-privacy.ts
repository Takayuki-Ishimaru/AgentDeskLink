import {selectors} from 'playwright';
import {SECRET_LABEL_PATTERN, BROWSER_PRIVACY_RULES} from './privacy.js';

// This engine executes at screenshot mask resolution, in an isolated world.
// It returns live DOM nodes rather than mutable selectors or observed coordinates.
function privacyMaskEngine(){
  const queryAll=(root:Document|Element,source:string):Element[]=>{
    const {pattern:sourcePattern,privacyRules}=JSON.parse(source) as {pattern:string;privacyRules:typeof BROWSER_PRIVACY_RULES};
    const pattern=new RegExp(sourcePattern,'iu');
    const secret=(text:string)=>text.length>=512||pattern.test(text.normalize('NFKC').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Za-z])([0-9])/g,'$1 $2').replace(/([0-9])([A-Za-z])/g,'$1 $2'));
    const doc=root.ownerDocument??root as Document;
    const direct=(element:Element):string=>{
      let text='',visits=0;
      for(let child=element.firstChild;child&&text.length<512&&visits++<64;child=child.nextSibling)if(child.nodeType===3)text+=(child.textContent??'').slice(0,512-text.length);
      return text.trim();
    };
    const inSensitiveRegion=(element:Element):boolean=>{
      let node:Element|null=element,depth=0;
      while(node&&depth++<privacyRules.ancestorCap){if(node.matches(privacyRules.regionSelector))return true;node=node.parentElement;}
      return node!==null;
    };
    const textOf=(element:Element,includeHidden=false):string=>{
      if(inSensitiveRegion(element))return "x".repeat(512);
      let scanned=0, exhausted=false;
      const walker=doc.createTreeWalker(element,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:node=>{if(++scanned>128){exhausted=true;return NodeFilter.FILTER_ACCEPT;}return node.nodeType===1&&(node as Element).matches(privacyRules.textSkipSelector+","+privacyRules.regionSelector)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
      let node=walker.nextNode(),text='',visits=0;
      while(node&&!exhausted&&visits++<128&&text.length<512){
        if(node.nodeType===3&&!node.parentElement?.closest('script,style')&&(includeHidden||!node.parentElement?.closest('[hidden],[aria-hidden="true"]')))text+=(node.textContent??'').slice(0,512-text.length);
        node=walker.nextNode();
      }
      return node?'x'.repeat(512):text.trim();
    };
    const walker=doc.createTreeWalker(root,NodeFilter.SHOW_ELEMENT),out:Element[]=[];
    let node=root.nodeType===1?root as Element:walker.nextNode() as Element|null,visited=0;
    while(node){
      if(++visited>5000)throw new Error('Privacy mask traversal limit');
      const tag=node.tagName.toLowerCase(),role=node.getAttribute('role')??'';
      const hints=['aria-label','placeholder','title','autocomplete','id','name'].map(name=>node!.getAttribute(name)??'');
      const references=node.getAttribute('aria-labelledby')??'';
      if(references.length>4096||hints.some(value=>value.length>4096))throw new Error('Privacy mask field limit');
      if(references.trim().split(/\s+/).length>16)hints.push('x'.repeat(512));
      for(const id of references.trim().split(/\s+/).filter(Boolean).slice(0,16)){
        const label=doc.getElementById(id);if(label)hints.push(textOf(label,true));
      }
      const label=(node as HTMLInputElement).labels?.[0];if(label)hints.push(textOf(label,true));
      hints.push(/^(button|a|p|span|legend|h[1-6]|td|li)$/.test(tag)||/^(button|link|status|alert)$/.test(role)?textOf(node):direct(node));
      if(inSensitiveRegion(node)||hints.some(secret)){
        if(out.length>=1000)throw new Error('Privacy mask output limit');out.push(node);
      }
      node=walker.nextNode() as Element|null;
    }
    return out;
  };
  return {queryAll,query:(root:Document|Element,source:string)=>queryAll(root,source)[0]??null};
}

let registration:Promise<void>|undefined;
export function ensureBrowserPrivacySelectors():Promise<void>{
  return registration??=selectors.register('adlprivacy',privacyMaskEngine,{contentScript:true});
}
export const browserPrivacyMaskSelector=`adlprivacy=${JSON.stringify({pattern:SECRET_LABEL_PATTERN,privacyRules:BROWSER_PRIVACY_RULES})}`;
