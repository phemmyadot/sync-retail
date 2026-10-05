import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './lib/env';
import { errorHandler, notFound } from './lib/http';
import { authenticate, requirePermission } from './middleware/auth';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { categoriesRouter, productsRouter } from './routes/products';
import { customersRouter } from './routes/customers';
import { salesRouter } from './routes/sales';
import { overridesRouter } from './routes/overrides';
import { reportsRouter } from './routes/reports';
import { importRouter } from './routes/imports';
import { auditRouter, settingsRouter, syncRouter } from './routes/misc';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigins, credentials: true, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '25mb' })); // imports send mapped rows as JSON
  if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use('/api/auth', authRouter);

  const api = express.Router();
  api.use(authenticate);
  api.use('/users', usersRouter);
  api.use('/products', productsRouter);
  api.use('/categories', categoriesRouter);
  api.use('/customers', customersRouter);
  api.use('/sales', salesRouter);
  api.use('/overrides', overridesRouter);
  api.use('/reports', requirePermission('reports:read'), reportsRouter);
  api.use('/import', requirePermission('inventory:import'), importRouter);
  api.use('/settings', settingsRouter);
  api.use('/audit', requirePermission('audit:read'), auditRouter);
  api.use('/sync', syncRouter);
  app.use('/api', api);

  app.use((_req, _res) => {
    throw notFound('Route');
  });
  app.use(errorHandler);
  return app;
}
