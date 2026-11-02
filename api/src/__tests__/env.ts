/**
 * Imported first by the test helpers so `core/db.js` picks up a connection
 * string before its module-level pool is constructed. The default is the local
 * development database from docs/CONVENTIONS.md; CI sets DATABASE_URL itself.
 */
process.env.DATABASE_URL ??= 'postgres://postgres:gwerp@127.0.0.1:5433/greenware';
export {};
