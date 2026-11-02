import type { FastifyInstance } from 'fastify';
import { mastersRoutes } from './masters.js';
import { salesRoutes } from './sales.js';
import { procurementRoutes } from './procurement.js';
import { estimationRoutes } from './estimation.js';
import { quotationRoutes } from './quotation.js';
import { documentRoutes } from './documents.js';
import { priceHistoryRoutes } from './price-history.js';
import { adminRoutes } from './admin.js';

export async function registerModules(app: FastifyInstance) {
  await app.register(mastersRoutes);
  await app.register(salesRoutes);
  await app.register(procurementRoutes);
  await app.register(estimationRoutes);
  await app.register(quotationRoutes);
  await app.register(documentRoutes);
  await app.register(priceHistoryRoutes);
  await app.register(adminRoutes);
}
