import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserResourceCache } from '../src/browser-cache.js';
import type { FetchResult } from '../src/browser-network.js';

test('asset cache respects HTTP freshness, origin/IP/headers and explicit public consent', () => {
  const cache = new BrowserResourceCache(),
    url = new URL('https://cdn.test/app.js');
  const key = cache.key(url, '1.1.1.1', 'GET', 'script', {})!;
  const response: FetchResult = {
    status: 200,
    headers: { 'cache-control': 'public, max-age=60' },
    body: Buffer.from('code'),
  };
  cache.put(key, response, 1000);
  assert.equal(cache.get(key, 59999), response);
  assert.equal(cache.get(key, 61000), undefined);
  cache.put(key, response, 1000);
  assert.equal(cache.get(cache.key(url, '1.0.0.1', 'GET', 'script', {}), 2000), undefined);
  assert.equal(
    cache.get(cache.key(new URL('https://other.test/app.js'), '1.1.1.1', 'GET', 'script', {}), 2000),
    undefined,
  );
  assert.equal(cache.get(cache.key(url, '1.1.1.1', 'GET', 'script', { accept: 'other' }), 2000), undefined);
  for (const method of ['POST', 'HEAD']) assert.equal(cache.key(url, '1.1.1.1', method, 'script', {}), undefined);
  assert.equal(cache.key(url, '1.1.1.1', 'GET', 'document', {}), undefined);
  assert.equal(cache.key(url, '1.1.1.1', 'GET', 'script', { Cookie: 'private' }), undefined);
  assert.equal(cache.key(url, '1.1.1.1', 'GET', 'script', { authorization: 'Bearer opaque' }), undefined);
  cache.clear();
  assert.equal(cache.get(key, 2000), undefined);
  for (const headers of [
    { 'cache-control': 'max-age=60' },
    { 'cache-control': 'public, no-store, max-age=60' },
    { 'cache-control': 'public, max-age=60', 'set-cookie': ['id=secret'] },
    { 'cache-control': 'public, max-age=60', vary: 'accept' },
    { 'cache-control': 'public, max-age=60', age: '61' },
  ]) {
    cache.put(key, { ...response, headers }, 1000);
    assert.equal(cache.get(key, 2000), undefined);
  }
});

test('asset cache bounds memory and does not renew a cached response indefinitely', () => {
  const cache = new BrowserResourceCache(),
    response: FetchResult = {
      status: 200,
      headers: { 'cache-control': 'public, max-age=600' },
      body: Buffer.alloc(1024 * 1024),
    };
  for (let i = 0; i < 40; i++) cache.put(String(i), response, 1000);
  assert.equal(cache.get('0', 2000), undefined);
  assert.equal(cache.get('39', 2000), response);
  assert.equal(cache.get('39', 301001), undefined);
  cache.clear();
});
