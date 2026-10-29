import { randomBytes } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import { AdlError } from './types.js';

export interface BrowserIntegrity {
  check: () => boolean;
  value: (node: Element) => string;
  checked: (node: Element) => boolean;
}

// Installed before website scripts. Every reference used by the checker is
// captured here; checking never calls a page's accessor, iterator or toString.
function installIntegrity({ key, registrationSecret }: { key: string; registrationSecret: string }) {
  const apply = Reflect.apply,
    keys = Reflect.ownKeys,
    descriptor = Object.getOwnPropertyDescriptor,
    prototype = Object.getPrototypeOf,
    is = Object.is;
  const define = Object.defineProperty,
    freeze = Object.freeze,
    push = Array.prototype.push,
    includes = Array.prototype.includes;
  const mapGet = Map.prototype.get,
    mapSet = Map.prototype.set,
    setHas = Set.prototype.has,
    setAdd = Set.prototype.add;
  const records = new Map<
    object,
    {
      object: object;
      parent: object | null;
      keys: PropertyKey[];
      descriptors: PropertyDescriptor[];
      names: Set<PropertyKey>;
    }
  >();
  const ordered: {
    object: object;
    parent: object | null;
    keys: PropertyKey[];
    descriptors: PropertyDescriptor[];
    names: Set<PropertyKey>;
  }[] = [];
  const globalDescriptors: { name: string; descriptor: PropertyDescriptor }[] = [];
  const call = (fn: Function, receiver: unknown, args: unknown[]) => apply(fn, receiver, args);
  const getRecord = (object: object) => call(mapGet, records, [object]) as (typeof ordered)[number] | undefined;
  const addRecord = (object: object | null) => {
    if (!object || getRecord(object)) return;
    const own = keys(object),
      descriptors: PropertyDescriptor[] = [];
    for (let i = 0; i < own.length; i++) call(push, descriptors, [descriptor(object, own[i]!)!]);
    const row = { object, parent: prototype(object), keys: own, descriptors, names: new Set<PropertyKey>() };
    call(mapSet, records, [object, row]);
    call(push, ordered, [row]);
  };
  // Validate Object.prototype first, before reading descriptor fields that can
  // be absent (and would otherwise consult a hostile Object.prototype).
  addRecord(Object.prototype);
  const globals = [
    'window',
    'globalThis',
    'document',
    'Object',
    'Reflect',
    'Array',
    'Map',
    'WeakMap',
    'Set',
    'WeakSet',
    'String',
    'Number',
    'Boolean',
    'RegExp',
    'JSON',
    'Math',
    'Function',
    'Error',
    'TypeError',
    'URL',
    'URLSearchParams',
    'NodeFilter',
    'getComputedStyle',
  ];
  const windowNames = keys(window);
  for (let i = 0; i < windowNames.length; i++) {
    const name = windowNames[i];
    if (typeof name !== 'string') continue;
    if (
      /^(?:HTML|SVG|MathML).*Element$/.test(name) ||
      [
        'Node',
        'Element',
        'Attr',
        'Text',
        'Comment',
        'Document',
        'HTMLDocument',
        'DocumentType',
        'DocumentFragment',
        'ProcessingInstruction',
        'CDATASection',
        'ShadowRoot',
        'EventTarget',
        'TreeWalker',
        'NodeIterator',
        'NodeList',
        'RadioNodeList',
        'NamedNodeMap',
        'HTMLCollection',
        'HTMLAllCollection',
        'HTMLFormControlsCollection',
        'HTMLOptionsCollection',
        'DOMTokenList',
        'DOMRect',
        'DOMRectReadOnly',
        'DOMRectList',
        'CSSStyleDeclaration',
      ].includes(name)
    )
      globals.push(name);
  }
  for (let i = 0; i < globals.length; i++) {
    const name = globals[i]!,
      desc = descriptor(window, name);
    if (!desc) continue;
    globalDescriptors.push({ name, descriptor: desc });
    const value = desc.value;
    if (
      ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
      value !== window &&
      value !== document
    ) {
      addRecord(value);
      const proto = descriptor(value, 'prototype')?.value;
      for (let current = proto; current; current = prototype(current)) addRecord(current);
    }
  }
  // Build per-interface reserved names, so a collection's ordinary named
  // entries (for example a form field named "value") remain supported.
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]!;
    let elementInterface = false;
    for (let current: object | null = row.object; current; current = prototype(current)) {
      if (current === Element.prototype) elementInterface = true;
      const currentKeys = keys(current);
      for (let j = 0; j < currentKeys.length; j++) call(setAdd, row.names, [currentKeys[j]!]);
    }
    // Snapshot/preflight read these optional control fields on generic targets.
    // A custom-element getter must not turn those reads into page execution.
    if (elementInterface) {
      const controlNames = [
        'type',
        'readOnly',
        'disabled',
        'labels',
        'placeholder',
        'form',
        'formAction',
        'formMethod',
        'formEnctype',
        'formTarget',
        'value',
        'checked',
        'then',
        'toJSON',
      ];
      for (let j = 0; j < controlNames.length; j++) call(setAdd, row.names, [controlNames[j]!]);
      call(setAdd, row.names, [Symbol.toPrimitive]);
    }
  }
  const nativeGetter = (owner: object, name: string) => descriptor(owner, name)!.get!;
  const nodeType = nativeGetter(Node.prototype, 'nodeType'),
    shadowRoot = nativeGetter(Element.prototype, 'shadowRoot');
  const attributes = nativeGetter(Element.prototype, 'attributes'),
    children = nativeGetter(Element.prototype, 'children'),
    childNodes = nativeGetter(Node.prototype, 'childNodes');
  const tagName = nativeGetter(Element.prototype, 'tagName'),
    createWalker = Document.prototype.createTreeWalker,
    nextNode = TreeWalker.prototype.nextNode;
  const attrLength = nativeGetter(NamedNodeMap.prototype, 'length'),
    attrItem = NamedNodeMap.prototype.item;
  const collections: Record<string, Function[]> = {
    INPUT: [nativeGetter(HTMLInputElement.prototype, 'labels')],
    TEXTAREA: [nativeGetter(HTMLTextAreaElement.prototype, 'labels')],
    BUTTON: [nativeGetter(HTMLButtonElement.prototype, 'labels')],
    SELECT: [
      nativeGetter(HTMLSelectElement.prototype, 'labels'),
      nativeGetter(HTMLSelectElement.prototype, 'options'),
      nativeGetter(HTMLSelectElement.prototype, 'selectedOptions'),
    ],
    OUTPUT: [nativeGetter(HTMLOutputElement.prototype, 'labels')],
    FORM: [nativeGetter(HTMLFormElement.prototype, 'elements')],
  };
  const valueGetters: Record<string, Function> = {
    INPUT: nativeGetter(HTMLInputElement.prototype, 'value'),
    TEXTAREA: nativeGetter(HTMLTextAreaElement.prototype, 'value'),
    SELECT: nativeGetter(HTMLSelectElement.prototype, 'value'),
    BUTTON: nativeGetter(HTMLButtonElement.prototype, 'value'),
    OPTION: nativeGetter(HTMLOptionElement.prototype, 'value'),
    OUTPUT: nativeGetter(HTMLOutputElement.prototype, 'value'),
  };
  const checkedGetter = nativeGetter(HTMLInputElement.prototype, 'checked');
  const inputPrototype = HTMLInputElement.prototype,
    textareaPrototype = HTMLTextAreaElement.prototype;
  const formPrototype = HTMLFormElement.prototype,
    collectionPrototype = HTMLCollection.prototype,
    radioListPrototype = RadioNodeList.prototype;
  const collectionItem = HTMLCollection.prototype.item,
    collectionLength = nativeGetter(HTMLCollection.prototype, 'length'),
    listItem = NodeList.prototype.item,
    listLength = nativeGetter(NodeList.prototype, 'length');
  const ownerDocument = nativeGetter(Node.prototype, 'ownerDocument'),
    isConnected = nativeGetter(Node.prototype, 'isConnected'),
    contains = Node.prototype.contains,
    getAttribute = Element.prototype.getAttribute;
  const elementsByName = Document.prototype.getElementsByName,
    contentWindow = nativeGetter(HTMLIFrameElement.prototype, 'contentWindow'),
    documentNamedTags = ['EMBED', 'FORM', 'IFRAME', 'IMG', 'OBJECT'];
  const formOwners: Record<string, Function> = {
    INPUT: nativeGetter(HTMLInputElement.prototype, 'form'),
    BUTTON: nativeGetter(HTMLButtonElement.prototype, 'form'),
    SELECT: nativeGetter(HTMLSelectElement.prototype, 'form'),
    TEXTAREA: nativeGetter(HTMLTextAreaElement.prototype, 'form'),
    FIELDSET: nativeGetter(HTMLFieldSetElement.prototype, 'form'),
    OUTPUT: nativeGetter(HTMLOutputElement.prototype, 'form'),
    OBJECT: nativeGetter(HTMLObjectElement.prototype, 'form'),
  };
  const initialDocumentOwn = keys(document),
    documentDescriptors = new Map<PropertyKey, PropertyDescriptor>();
  for (let i = 0; i < initialDocumentOwn.length; i++)
    call(mapSet, documentDescriptors, [initialDocumentOwn[i]!, descriptor(document, initialDocumentOwn[i]!)!]);
  const sameDescriptor = (actual: PropertyDescriptor | undefined, expected: PropertyDescriptor) =>
    !!actual &&
    is(actual.value, expected.value) &&
    actual.get === expected.get &&
    actual.set === expected.set &&
    actual.writable === expected.writable &&
    actual.configurable === expected.configurable &&
    actual.enumerable === expected.enumerable;
  const sameUnusedTouchHandler = (
    name: PropertyKey,
    actual: PropertyDescriptor | undefined,
    expected: PropertyDescriptor,
  ) => {
    // Chromium replaces these native accessor identities when touch emulation
    // finishes initializing after init scripts. None is read by observation,
    // privacy checks or preflight. Preserve descriptor shape/key checks without
    // mistaking that browser-owned transition for a forged DOM read API.
    if (name !== 'ontouchcancel' && name !== 'ontouchstart' && name !== 'ontouchmove' && name !== 'ontouchend')
      return false;
    return (
      !!actual &&
      typeof expected.get === 'function' &&
      typeof expected.set === 'function' &&
      typeof actual.get === 'function' &&
      typeof actual.set === 'function' &&
      actual.value === expected.value &&
      actual.writable === expected.writable &&
      actual.configurable === expected.configurable &&
      actual.enumerable === expected.enumerable
    );
  };
  const sameRecord = (row: (typeof ordered)[number]) => {
    if (prototype(row.object) !== row.parent) return false;
    const actualKeys = keys(row.object);
    if (actualKeys.length !== row.keys.length) return false;
    for (let i = 0; i < actualKeys.length; i++) if (actualKeys[i] !== row.keys[i]) return false;
    for (let i = 0; i < actualKeys.length; i++) {
      const name = actualKeys[i]!,
        actual = descriptor(row.object, name),
        expected = row.descriptors[i]!;
      if (!sameDescriptor(actual, expected) && !sameUnusedTouchHandler(name, actual, expected)) return false;
    }
    return true;
  };
  let pendingPrototype: object | null = null,
    registrations = 0;
  // Chromium lists markup-defined named properties as own keys: an element
  // named "item" appears on its parent's children collection, and exposed
  // document/form names (img name="title", input name="action") shadow the
  // API itself ([LegacyOverrideBuiltIns]). A genuine named property is a data
  // property whose value is the browser's own element, collection or frame
  // window for that name. Only trap-free reflection and captured native
  // receivers (which reject Proxies and foreign objects by throwing) touch it.
  const elementNamed = (value: unknown, name: PropertyKey, tags: string[] | null) => {
    let kind: unknown;
    try {
      kind = call(nodeType, value, []);
    } catch {
      return false;
    }
    if (kind !== 1 || call(ownerDocument, value, []) !== document || call(isConnected, value, []) !== true)
      return false;
    const tag = call(tagName, value, []) as string,
      attrName = call(getAttribute, value, ['name']),
      attrId = call(getAttribute, value, ['id']);
    if (!tags) return attrName === name || attrId === name;
    if (!call(includes, tags, [tag])) return false;
    return (
      attrName === name || (tag === 'OBJECT' && attrId === name) || (tag === 'IMG' && attrId === name && !!attrName)
    );
  };
  const genuineNamed = (
    object: object,
    proto: object | null,
    name: PropertyKey,
    desc: PropertyDescriptor | undefined,
  ): boolean => {
    // Collections without [LegacyOverrideBuiltIns]: a reserved name hidden by
    // the prototype is listed without any own descriptor, which no ordinary
    // property can produce. A present descriptor is a page-defined property.
    if (!desc) return true;
    if (typeof name !== 'string' || desc.get !== undefined || desc.set !== undefined) return false;
    const value = desc.value;
    if (typeof value !== 'object' || value === null) return false;
    if (object === document) {
      const frames = call(elementsByName, document, [name]) as NodeList,
        count = call(listLength, frames, []) as number;
      for (let i = 0; i < count && i < 64; i++) {
        const frame = call(listItem, frames, [i]) as Element;
        if (call(tagName, frame, []) === 'IFRAME' && call(contentWindow, frame, []) === value) return true;
      }
      if (elementNamed(value, name, documentNamedTags)) return true;
      let length: unknown;
      try {
        length = call(collectionLength, value, []);
      } catch {
        return false;
      }
      if (
        prototype(value) !== collectionPrototype ||
        typeof length !== 'number' ||
        length < 2 ||
        length > 256 ||
        !safeInstance(value)
      )
        return false;
      for (let i = 0; i < length; i++)
        if (!elementNamed(call(collectionItem, value, [i]), name, documentNamedTags)) return false;
      return true;
    }
    if (proto === formPrototype) {
      const owned = (item: unknown) => {
        if (!elementNamed(item, name, null)) return false;
        const owner = formOwners[call(tagName, item, []) as string];
        return call(contains, object, [item]) === true || (!!owner && call(owner, item, []) === object);
      };
      if (owned(value)) return true;
      let length: unknown;
      try {
        length = call(listLength, value, []);
      } catch {
        return false;
      }
      if (
        prototype(value) !== radioListPrototype ||
        typeof length !== 'number' ||
        length < 2 ||
        length > 256 ||
        !safeInstance(value)
      )
        return false;
      for (let i = 0; i < length; i++) if (!owned(call(listItem, value, [i]))) return false;
      return true;
    }
    return false;
  };
  const safeInstance = (object: object): boolean => {
    // Unknown prototypes could be Proxies whose reflection traps run arbitrary
    // code. Never introspect one; custom prototype chains fail closed.
    const proto = prototype(object),
      row = proto && getRecord(proto);
    if (!row) {
      pendingPrototype = proto;
      return false;
    }
    const own = keys(object);
    for (let i = 0; i < own.length; i++) {
      const name = own[i]!;
      if (!call(setHas, row.names, [name])) continue;
      // React value tracking adds these own wrappers. Observation uses captured
      // native getters below, so their code is never invoked by the observer.
      if (
        (name === 'value' && (proto === inputPrototype || proto === textareaPrototype)) ||
        (name === 'checked' && proto === inputPrototype)
      )
        continue;
      const original =
          object === document
            ? (call(mapGet, documentDescriptors, [name]) as PropertyDescriptor | undefined)
            : undefined,
        actual = descriptor(object, name);
      if (original ? !sameDescriptor(actual, original) : !genuineNamed(object, proto, name, actual)) return false;
    }
    return true;
  };
  const check = () => {
    pendingPrototype = null;
    try {
      for (let i = 0; i < ordered.length; i++) if (!sameRecord(ordered[i]!)) return false;
      for (let i = 0; i < globalDescriptors.length; i++) {
        const entry = globalDescriptors[i]!;
        if (!sameDescriptor(descriptor(window, entry.name), entry.descriptor)) return false;
      }
      const roots: Node[] = [document];
      let visited = 0;
      for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
        const root = roots[rootIndex]!,
          walker = call(createWalker, document, [root, 0xffffffff]) as TreeWalker;
        let node: Node | null = root;
        while (node) {
          if (++visited > 100000 || !safeInstance(node)) return false;
          const list = call(childNodes, node, []) as NodeList;
          if (!safeInstance(list)) return false;
          if (call(nodeType, node, []) === 1) {
            const attrs = call(attributes, node, []) as NamedNodeMap;
            if (!safeInstance(attrs) || !safeInstance(call(children, node, []) as HTMLCollection)) return false;
            const count = call(attrLength, attrs, []) as number;
            for (let i = 0; i < count; i++) if (!safeInstance(call(attrItem, attrs, [i]) as Attr)) return false;
            const getters = collections[call(tagName, node, []) as string];
            if (getters)
              for (let i = 0; i < getters.length; i++) {
                const collection = call(getters[i]!, node, []) as object | null;
                if (collection && !safeInstance(collection)) return false;
              }
            const shadow = call(shadowRoot, node, []) as ShadowRoot | null;
            if (shadow) call(push, roots, [shadow]);
          }
          node = call(nextNode, walker, []) as Node | null;
        }
      }
      return true;
    } catch {
      return false;
    }
  };
  const value = (node: Element): string => {
    const name = call(tagName, node, []) as string;
    const getter = valueGetters[name];
    return getter ? (call(getter, node, []) as string) : '';
  };
  const checked = (node: Element): boolean =>
    call(tagName, node, []) === 'INPUT' ? (call(checkedGetter, node, []) as boolean) : false;
  const acceptPrototype = (secret: string, object: object) => {
    // The secret lives only in this closure and the host. Function.toString()
    // reveals the identifier, never its value. No page-only call grants trust.
    if (secret !== registrationSecret || registrations >= 64) return false;
    for (let i = 0; i < ordered.length; i++) if (!sameRecord(ordered[i]!)) return false;
    for (let i = 0; i < globalDescriptors.length; i++) {
      const entry = globalDescriptors[i]!;
      if (!sameDescriptor(descriptor(window, entry.name), entry.descriptor)) return false;
    }
    if (getRecord(object)) return true;
    const parent = prototype(object),
      parentRow = parent && getRecord(parent);
    if (!parentRow) return false;
    // The host already proved this exact remote object is not a Proxy. These
    // reflection calls cannot run traps or invoke accessor values.
    const own = keys(object);
    for (let i = 0; i < own.length; i++) {
      const name = own[i]!,
        desc = descriptor(object, name)!;
      if (name === 'constructor') {
        if (!('value' in desc) || typeof desc.value !== 'function') return false;
        continue;
      }
      if (call(setHas, parentRow.names, [name])) return false;
    }
    addRecord(object);
    const row = getRecord(object)!;
    // Inherited application methods may be overridden (for example render()).
    // Only the native/control API set remains reserved for future subclasses.
    row.names = parentRow.names;
    registrations++;
    return true;
  };
  define(window, key, {
    value: freeze({
      check,
      value,
      checked,
      pendingPrototype: () => pendingPrototype,
      knownPrototype: (object: object) => !!getRecord(object),
      acceptPrototype,
    }),
    configurable: false,
    writable: false,
    enumerable: false,
  });
}

