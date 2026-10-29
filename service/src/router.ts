// メソッドとパス（`:name` で引数）で handler を引く小さな router
// A tiny router that looks up handlers by method and path (`:name` captures a segment)

export interface HandlerContext {
  request: Request;
  env: Env;
  params: Record<string, string>;
  url: URL;
}

export type Handler = (ctx: HandlerContext) => Promise<Response>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method: method.toUpperCase(), segments: pattern.split('/'), handler });
  }

  match(request: Request): { handler: Handler; params: Record<string, string> } | null {
    const segments = new URL(request.url).pathname.split('/');
    for (const route of this.routes) {
      if (route.method !== request.method || route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      const ok = route.segments.every((part, i) => {
        if (part.startsWith(':')) {
          if (!segments[i]) return false;
          try {
            params[part.slice(1)] = decodeURIComponent(segments[i]);
          } catch {
            // 壊れた %xx は一致なし扱い / Malformed %xx counts as no match
            return false;
          }
          return true;
        }
        return part === segments[i];
      });
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}
