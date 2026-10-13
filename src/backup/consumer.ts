import type { AssetRow } from '../db/rows';

export interface BackupMessage {
  assetId: string;
}

/** Streams the original from MEDIA into BACKUP through the R2 bindings. Never deletes from BACKUP. */
export async function copyToBackup(env: Env, asset: AssetRow): Promise<void> {
  const src = await env.MEDIA.get(asset.original_path);
  if (!src) throw new Error(`backup source missing: ${asset.original_path}`);
  await env.BACKUP.put(asset.original_path, src.body, {
    httpMetadata: src.httpMetadata,
    customMetadata: { sha1: asset.checksum },
  });
  await env.DB.prepare('UPDATE assets SET backed_up_at = ?2 WHERE id = ?1').bind(asset.id, new Date().toISOString()).run();
}

export async function handleBackupBatch(batch: MessageBatch<BackupMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(msg.body.assetId).first<AssetRow>();
      if (asset && !asset.backed_up_at) await copyToBackup(env, asset);
      msg.ack();
    } catch (err) {
      console.error('backup failed', msg.body.assetId, err);
      msg.retry();
    }
  }
}

export async function requeueMissingBackups(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM assets WHERE backed_up_at IS NULL AND status != 'pending' AND deleted_at IS NULL ORDER BY created_at LIMIT 5000",
  ).all<{ id: string }>();
  for (let i = 0; i < results.length; i += 100) {
    await env.BACKUP_QUEUE.sendBatch(results.slice(i, i + 100).map((r) => ({ body: { assetId: r.id } })));
  }
  return results.length;
}
