import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './core/config.js';
import { ZodError } from 'zod';
import { AppError } from './core/errors.js';
import { authPlugin } from './core/auth.js';
import { registerModules } from './modules/index.js';

export async function build() {
  const app = Fastify({
    logger: config.isProd ? true : { transport: undefined, level: 'warn' },
    bodyLimit: 10 * 1024 * 1024,
  });

  // origin:true reflected ANY origin back with credentials enabled. Pin it.
  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(jwt, { secret: config.jwtSecret });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details ?? undefined },
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: 'Check the highlighted fields',
          details: err.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        },
      });
    }
    if ((err as any).validation) {
      return reply.status(400).send({
        error: { code: 'validation_failed', message: 'Check the highlighted fields', details: (err as any).validation },
      });
    }
    // Fastify's own errors — empty JSON body, unsupported media type, payload too
    // large, malformed JSON — already carry the right 4xx status. They are the
    // caller's mistake, not ours, so they must not fall through to the 500 branch
    // and be reported (and logged) as a server fault.
    const framework = err as { statusCode?: number; code?: string; message?: string };
    if (typeof framework.statusCode === 'number' && framework.statusCode >= 400 && framework.statusCode < 500) {
      return reply.status(framework.statusCode).send({
        error: { code: framework.code ?? 'bad_request', message: framework.message ?? 'Check the request and try again' },
      });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong on our side' } });
  });

  app.get('/health', async () => ({ ok: true, service: 'greenware-erp-api', ts: new Date().toISOString() }));
  app.get('/api/v1/meta', async () => ({ company: config.companyCode, calendar: config.defaultCalendar, marginFloorPct: config.marginFloorPct }));

  await app.register(authPlugin);
  await app.register(registerModules);
  return app;
}

const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  build().then(app => app.listen({ port: config.port, host: config.host })
    .then(() => console.log(`greenware-erp api on :${config.port}`)))
    .catch(e => { console.error(e); process.exit(1); });
}
