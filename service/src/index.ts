// Worker の入口。/api と /auth は router、それ以外は静的ページ
// Worker entry point. /api and /auth go to the router, everything else to static pages
import TSLib from '../../panel/js/lib.js';
import { registerAuthRoutes, TwitchUnavailable } from './auth';
import { registerChatRoutes } from './chat';
import { corsPreflight, withCors } from './cors';
import { error, json } from './http';
import { registerMemberRoutes } from './members';
import { Router } from './router';
import { registerStampRoutes } from './stamps';
import { registerStreamRoutes } from './streams';

const router = new Router();

router.add('GET', '/api/health', async ({ url }) => {
  // ?probe=round3 は lib.js が Worker から読めることの確認用
  // ?probe=round3 proves lib.js is importable from the Worker
  if (url.searchParams.get('probe') === 'round3') return json(200, { ok: true, round3: TSLib.round3(1.23456) });
  return json(200, { ok: true });
});
registerAuthRoutes(router);
registerMemberRoutes(router);
registerStreamRoutes(router);
registerStampRoutes(router);
registerChatRoutes(router);

async function handleRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const found = router.match(request);
  if (!found) return error(404, 'not_found');
  try {
    return await found.handler({ request, env, params: found.params, url });
  } catch (thrown) {
    // readJson などが throw した Response はそのまま返す / Return Responses thrown by readJson and friends as-is
    if (thrown instanceof Response) return thrown;
    if (thrown instanceof TwitchUnavailable) return error(503, 'twitch_unavailable');
    // それ以外も {error} の形で返す / Anything else still answers in the {error} shape
    console.error(thrown);
    return error(500, 'internal');
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // サインインの戻り先は静的ページ（auth/callback.html）。他の /auth/ は router
    // The sign-in return page is static (auth/callback.html); other /auth/ paths go to the router
    if (path === '/auth/callback') return env.ASSETS.fetch(request);
    if (path.startsWith('/api/') || path.startsWith('/auth/')) {
      // /api/ の preflight は認証より前に答える。応答はエラーも含めて Bearer のときだけ CORS を付ける
      // Answer /api/ preflights before auth. Every response, errors included, gets CORS only for Bearer requests
      const preflight = corsPreflight(request);
      if (preflight) return preflight;
      return withCors(request, await handleRoute(request, env, url));
    }
    // 共有ページ /s/<id> と /s/<id>/comments。拡張子なしで引く（.html だと 307 で /s へ飛ばされ ID が消える）
    // Shared pages /s/<id> and /s/<id>/comments. Fetch without the extension (.html would 307 to /s and drop the id)
    if (/^\/s\/[^/]+\/?$/.test(path)) return env.ASSETS.fetch(new Request(url.origin + '/s', request));
    if (/^\/s\/[^/]+\/comments\/?$/.test(path)) return env.ASSETS.fetch(new Request(url.origin + '/comments', request));
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
