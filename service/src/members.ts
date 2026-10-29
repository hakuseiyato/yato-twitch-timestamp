// チャンネルの作成・一覧と会員の管理 / Creating and listing channels, and managing members
import TSLib from '../../panel/js/lib.js';
import { isSiteAdmin, requireOwner, type Role } from './access';
import { requireAuth, requireCsrf } from './auth';
import { nowIso, type ChannelRow, type MemberRow } from './db';
import { error, json, readJson } from './http';
import type { Router } from './router';

const DISPLAY_NAME_MAX = 100;

// 最後の owner を残すための条件（channel は ?1）。role が NULL の行も owner 以外として扱う
// Condition that keeps the last owner (channel is ?1). Rows with a NULL role count as non-owners
const MORE_THAN_ONE_OWNER = "(SELECT COUNT(*) FROM members WHERE channel = ?1 AND role = 'owner') > 1";

function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'editor';
}

export function registerMemberRoutes(router: Router): void {
  // 自分が会員のチャンネル。サイト管理者は全チャンネルを owner として見る
  // Channels the caller belongs to. The site admin sees every channel as owner
  router.add('GET', '/api/channels', async (ctx) => {
    const principal = await requireAuth(ctx);
    const statement = isSiteAdmin(principal, ctx.env)
      ? ctx.env.DB.prepare("SELECT login, display_name, 'owner' AS role FROM channels ORDER BY login")
      : ctx.env.DB.prepare(
          "SELECT c.login, c.display_name, m.role FROM members m JOIN channels c ON c.login = m.channel WHERE m.login = ? AND m.role IN ('owner', 'editor') ORDER BY c.login",
        ).bind(principal.login);
    const { results } = await statement.all<{ login: string; display_name: string | null; role: Role }>();
    return json(200, { channels: results });
  });

  // サイト管理者だけがチャンネルを作れる。作成者は owner として会員に入る
  // Only the site admin creates channels. The creator joins as owner
  router.add('POST', '/api/channels', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireCsrf(ctx, principal);
    if (!isSiteAdmin(principal, ctx.env)) return error(403, 'forbidden');
    const body = await readJson<{ login?: unknown; display_name?: unknown } | null>(ctx.request, 4096);
    const login = TSLib.validLogin(body?.login);
    const displayName = body?.display_name ?? null;
    if (!login || (displayName !== null && (typeof displayName !== 'string' || displayName.length > DISPLAY_NAME_MAX))) {
      return error(400, 'bad_request');
    }
    const now = nowIso();
    const inserted = await ctx.env.DB.prepare('INSERT OR IGNORE INTO channels (login, display_name, created_by, created_at) VALUES (?, ?, ?, ?)')
      .bind(login, displayName, principal.login, now)
      .run();
    if (inserted.meta.changes === 0) return error(409, 'exists');
    await ctx.env.DB.prepare('INSERT OR REPLACE INTO members (channel, login, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
      .bind(login, principal.login, 'owner', principal.login, now)
      .run();
    const channel: ChannelRow = { login, display_name: displayName, created_by: principal.login, created_at: now };
    return json(200, { channel });
  });

  router.add('GET', '/api/channels/:login/members', async (ctx) => {
    const principal = await requireAuth(ctx);
    await requireOwner(ctx, principal, ctx.params.login);
    const { results } = await ctx.env.DB.prepare('SELECT login, role, added_by, added_at FROM members WHERE channel = ? ORDER BY login')
      .bind(ctx.params.login)
      .all<Omit<MemberRow, 'channel'>>();
    return json(200, { members: results });
  });

  // 会員の追加。既にいれば役割を更新する。最後の owner を editor に下げるのは 400
  // Adds a member, or updates the role when present. Demoting the last owner is 400
  router.add('POST', '/api/channels/:login/members', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireCsrf(ctx, principal);
    const channel = ctx.params.login;
    await requireOwner(ctx, principal, channel);
    const body = await readJson<{ login?: unknown; role?: unknown } | null>(ctx.request, 4096);
    const login = TSLib.validLogin(body?.login);
    const role = body?.role;
    if (!login || !isRole(role)) return error(400, 'bad_request');
    // 衝突時の UPDATE は WHERE が偽なら行われず changes が 0 になる / On conflict the UPDATE is skipped (changes 0) when WHERE is false
    const result = await ctx.env.DB.prepare(
      'INSERT INTO members (channel, login, role, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5) ' +
        'ON CONFLICT (channel, login) DO UPDATE SET role = excluded.role ' +
        `WHERE excluded.role = 'owner' OR members.role IS NOT 'owner' OR ${MORE_THAN_ONE_OWNER}`,
    )
      .bind(channel, login, role, principal.login, nowIso())
      .run();
    if (result.meta.changes === 0) return error(400, 'last_owner');
    const member = await ctx.env.DB.prepare('SELECT login, role, added_by, added_at FROM members WHERE channel = ? AND login = ?')
      .bind(channel, login)
      .first<Omit<MemberRow, 'channel'>>();
    return json(200, { member });
  });

  // 会員の削除。最後の owner は消せない（数えてから消すと競合するので 1 文で判定）
  // Removes a member. The last owner cannot be removed (checked in one statement, as count-then-delete would race)
  router.add('DELETE', '/api/channels/:login/members/:member', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireCsrf(ctx, principal);
    const channel = ctx.params.login;
    await requireOwner(ctx, principal, channel);
    const result = await ctx.env.DB.prepare(
      `DELETE FROM members WHERE channel = ?1 AND login = ?2 AND (role IS NOT 'owner' OR ${MORE_THAN_ONE_OWNER})`,
    )
      .bind(channel, ctx.params.member)
      .run();
    if (result.meta.changes === 0) {
      const exists = await ctx.env.DB.prepare('SELECT 1 FROM members WHERE channel = ? AND login = ?').bind(channel, ctx.params.member).first();
      return exists ? error(400, 'last_owner') : error(404, 'not_found');
    }
    return json(200, { ok: true });
  });
}
