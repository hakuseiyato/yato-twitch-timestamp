import { describe, expect, it } from 'vitest';
import { request } from './helpers';

// 共有ページは ID を URL に残したまま静的ページを返す（3xx にしない）
// Shared pages serve the static page while keeping the id in the URL (no 3xx)
describe('shared pages', () => {
  it('GET /s/<id> serves s.html', async () => {
    const res = await request('/s/abc', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Stream page (placeholder)');
  });

  it('GET /s/<id>/comments serves comments.html', async () => {
    const res = await request('/s/abc/comments', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Comments page (placeholder)');
  });
});

// サインインの戻り先とマイページ・管理ページは静的ページを返す（/auth/callback は API の 404 にしない）
// The sign-in return page, my page and admin page are static (/auth/callback must not hit the API 404)
describe('account pages', () => {
  it('GET /auth/callback serves auth/callback.html', async () => {
    const res = await request('/auth/callback', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="callback-status"');
  });

  it('GET /me and /admin serve their pages', async () => {
    expect(await (await request('/me', { redirect: 'manual' })).text()).toContain('src="/js/me.js"');
    expect(await (await request('/admin', { redirect: 'manual' })).text()).toContain('src="/js/admin.js"');
  });

  it('unknown /auth/ paths still answer the API 404', async () => {
    const res = await request('/auth/other');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
