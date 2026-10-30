import { describe, expect, it } from 'vitest';
import { withCors } from '../src/cors';
import { request, seedSession, seedToken } from './helpers';

// CEP パネル（file:// 起点、Origin: null）から Bearer で /api を呼ぶための CORS
// CORS so the CEP panel (file:// origin, Origin: null) can call /api with a Bearer token
describe('cors', () => {
  it('OPTIONS /api/* is a 204 preflight', async () => {
    const res = await request('/api/stamps', {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });

  it('invalid Bearer still gets the CORS header on 401', async () => {
    const res = await request('/api/me', { headers: { authorization: 'Bearer ytt_x' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('valid ytt_ Bearer gets the CORS header', async () => {
    const token = await seedToken('yato');
    const res = await request('/api/me', { headers: { authorization: 'Bearer ' + token } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('cookie session gets no CORS header', async () => {
    const cookie = await seedSession('yato');
    const res = await request('/api/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('unauthenticated request gets no CORS header', async () => {
    const res = await request('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('OPTIONS outside /api is not a CORS preflight', async () => {
    const res = await request('/', { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('withCors keeps existing headers such as Set-Cookie', async () => {
    const original = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'yts_=abc; Path=/; HttpOnly' },
    });
    const req = new Request('https://example.com/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer ytt_x' } });
    const res = withCors(req, original);
    expect(res.headers.get('set-cookie')).toBe('yts_=abc; Path=/; HttpOnly');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.status).toBe(200);
  });

  it('withCors returns the response untouched without Authorization', () => {
    const original = new Response('x');
    const req = new Request('https://example.com/api/me');
    expect(withCors(req, original)).toBe(original);
  });
});
