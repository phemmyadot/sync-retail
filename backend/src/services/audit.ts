import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../lib/db';

export function audit(
  entry: { actorId?: string | null; action: string; entity: string; entityId?: string | null; details?: Prisma.InputJsonValue },
  tx: Tx | typeof prisma = prisma,
) {
  return tx.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      details: entry.details,
    },
  });
}
