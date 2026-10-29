// チャンネルごとの権限（owner / editor）とサイト管理者の判定
// Per-channel roles (owner / editor) and the site admin check
import type { Principal } from './auth';
import { error } from './http';
import type { HandlerContext } from './router';

export type Role = 'owner' | 'editor';

// BOOTSTRAP_LOGIN（secret）と一致する login がサイト管理者 / The login matching BOOTSTRAP_LOGIN (a secret) is the site admin
export function isSiteAdmin(p: Principal, env: Env): boolean {
  return isAdminLogin(p.login, env);
}

function isAdminLogin(login: string, env: Env): boolean {
  return !!env.BOOTSTRAP_LOGIN && login === env.BOOTSTRAP_LOGIN;
}

// login のチャンネルでの役割。サイト管理者は存在するチャンネルすべてで 'owner'。未知の役割の値は null（fail-closed）
// The login's role in the channel. The site admin is 'owner' of every existing channel. Unknown role values give null (fail-closed)
export async function memberRole(env: Env, channel: string, login: string): Promise<Role | null> {
  if (isAdminLogin(login, env)) {
    const exists = await env.DB.prepare('SELECT 1 FROM channels WHERE login = ?').bind(channel).first();
    return exists ? 'owner' : null;
  }
  const row = await env.DB.prepare('SELECT role FROM members WHERE channel = ? AND login = ?').bind(channel, login).first<{ role: string }>();
  return row?.role === 'owner' || row?.role === 'editor' ? row.role : null;
}

// 会員でなければ 403 を throw（チャンネルの有無は明かさない）/ Throws 403 unless a member (without revealing whether the channel exists)
export async function requireMember(ctx: HandlerContext, p: Principal, channel: string): Promise<Role> {
  const role = await memberRole(ctx.env, channel, p.login);
  if (!role) throw error(403, 'forbidden');
  return role;
}

// owner でなければ 403 を throw / Throws 403 unless an owner
export async function requireOwner(ctx: HandlerContext, p: Principal, channel: string): Promise<Role> {
  const role = await memberRole(ctx.env, channel, p.login);
  if (role !== 'owner') throw error(403, 'forbidden');
  return role;
}
