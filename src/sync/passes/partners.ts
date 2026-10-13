// stream D: partner sync passes, matching Immich sync.service.ts / sync.repository.ts (PartnerSync,
// PartnerAssetsSync, PartnerAssetExifsSync).
import type { AssetRow, ExifRow } from '../../db/rows';
import type { Dto } from '../../gen/dto';
import { backfill as groupBackfill } from '../backfill';
import type { StackRow } from '../../stacks/repo';
import { mapSyncAsset, mapSyncExif, mapSyncStack, type Pass, type StreamPass } from '../passes';

const SHARERS = 'SELECT shared_by_id FROM partners WHERE shared_with_id = ?1';

function rows<T>(db: D1Database, sql: string, ...binds: unknown[]) {
  return db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
}

interface PartnerRow {
  shared_by_id: string;
  shared_with_id: string;
  in_timeline: number;
  update_id: string;
}

const partnerDeletes: Pass = {
  entity: 'PartnerDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; shared_by_id: string; shared_with_id: string }>(
      db,
      `SELECT id, shared_by_id, shared_with_id FROM partner_audit
       WHERE (shared_by_id = ?1 OR shared_with_id = ?1) AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((d) => ({ cursor: d.id, data: { sharedById: d.shared_by_id, sharedWithId: d.shared_with_id } satisfies Dto<'SyncPartnerDeleteV1'> }));
  },
};

const partners: Pass = {
  entity: 'PartnerV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<PartnerRow>(
      db,
      `SELECT shared_by_id, shared_with_id, in_timeline, update_id FROM partners
       WHERE (shared_by_id = ?1 OR shared_with_id = ?1) AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((p) => ({
      cursor: p.update_id,
      data: { sharedById: p.shared_by_id, sharedWithId: p.shared_with_id, inTimeline: p.in_timeline === 1 } satisfies Dto<'SyncPartnerV1'>,
    }));
  },
};

const partnerAssetDeletes: Pass = {
  entity: 'PartnerAssetDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; asset_id: string }>(
      db,
      `SELECT id, asset_id FROM asset_audit WHERE owner_id IN (${SHARERS}) AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((d) => ({ cursor: d.id, data: { assetId: d.asset_id } }));
  },
};

/** Immich selects `false as isFavorite` for partner assets. */
const mapPartnerAsset = (a: AssetRow) => ({ ...mapSyncAsset(a), isFavorite: false });

const partnerAssets: Pass = {
  entity: 'PartnerAssetV2',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<AssetRow>(
      db,
      `SELECT * FROM assets WHERE owner_id IN (${SHARERS}) AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((a) => ({ cursor: a.update_id, data: mapPartnerAsset(a) }));
  },
};

const partnerExifs: Pass = {
  entity: 'PartnerAssetExifV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<ExifRow>(
      db,
      `SELECT * FROM asset_exif WHERE owner_id IN (${SHARERS}) AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((e) => ({ cursor: e.update_id, data: mapSyncExif(e) }));
  },
};

/**
 * Immich's per-partner backfill through the shared group backfill: the groups are the partners sharing with the user,
 * by partnership create cursor, and each rows statement re-checks the partnership.
 */
function backfill<T extends { cursor: string }>(type: string, upsertType: string, table: 'assets' | 'asset_exif' | 'stacks', map: (row: T) => unknown): StreamPass {
  return groupBackfill<T>({
    type,
    upsertType,
    groups: (ctx, afterCreate) =>
      ctx.db
        .prepare('SELECT shared_by_id AS group_id, create_id FROM partners WHERE shared_with_id = ?1 AND create_id >= ?2 AND create_id <= ?3 ORDER BY create_id')
        .bind(ctx.userId, afterCreate, ctx.now),
    rows: (ctx, sharerId, after, end) =>
      ctx.db
        .prepare(
          `SELECT t.*, t.update_id AS cursor FROM partners p JOIN ${table} t ON t.owner_id = p.shared_by_id
           WHERE p.shared_with_id = ?1 AND p.shared_by_id = ?2 AND t.update_id > ?3 AND t.update_id <= ?4 AND t.update_id <= ?5
           ORDER BY t.update_id LIMIT ?6`,
        )
        .bind(ctx.userId, sharerId, after, end, ctx.now, ctx.pageSize),
    map,
  });
}

const partnerAssetBackfill = backfill<AssetRow & { cursor: string }>('PartnerAssetBackfillV2', 'PartnerAssetV2', 'assets', mapPartnerAsset);
const partnerExifBackfill = backfill<ExifRow & { cursor: string }>('PartnerAssetExifBackfillV1', 'PartnerAssetExifV1', 'asset_exif', mapSyncExif);

// C2 (streams D + E): Immich syncPartnerStackV1 / PartnerStackSync: deletes, per-partner backfill, then upserts.
const partnerStackDeletes: Pass = {
  entity: 'PartnerStackDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; stack_id: string }>(
      db,
      `SELECT id, stack_id FROM stack_audit WHERE owner_id IN (${SHARERS}) AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((d) => ({ cursor: d.id, data: { stackId: d.stack_id } satisfies Dto<'SyncStackDeleteV1'> }));
  },
};

const partnerStacks: Pass = {
  entity: 'PartnerStackV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<StackRow>(
      db,
      `SELECT * FROM stacks WHERE owner_id IN (${SHARERS}) AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((s) => ({ cursor: s.update_id, data: mapSyncStack(s) }));
  },
};

const partnerStackBackfill = backfill<StackRow & { cursor: string }>('PartnerStackBackfillV1', 'PartnerStackV1', 'stacks', mapSyncStack);

export const PARTNER_PASSES: Record<string, Array<Pass | StreamPass>> = {
  PartnersV1: [partnerDeletes, partners],
  PartnerAssetsV2: [partnerAssetDeletes, partnerAssetBackfill, partnerAssets],
  PartnerStacksV1: [partnerStackDeletes, partnerStackBackfill, partnerStacks], // C2
  PartnerAssetExifsV1: [partnerExifBackfill, partnerExifs],
};
