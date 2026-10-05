import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/http';
import { buildReport, reportToCsv, resolveRange, salesLedgerCsv } from '../services/reports';
import { reportToPdf } from '../services/pdf';
import { getSettings } from '../services/settings';

export const reportsRouter = Router();

const rangeQuery = z.object({
  preset: z.enum(['today', 'week', 'month', 'quarter', 'year', 'custom']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  granularity: z.enum(['day', 'week', 'month']).optional(),
});

reportsRouter.get('/summary', async (req, res) => {
  res.json(await buildReport(resolveRange(query(req, rangeQuery))));
});

reportsRouter.get('/export', async (req, res) => {
  const q = query(req, rangeQuery.extend({ format: z.enum(['csv', 'pdf']).default('csv'), dataset: z.enum(['summary', 'ledger']).default('summary') }));
  const range = resolveRange(q);
  const stamp = `${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}`;

  if (q.format === 'csv') {
    const csv = q.dataset === 'ledger' ? await salesLedgerCsv(range) : reportToCsv(await buildReport(range));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sync-retail-${q.dataset}-${stamp}.csv"`);
    res.send(csv);
    return;
  }
  const pdf = await reportToPdf(await buildReport(range), await getSettings());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="sync-retail-report-${stamp}.pdf"`);
  res.send(pdf);
});
