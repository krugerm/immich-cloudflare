// Immich per-group backfill (sync.service.ts, `upsertBackfillCheckpoint` and the `*Backfill*` passes), shared by album
// sync (groups are the user's album memberships) and partner sync (groups are the partners sharing with the user).
import type { StreamPass, SyncContext } from './passes';

export const COMPLETE = 'complete';

export const syncLine = (type: string, data: unknown, ack: string) => JSON.stringify({ type, data, ack }) + '\n';

/** Keyset pages over rows carrying a `cursor` column, through the stream's query budget. */
export async function* pages<T extends { cursor: string }>(ctx: SyncContext, after: string, page: (after: string) => D1PreparedStatement) {
  for (;;) {
    const result = await ctx.all<T>(page(after));
    yield result;
    if (result.length < ctx.pageSize) return;
    after = result[result.length - 1].cursor;
  }
}

export interface BackfillSpec<T extends { cursor: string }> {
  /** Backfill entity type, e.g. `AlbumAssetBackfillV2`, `PartnerAssetBackfillV2`. */
  type: string;
  /** The upsert type whose checkpoint bounds the backfill, e.g. `AlbumAssetCreateV2`, `PartnerAssetV2`. */
  upsertType: string;
  /**
   * Groups the user joined, as rows `{ group_id, create_id }` ordered by `create_id`, with `create_id >= afterCreate`
   * and `create_id <= ctx.now`.
   */
  groups(ctx: SyncContext, afterCreate: string): D1PreparedStatement;
  /**
   * One page of a group's rows with `cursor` (the row's update id) in `(after, end]` and `<= ctx.now`, ordered by cursor,
   * `LIMIT ctx.pageSize`. The statement re-checks the user's membership of the group.
   */
  rows(ctx: SyncContext, groupId: string, after: string, end: string): D1PreparedStatement;
  map(row: T, ctx: SyncContext): unknown;
}

/**
 * Rows of groups the user joined after the client already synced past them.
 * - No upsert checkpoint: the upsert pass sends everything, so the server stores the newest group as complete and sends
 *   nothing (Immich upsertBackfillCheckpoint).
 * - Otherwise each incomplete group's rows up to the upsert checkpoint are sent, acked `<type>|<createId>|<updateId>`,
 *   then a SyncAckV1 line acks `<type>|<createId>|complete`. A group whose create id equals the stored checkpoint resumes
 *   after the stored update id.
 */
export function backfill<T extends { cursor: string }>(spec: BackfillSpec<T>): StreamPass {
  const { type, upsertType } = spec;
  return {
    entity: type,
    async *stream(ctx) {
      const checkpoint = ctx.acks.get(type);
      const groups = await ctx.all<{ group_id: string; create_id: string }>(spec.groups(ctx, checkpoint?.updateId ?? ''));
      const upsert = ctx.acks.get(upsertType);
      if (!upsert) {
        if (groups.length > 0) {
          const ack = `${type}|${groups[groups.length - 1].create_id}|${COMPLETE}`;
          await ctx.all(
            ctx.db
              .prepare(
                'INSERT INTO sync_checkpoints (session_id, entity_type, ack) VALUES (?1, ?2, ?3) ON CONFLICT (session_id, entity_type) DO UPDATE SET ack = excluded.ack',
              )
              .bind(ctx.sessionId, type, ack),
          );
        }
        return;
      }
      for (const { group_id, create_id } of groups) {
        const resume = checkpoint?.updateId === create_id ? checkpoint.extraId : undefined;
        if (resume === COMPLETE) continue;
        for await (const page of pages<T>(ctx, resume ?? '', (after) => spec.rows(ctx, group_id, after, upsert.updateId))) {
          if (page.length) yield page.map((r) => syncLine(type, spec.map(r, ctx), `${type}|${create_id}|${r.cursor}`)).join('');
        }
        yield syncLine('SyncAckV1', {}, `${type}|${create_id}|${COMPLETE}`);
      }
    },
  };
}
