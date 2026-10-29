import { describe, expect, it } from 'vitest';
import { request } from './helpers';

describe('/api/health', () => {
  it('GET /api/health returns ok', async () => {
    const res = await request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('lib.js is importable in the worker (round3)', async () => {
    const res = await request('/api/health?probe=round3');
    expect(((await res.json()) as { round3: number }).round3).toBe(1.235);
  });

  it('unknown /api path is 404 json', async () => {
    const res = await request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
