// テストの共通処理 / Shared test helpers
import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';

// 未適用の migration だけを D1 に流す（何度呼んでもよい）
// Applies only the migrations not yet applied (safe to call repeatedly)
export async function applyMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

// Worker の fetch を相対パスで呼ぶ / Calls the Worker's fetch with a relative path
export function request(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request('https://example.com' + path, init));
}
