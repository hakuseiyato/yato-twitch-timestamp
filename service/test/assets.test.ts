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
