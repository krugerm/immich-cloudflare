// stream F: MemoriesV2 and MemoryToAssetsV2 sync types.
import type { Dto } from '../../gen/dto';
import type { MemoryRow } from '../../memories/repo';
import type { Pass } from '../passes';

function rows<T>(db: D1Database, sql: string, ...binds: unknown[]) {
  return db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
}

export function mapSyncMemory(m: MemoryRow): Dto<'SyncMemoryV2'> {
  return {
    id: m.id,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    deletedAt: m.deleted_at,
    ownerId: m.owner_id,
    type: m.type,
    data: JSON.parse(m.data),
    isSaved: m.is_saved === 1,
    memoryAt: m.memory_at,
    seenAt: m.seen_at,
    showAt: m.show_at,
    hideAt: m.hide_at,
  };
}

const memoryDeletes: Pass = {
  entity: 'MemoryDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; memory_id: string }>(db, 'SELECT id, memory_id FROM memory_audit WHERE user_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit);
    return r.map((d) => ({ cursor: d.id, data: { memoryId: d.memory_id } }));
  },
};

const memories: Pass = {
  entity: 'MemoryV2',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<MemoryRow>(db, 'SELECT * FROM memories WHERE owner_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((m) => ({ cursor: m.update_id, data: mapSyncMemory(m) }));
  },
};

const memoryAssetDeletes: Pass = {
  entity: 'MemoryToAssetDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; memory_id: string; asset_id: string }>(
      db, 'SELECT id, memory_id, asset_id FROM memory_asset_audit WHERE owner_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit,
    );
    return r.map((d) => ({ cursor: d.id, data: { memoryId: d.memory_id, assetId: d.asset_id } }));
  },
};

const memoryAssets: Pass = {
  entity: 'MemoryToAssetV2',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ memory_id: string; asset_id: string; update_id: string }>(
      db,
      `SELECT ma.memory_id, ma.asset_id, ma.update_id FROM memory_assets ma JOIN memories m ON m.id = ma.memory_id
       WHERE m.owner_id = ?1 AND ma.update_id > ?2 AND ma.update_id <= ?3 ORDER BY ma.update_id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((d) => ({ cursor: d.update_id, data: { memoryId: d.memory_id, assetId: d.asset_id } }));
  },
};

export const MEMORY_PASSES: Record<string, Pass[]> = {
  MemoriesV2: [memoryDeletes, memories],
  MemoryToAssetsV2: [memoryAssetDeletes, memoryAssets],
};
