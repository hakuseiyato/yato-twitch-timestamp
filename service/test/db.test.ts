import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { seedSession } from './helpers';

describe('schema and seed helpers', () => {
  it('migrations create the 7 tables', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
    const names = results.map((row) => row.name);
    for (const table of ['channels', 'members', 'streams', 'stamps', 'api_tokens', 'sessions', 'token_cache']) {
      expect(names).toContain(table);
    }
  });

  it('seedSession returns a yts_ cookie and stores one session row', async () => {
    const cookie = await seedSession('yato');
    expect(cookie).toMatch(/^yts_=[0-9a-f]{64}$/);
    const row = await env.DB.prepare('SELECT login FROM sessions WHERE id = ?').bind(cookie.slice('yts_='.length)).first<{ login: string }>();
    expect(row?.login).toBe('yato');
  });
});
