import { auditLog } from "@/db/schema";
import type { DbOrTx } from "@/db";

export interface AuditEntry {
  at: Date;
  actorId: number | null;
  action: string;
  entity: string;
  entityId: string | number;
  before?: unknown;
  after?: unknown;
}

/** Must be called inside the same transaction as the mutation it records. */
export function writeAudit(tx: DbOrTx, e: AuditEntry): number {
  return tx
    .insert(auditLog)
    .values({
      at: e.at.toISOString(),
      actorId: e.actorId,
      action: e.action,
      entity: e.entity,
      entityId: String(e.entityId),
      beforeJson: e.before === undefined ? null : JSON.stringify(e.before),
      afterJson: e.after === undefined ? null : JSON.stringify(e.after),
    })
    .returning({ id: auditLog.id })
    .get().id;
}
