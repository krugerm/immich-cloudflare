import spec from '../../vendor/immich-openapi.json';
import type { SessionRow } from '../db/rows';
import { ImmichError } from '../http/errors';

export const ENTITY_TYPES = new Set<string>((spec as any).components.schemas.SyncEntityType.enum);

/** Bump to an ISO timestamp in the same commit as a migration that changes a synced entity's shape. */
export const RESET_BEFORE: string | null = null;

const CURSOR_ID_RE = /^00000000-0000-7000-8000-[0-9a-f]{12}$/;

/** Entity types whose acks carry a third segment (album and partner backfills). */
export const BACKFILL_TYPES = new Set([...ENTITY_TYPES].filter((t) => t.includes('Backfill')));

/**
 * `<type>|<id>`, or for backfill types `<type>|<createId>|<updateId or 'complete'>`: Immich's backfill acks carry the
 * album/partner create cursor and the progress within it (`sync.service.ts`, `toAck` with `extraId`).
 */
export function parseAck(ack: unknown): { type: string; id: string; extraId?: string } {
  const parts = typeof ack === 'string' ? ack.split('|') : [];
  const [type, id, extraId] = parts;
  const backfill = parts.length === 3 && BACKFILL_TYPES.has(type) && (extraId === 'complete' || CURSOR_ID_RE.test(extraId));
  const valid =
    (parts.length === 2 || backfill) &&
    ENTITY_TYPES.has(type) &&
    (type === 'SyncResetV1' ? id === 'reset' : type === 'SyncCompleteV1' ? id.length > 0 : CURSOR_ID_RE.test(id));
  if (!valid) throw new ImmichError(400, `Invalid ack: ${String(ack).slice(0, 100)}`);
  return backfill ? { type, id, extraId } : { type, id };
}

/** Checkpoints by entity type, with the backfill progress id for backfill types. */
export async function getCheckpointAcks(db: D1Database, sessionId: string): Promise<Map<string, { updateId: string; extraId?: string }>> {
  const { results } = await db
    .prepare('SELECT entity_type, ack FROM sync_checkpoints WHERE session_id = ?1')
    .bind(sessionId)
    .all<{ entity_type: string; ack: string }>();
  const acks = new Map<string, { updateId: string; extraId?: string }>();
  for (const r of results) {
    try {
      const { id, extraId } = parseAck(r.ack);
      acks.set(r.entity_type, { updateId: id, extraId });
    } catch {
      // a malformed stored ack is skipped, so that entity type resyncs from the start
    }
  }
  return acks;
}

export function needsReset(session: SessionRow): boolean {
  if (session.is_pending_sync_reset === 1) return true; // stream A: set through PUT /sessions/{id}
  if (!RESET_BEFORE) return false;
  const since = session.reset_at && session.reset_at > session.created_at ? session.reset_at : session.created_at;
  return since < RESET_BEFORE;
}

/** Checkpoints as cursor strings: `<id>`, or `<createId>|<extraId>` for backfill types. */
export async function getCheckpoints(db: D1Database, sessionId: string): Promise<Map<string, string>> {
  const acks = await getCheckpointAcks(db, sessionId);
  return new Map([...acks].map(([type, a]) => [type, a.extraId ? `${a.updateId}|${a.extraId}` : a.updateId]));
}

export async function resetSession(db: D1Database, sessionId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sync_checkpoints WHERE session_id = ?1').bind(sessionId),
    db.prepare('UPDATE sessions SET reset_at = ?2, is_pending_sync_reset = 0 WHERE id = ?1').bind(sessionId, new Date().toISOString()),
  ]);
}

export async function setAcks(db: D1Database, sessionId: string, acks: unknown[]): Promise<void> {
  const parsed = acks.map(parseAck);
  if (parsed.some((a) => a.type === 'SyncResetV1')) return resetSession(db, sessionId);
  const stmts = parsed
    .filter((a) => a.type !== 'SyncCompleteV1')
    .map((a) =>
      db
        .prepare(
          'INSERT INTO sync_checkpoints (session_id, entity_type, ack) VALUES (?1, ?2, ?3) ON CONFLICT (session_id, entity_type) DO UPDATE SET ack = excluded.ack',
        )
        .bind(sessionId, a.type, `${a.type}|${a.id}${a.extraId ? `|${a.extraId}` : ''}`),
    );
  if (stmts.length) await db.batch(stmts);
}

export async function deleteAcks(db: D1Database, sessionId: string, types: string[] | undefined): Promise<void> {
  if (!types || types.length === 0) {
    await db.prepare('DELETE FROM sync_checkpoints WHERE session_id = ?1').bind(sessionId).run();
    return;
  }
  for (const t of types) if (!ENTITY_TYPES.has(t)) throw new ImmichError(400, `Unknown sync type ${t}`);
  await db.batch(types.map((t) => db.prepare('DELETE FROM sync_checkpoints WHERE session_id = ?1 AND entity_type = ?2').bind(sessionId, t)));
}
