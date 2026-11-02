import { randomBytes } from 'node:crypto';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Fail closed on secrets.
 *
 * This used to be `process.env.JWT_SECRET ?? 'dev-only-secret-change-me'`.
 * That literal ships in the repository, so any copy of the source was enough
 * to mint a token for any user id — including a SUPER_ADMIN — and read every
 * supplier cost, selling price and margin in the system. The whole RBAC and
 * field-masking layer sat behind a published password.
 *
 * In production a missing secret is now a boot failure. In development a
 * random one is generated per process: tokens stop working across a restart,
 * which is mildly annoying and exactly the point — there is no longer a
 * shared default worth knowing.
 */
function requiredSecret(name: string): string {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(
      `${name} is not set (or is shorter than 32 chars). Refusing to start in production. ` +
      `Generate one with: openssl rand -base64 48`);
  }
  if (v) {
    console.warn(`[config] ${name} is shorter than 32 chars — acceptable in dev only.`);
    return v;
  }
  const ephemeral = randomBytes(48).toString('base64');
  console.warn(`[config] ${name} not set — generated an ephemeral dev secret. Tokens will not survive a restart.`);
  return ephemeral;
}

function requiredUrl(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`${name} is not set. Refusing to start in production.`);
  console.warn(`[config] ${name} not set — falling back to ${devFallback} (dev only).`);
  return devFallback;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: requiredUrl('DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/greenware'),
  jwtSecret: requiredSecret('JWT_SECRET'),
  jwtTtl: process.env.JWT_TTL ?? '8h',
  companyCode: process.env.COMPANY_CODE ?? 'GWT',
  // OD-18: Dubai hours and holidays govern every SLA clock
  defaultCalendar: process.env.DEFAULT_CALENDAR ?? 'Dubai',
  // OD-09: hard floor; warn thresholds live per business type in margin_rules
  marginFloorPct: Number(process.env.MARGIN_FLOOR_PCT ?? 3),
  /**
   * CORS. `origin: true` reflected any origin with credentials enabled.
   * Set CORS_ORIGINS to a comma-separated allowlist in any deployed
   * environment; dev falls back to the local vite and compose hosts.
   */
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:8081')
    .split(',').map(s => s.trim()).filter(Boolean),
  entra: {
    enabled: process.env.ENTRA_ENABLED === 'true',
    tenantId: process.env.ENTRA_TENANT_ID ?? '',
    clientId: process.env.ENTRA_CLIENT_ID ?? '',
  },
  isProd,
};
