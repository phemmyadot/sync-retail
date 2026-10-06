import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { IMPORT_FIELDS, suggestMapping } from '@sync-retail/shared';
import { prisma } from '../lib/db';
import { badRequest, body } from '../lib/http';
import { commitImport, MAX_IMPORT_ROWS, parseSpreadsheet, validateImport } from '../services/importer';

export const importRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /\.(csv|xlsx|xls)$/i.test(file.originalname)),
});

const mappingSchema = z.object(
  Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, z.string().nullable()])) as Record<(typeof IMPORT_FIELDS)[number]['key'], z.ZodNullable<z.ZodString>>,
);
const rowsSchema = z.array(z.record(z.unknown())).max(MAX_IMPORT_ROWS);
const modeSchema = z.enum(['upsert', 'createOnly']).default('upsert');
/** Review-step decisions for tax values the importer couldn't resolve on its own. */
const taxMappingSchema = z
  .record(
    z.union([
      z.object({ taxClassId: z.string().min(1) }),
      z.object({ useDefault: z.literal(true) }),
      z.object({ create: z.object({ name: z.string().trim().min(1).max(40), rateBps: z.number().int().min(0).max(10_000) }) }),
    ]),
  )
  .optional();

/**
 * Server-side parse for API clients. The web UI parses in the browser with
 * the same SheetJS library and only sends mapped rows to /validate + /commit.
 */
importRouter.post('/parse', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Upload a .csv, .xls or .xlsx file in the "file" field');
  const parsed = parseSpreadsheet(req.file.buffer);
  res.json({ ...parsed, rows: parsed.rows.slice(0, 50), totalRows: parsed.rows.length, suggestedMapping: suggestMapping(parsed.headers) });
});

importRouter.post('/validate', async (req, res) => {
  const input = body(req, z.object({ rows: rowsSchema, mapping: mappingSchema, mode: modeSchema, taxMapping: taxMappingSchema }));
  res.json(await validateImport(input.rows, input.mapping, input.mode, input.taxMapping));
});

importRouter.post('/commit', async (req, res) => {
  const input = body(req, z.object({ fileName: z.string().max(200), rows: rowsSchema, mapping: mappingSchema, mode: modeSchema, taxMapping: taxMappingSchema }));
  res.json(await commitImport(input, req.user!));
});

importRouter.get('/history', async (_req, res) => {
  res.json(
    await prisma.importBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { user: { select: { name: true } } } }),
  );
});
