// CEP パネル（file:// 起点、Origin: null）向けの CORS。Bearer 認証の要求にだけ許可を付け、cookie 経由には付けない
// CORS for the CEP panel (file:// origin, Origin: null). Only Bearer-authenticated requests get it, never cookie ones

const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

// /api/ 配下の OPTIONS なら 204 の preflight 応答、それ以外は null
// A 204 preflight response for OPTIONS under /api/, otherwise null
export function corsPreflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null;
  if (!new URL(request.url).pathname.startsWith('/api/')) return null;
  return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
}

// Authorization ヘッダがある要求の応答にだけ Allow-Origin を足す。既存ヘッダ（Set-Cookie 等）は残す
// Adds Allow-Origin only when the request carries Authorization. Existing headers (Set-Cookie etc.) are kept
export function withCors(request: Request, response: Response): Response {
  if (!request.headers.get('authorization')) return response;
  const wrapped = new Response(response.body, response);
  wrapped.headers.set('Access-Control-Allow-Origin', '*');
  wrapped.headers.append('Vary', 'Origin');
  return wrapped;
}
