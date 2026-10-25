/** One deadline and byte budget cover redirects, headers and the complete body. */
export function isHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

export async function fetchUpdateBytes(url: string, options: {
  maxBytes: number; timeoutMs: number; signal: AbortSignal; fetch?: typeof fetch;
  isAllowedUrl?: (url: string) => boolean;
}): Promise<Buffer> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
    rejectAbort(new Error('更新の取得を中止しました（キャンセルまたはタイムアウト）。'));
  };
  const timer = setTimeout(abort, options.timeoutMs);
  options.signal.addEventListener('abort', abort, { once: true });
  const check = () => { if (controller.signal.aborted) throw new Error('更新の取得を中止しました。'); };
  const work = async (): Promise<Buffer> => {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      check();
      if (!isHttpsUrl(current) || (options.isAllowedUrl && !options.isAllowedUrl(current))) throw new Error('更新先として許可されていない URL です。');
      const response = await (options.fetch ?? fetch)(current, {
        redirect: 'manual', signal: controller.signal, credentials: 'omit'
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        check();
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('更新先のリダイレクトを解決できませんでした。');
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`更新先が HTTP ${response.status} を返しました。`);
      }
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > options.maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error('更新ファイルがサイズ上限を超えています。');
      }
      if (!response.body) return Buffer.alloc(0);
      reader = response.body.getReader();
      let size = 0;
      const chunks: Buffer[] = [];
      for (;;) {
        check();
        const part = await reader.read();
        check();
        if (part.done) return Buffer.concat(chunks, size);
        size += part.value.byteLength;
        if (size > options.maxBytes) throw new Error('更新ファイルがサイズ上限を超えています。');
        chunks.push(Buffer.from(part.value));
      }
    }
    throw new Error('更新先のリダイレクトが多すぎます。');
  };
  try {
    if (options.signal.aborted) abort();
    return await Promise.race([work(), aborted]);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
