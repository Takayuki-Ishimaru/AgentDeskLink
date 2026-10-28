import {selectors} from 'playwright';
import {SECRET_LABEL_PATTERN, BROWSER_PRIVACY_RULES,TEXT_REDACTION_RULES} from './privacy.js';

// This engine executes at screenshot mask resolution, in an isolated world.
// It returns live DOM nodes rather than mutable selectors or observed coordinates.
function privacyMaskEngine(){
  const queryAll=(root:Document|Element,source:string):Element[]=>{
    const {pattern:sourcePattern,privacyRules,valuePatterns}=JSON.parse(source) as {pattern:string;privacyRules:typeof BROWSER_PRIVACY_RULES;valuePatterns:string[]};
    const pattern=new RegExp(sourcePattern,'iu');
    const valueRules=valuePatterns.map(source=>new RegExp(source,'i'));
    const secret=(text:string)=>pattern.test(text.normalize('NFKC').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Za-z])([0-9])/g,'$1 $2').replace(/([0-9])([A-Za-z])/g,'$1 $2'));
    const secretValue=(value:string)=>value.length>4096||valueRules.some(rule=>rule.test(value));
    const doc=root.ownerDocument??root as Document;
    const direct=(element:Element):string=>{
      let text='',visits=0;
      for(let child=element.firstChild;child;child=child.nextSibling){
        if(visits++>=64)return 'password';
        if(child.nodeType===3){const part=child.textContent??'';if(part.length>4096-text.length)return 'password';text+=part;}
      }
      return text.trim();
    };
    const inSensitiveRegion=(element:Element):boolean=>{
      let node:Element|null=element,depth=0;
      while(node&&depth++<privacyRules.ancestorCap){if(node.matches(privacyRules.regionSelector))return true;node=node.parentElement??(node.getRootNode() as ShadowRoot).host??null;}
      return node!==null;
    };
    const textOf=(element:Element,includeHidden=false):string=>{
      if(inSensitiveRegion(element))return 'password';
      let scanned=0, exhausted=false;
      const walker=doc.createTreeWalker(element,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:node=>{if(++scanned>128){exhausted=true;return NodeFilter.FILTER_ACCEPT;}return node.nodeType===1&&(node as Element).matches(privacyRules.textSkipSelector+","+privacyRules.regionSelector)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
      let node=walker.nextNode(),text='',visits=0;
      while(node&&!exhausted&&visits++<128&&text.length<4096){
        if(node.nodeType===3&&!node.parentElement?.closest('script,style')&&(includeHidden||!node.parentElement?.closest('[hidden],[aria-hidden="true"]'))){
          const part=node.textContent??'';
          if(part.length>4095-text.length)exhausted=true;
          text+=' '+part.slice(0,4095-text.length);
        }
        node=walker.nextNode();
      }
      return node||exhausted||text.length>4096?'password':text.trim();
    };
    const roots:(Document|Element|ShadowRoot)[]=[root],out:Element[]=[];let visited=0;
    while(roots.length){
     const current=roots.pop()!,walker=doc.createTreeWalker(current,NodeFilter.SHOW_ELEMENT);
     let node=current.nodeType===1?current as Element:walker.nextNode() as Element|null;
     while(node){
      if(++visited>5000)throw new Error('Privacy mask traversal limit');
      if(node.shadowRoot)roots.push(node.shadowRoot);
      const tag=node.tagName.toLowerCase(),role=node.getAttribute('role')??'';
      const hints=['aria-label','placeholder','title','autocomplete','id','name'].map(name=>node!.getAttribute(name)??'');
      const references=node.getAttribute('aria-labelledby')??'';
      if(references.length>4096||hints.some(value=>value.length>4096))throw new Error('Privacy mask field limit');
      if(references.trim().split(/\s+/).length>16)hints.push('password');
      for(const id of references.trim().split(/\s+/).filter(Boolean).slice(0,16)){
        const label=(node.getRootNode() as Document|ShadowRoot).getElementById(id);if(label)hints.push(textOf(label,true));
      }
      const labels=(node as HTMLInputElement).labels;
      if(labels){if(labels.length>16)hints.push('password');else for(const label of Array.from(labels))hints.push(textOf(label,true));}
      hints.push(/^(button|a|p|span|legend|h[1-6]|td|li)$/.test(tag)||/^(button|link|status|alert)$/.test(role)?textOf(node):direct(node));
      const control=/^(input|textarea|select)$/.test(tag)||node.hasAttribute('contenteditable');
      const value=control?(tag==='input'||tag==='textarea'||tag==='select'?(node as HTMLInputElement).value:node.textContent??''):'';
      const selected=tag==='select'?Array.from((node as HTMLSelectElement).selectedOptions).some(option=>secret(option.text)||secretValue(option.value)):false;
      // Labels themselves remain visible; their associated control still
      // receives all label hints, including hidden and nested labels.
      const labelText=!control&&!!node.closest('label')&&!secretValue(node.textContent??'');
      if(inSensitiveRegion(node)||(!labelText&&hints.some(secret))||control&&(secretValue(value)||selected)){
        if(out.length>=1000)throw new Error('Privacy mask output limit');out.push(node);
      }
      node=walker.nextNode() as Element|null;
     }
    }
    return out;
  };
  return {queryAll,query:(root:Document|Element,source:string)=>queryAll(root,source)[0]??null};
}

let registration:Promise<void>|undefined;
export function ensureBrowserPrivacySelectors():Promise<void>{
  return registration??=selectors.register('adlprivacy',privacyMaskEngine,{contentScript:true});
}
export const browserPrivacyMaskSelector=`adlprivacy=${JSON.stringify({pattern:SECRET_LABEL_PATTERN,privacyRules:BROWSER_PRIVACY_RULES,valuePatterns:TEXT_REDACTION_RULES.map(([source])=>source)})}`;
