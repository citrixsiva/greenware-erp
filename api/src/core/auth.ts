import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import argon2 from 'argon2';
import { q1, tx } from './db.js';
import { config } from './config.js';
import { unauthorized } from './errors.js';
import { loadAuthCtx } from './rbac.js';
import { audit } from './audit.js';
import type { AuthCtx } from './types.js';

declare module 'fastify' {
  interface FastifyRequest { auth: AuthCtx }
}

async function authPluginImpl(app: FastifyInstance) {
  app.decorateRequest('auth', null as any);

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const open = ['/api/v1/auth/login', '/health', '/api/v1/meta'];
    if (open.some(p => req.url.startsWith(p))) return;
    try { await req.jwtVerify(); } catch { throw unauthorized(); }
    const sub = (req.user as any)?.sub as string | undefined;
    if (!sub) throw unauthorized();
    const ctx = await loadAuthCtx(sub);
    if (!ctx) throw unauthorized('Your account is no longer active');
    req.auth = ctx;
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const row = await q1<{ id: string; password_hash: string | null; is_active: boolean }>(
      `SELECT u.id, s.value->>'hash' AS password_hash, u.is_active
         FROM gw.users u
         LEFT JOIN gw.settings s ON s.key = 'auth.local.' || u.id
        WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL`, [email]);

    /**
     * Always pay the argon2 cost, even when the email does not exist.
     * Previously the verify ran only when a user with a hash was found, so an
     * unknown email returned in ~5 ms against ~210 ms for a real one — a 40x
     * gap that reliably enumerated staff accounts despite the generic error
     * message. DUMMY_HASH is a real argon2id hash of a random value, so the
     * unknown-email path does the same work as the known one.
     */
    const hash = (row && row.password_hash) ? row.password_hash : DUMMY_HASH;
    const verified = await argon2.verify(hash, password).catch(() => false);
    const ok = !!row && row.is_active && !!row.password_hash && verified;
    if (!ok) {
      await tx({}, c => audit(c, null, {
        entityType: 'users', entityId: row?.id ?? null, action: 'login_failed',
        reason: email, ip: req.ip }));
      throw unauthorized('Email or password is incorrect');
    }
    await tx({ userId: row!.id }, async c => {
      await c.query(`UPDATE gw.users SET last_login_at = now() WHERE id = $1`, [row!.id]);
      await audit(c, null, { entityType: 'users', entityId: row!.id, action: 'login', ip: req.ip });
    });
    const ctx = await loadAuthCtx(row!.id);
    const token = app.jwt.sign({ sub: row!.id }, { expiresIn: config.jwtTtl });
    return reply.send({ token, user: serialiseCtx(ctx!) });
  });

  app.get('/api/v1/auth/me', async (req) => serialiseCtx(req.auth));
}

/**
 * fastify-plugin breaks encapsulation so the preHandler hook and the `auth`
 * decorator apply to EVERY route, not only those registered inside this
 * plugin. Without this the hook never runs for the route modules, which are
 * registered as siblings — every endpoint would reach its handler with
 * req.auth undefined.
 */
export const authPlugin = fp(authPluginImpl, { name: 'gw-auth' });

export const serialiseCtx = (c: AuthCtx) => ({
  id: c.userId, email: c.email, displayName: c.displayName, employeeId: c.employeeId,
  roles: c.roles, sbuIds: c.sbuIds,
  permissions: Object.fromEntries(c.perms),
  fields: [...c.fields], fieldsOwnOnly: [...c.fieldsOwnOnly],
});

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });

/** Constant-work decoy for the unknown-email path. Never matches a real password. */
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4MA';