export interface IntegrityInstallation {
  key: string;
  registrationSecret: string;
}
export async function installBrowserIntegrity(context: BrowserContext): Promise<IntegrityInstallation> {
  const installation = {
    key: '__adl_integrity_' + randomBytes(18).toString('hex'),
    registrationSecret: randomBytes(32).toString('hex'),
  };
  await context.addInitScript(installIntegrity, installation);
  return installation;
}

/** CDP identifies Proxies without executing traps; only then may the private
 * checker baseline a custom prototype which does not override native APIs. */
export async function registerBrowserPrototypes(
  page: Page,
  installation: IntegrityInstallation,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new AdlError('E_CANCELLED');
  const cdp = await page.context().newCDPSession(page),
    contexts = new Set<number>(),
    group = 'adl-integrity-' + randomBytes(12).toString('hex');
  cdp.on('Runtime.executionContextCreated', event => {
    if ((event.context.auxData as unknown as { isDefault?: boolean } | undefined)?.isDefault === true)
      contexts.add(event.context.id);
  });
  const deadline = Date.now() + 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => {
      void cdp.detach().catch(() => undefined);
      reject(new AdlError('E_CANCELLED'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      void cdp.detach().catch(() => undefined);
      reject(new AdlError('E_TIMEOUT'));
    }, 2000);
  });
  const check = () => {
    if (signal?.aborted) throw new AdlError('E_CANCELLED');
    if (contexts.size > 33) throw new AdlError('E_RESOURCE_LIMIT');
    if (Date.now() >= deadline) throw new AdlError('E_TIMEOUT');
  };
  const key = JSON.stringify(installation.key);
  try {
    await Promise.race([
      (async () => {
        await cdp.send('Runtime.enable');
        check();
        if (contexts.size > 33) throw new AdlError('E_RESOURCE_LIMIT');
        for (const contextId of contexts) {
          let attempts = 0;
          while (true) {
            check();
            const result = await cdp.send('Runtime.evaluate', {
              contextId,
              expression: `window[${key}] ? window[${key}].check() : null`,
              returnByValue: true,
            });
            if (result.exceptionDetails) throw new AdlError('E_PRIVACY_BLOCKED');
            if (result.result.value === true || result.result.value === null) break;
            if (++attempts > 64) throw new AdlError('E_RESOURCE_LIMIT');
            const pending = await cdp.send('Runtime.evaluate', {
              contextId,
              expression: `window[${key}].pendingPrototype()`,
              objectGroup: group,
            });
            if (pending.exceptionDetails) throw new AdlError('E_PRIVACY_BLOCKED');
            type Remote = typeof pending.result;
            let examined = 0;
            const register = async (remote: Remote, depth = 0): Promise<void> => {
              check();
              if (depth >= 64 || ++examined > 64) throw new AdlError('E_RESOURCE_LIMIT');
              if (remote.type !== 'object' || remote.subtype === 'proxy' || !remote.objectId)
                throw new AdlError('E_PRIVACY_BLOCKED');
              const known = await cdp.send('Runtime.callFunctionOn', {
                objectId: remote.objectId,
                functionDeclaration: 'function(key){return window[key].knownPrototype(this);}',
                arguments: [{ value: installation.key }],
                returnByValue: true,
              });
              if (known.exceptionDetails) throw new AdlError('E_PRIVACY_BLOCKED');
              if (known.result.value === true) return;
              const properties = await cdp.send('Runtime.getProperties', {
                objectId: remote.objectId,
                ownProperties: true,
                generatePreview: false,
              });
              if (properties.exceptionDetails) throw new AdlError('E_PRIVACY_BLOCKED');
              const parent = properties.internalProperties?.find(property => property.name === '[[Prototype]]')?.value;
              if (!parent) throw new AdlError('E_PRIVACY_BLOCKED');
              await register(parent, depth + 1);
              check();
              const accepted = await cdp.send('Runtime.callFunctionOn', {
                objectId: remote.objectId,
                functionDeclaration: 'function(key,secret){return window[key].acceptPrototype(secret,this);}',
                arguments: [{ value: installation.key }, { value: installation.registrationSecret }],
                returnByValue: true,
              });
              if (accepted.exceptionDetails || accepted.result.value !== true) throw new AdlError('E_PRIVACY_BLOCKED');
            };
            await register(pending.result);
          }
        }
      })(),
      stopped,
    ]);
  } catch (error) {
    if (error instanceof AdlError) throw error;
    throw new AdlError('E_PRIVACY_BLOCKED');
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}
