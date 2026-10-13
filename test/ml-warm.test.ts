import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/app';
import { resetWarmThrottle, warmOnAppOpen, warmSearch } from '../src/ml/warm';

/** A search-container namespace stand-in that records the instance name and path of every request. */
function fakeSearch() {
  const calls: Array<{ name: string; path: string; method: string }> = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ name: id.name, path: new URL(url).pathname, method: init?.method ?? 'GET' });
        return new Response(null, { status: 202 });
      },
    }),
  };
  return { calls, env: { ...env, ML_SEARCH: ns } as unknown as Env };
}

afterEach(() => resetWarmThrottle());

describe('warmSearch', () => {
  it('posts /warm to the "search" instance at most once a minute per isolate', async () => {
    const fake = fakeSearch();
    const t = 1_000_000;
    expect(await warmSearch(fake.env, t)).toBe(true);
    expect(await warmSearch(fake.env, t + 59_000)).toBe(false);
    expect(await warmSearch(fake.env, t + 61_000)).toBe(true);
    expect(fake.calls).toEqual([
      { name: 'search', path: '/warm', method: 'POST' },
      { name: 'search', path: '/warm', method: 'POST' },
    ]);
  });

  it('does nothing without the search container and survives a failing one', async () => {
    expect(await warmSearch({ ...env, ML_SEARCH: undefined } as unknown as Env)).toBe(false);
    const failing = { idFromName: () => ({}), get: () => ({ fetch: async () => Promise.reject(new Error('down')) }) };
    expect(await warmSearch({ ...env, ML_SEARCH: failing } as unknown as Env)).toBe(true);
  });
});

describe('warmOnAppOpen', () => {
  async function request(path: string, status: number, testEnv: Env, method = 'GET') {
    const app = new Hono<AppEnv>();
    app.use('*', warmOnAppOpen);
    app.all('*', (c) => c.body(null, status as 200));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    await app.request(path, { method }, testEnv, ctx);
    await Promise.all(waits);
  }

  it('warms after a successful GET of an app-open endpoint only', async () => {
    const fake = fakeSearch();
    await request('/api/users/me', 401, fake.env); // not logged in
    await request('/api/server/features', 200, fake.env); // unauthenticated endpoint
    await request('/api/people', 200, fake.env, 'POST');
    expect(fake.calls).toHaveLength(0);
    await request('/api/users/me', 200, fake.env);
    expect(fake.calls).toEqual([{ name: 'search', path: '/warm', method: 'POST' }]);
    resetWarmThrottle();
    await request('/api/search/explore', 200, fake.env);
    expect(fake.calls).toHaveLength(2);
  });
});
