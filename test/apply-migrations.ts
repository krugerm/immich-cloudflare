import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import { resetFakeVectors } from '../src/ml/vectors';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

async function emptyBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// Every test starts from an empty database (seq at 0) and empty buckets.
// Child tables are deleted before their parents.
beforeEach(async () => {
  await env.DB.batch([
    // phase 4 (geo_place and geo_country are reference data, left alone)
    env.DB.prepare('DELETE FROM face_embeddings'),
    env.DB.prepare('DELETE FROM asset_face_audit'),
    env.DB.prepare('DELETE FROM asset_faces'),
    env.DB.prepare('DELETE FROM person_audit'),
    env.DB.prepare('DELETE FROM people'),
    env.DB.prepare('DELETE FROM person_groups'),
    env.DB.prepare('DELETE FROM smart_search'),
    env.DB.prepare('DELETE FROM vector_delete_queue'),
    // stream C
    env.DB.prepare('DELETE FROM activities'),
    env.DB.prepare('DELETE FROM shared_link_assets'),
    env.DB.prepare('DELETE FROM shared_links'),
    env.DB.prepare('DELETE FROM album_asset_audit'),
    env.DB.prepare('DELETE FROM album_assets'),
    env.DB.prepare('DELETE FROM album_users'),
    env.DB.prepare('DELETE FROM albums'),
    env.DB.prepare('DELETE FROM album_audit'),
    env.DB.prepare('DELETE FROM album_user_audit'),
    // stream F
    env.DB.prepare('DELETE FROM memory_asset_audit'),
    env.DB.prepare('DELETE FROM memory_audit'),
    env.DB.prepare('DELETE FROM memory_assets'),
    env.DB.prepare('DELETE FROM memories'),
    env.DB.prepare('DELETE FROM server_state'),
    // stream A
    env.DB.prepare('DELETE FROM api_keys'),
    env.DB.prepare('DELETE FROM sync_checkpoints'),
    env.DB.prepare('DELETE FROM login_failures'),
    env.DB.prepare('DELETE FROM password_resets'),
    // stream D
    env.DB.prepare('DELETE FROM partners'),
    env.DB.prepare('DELETE FROM partner_audit'),
    env.DB.prepare('DELETE FROM system_config'),
    env.DB.prepare('DELETE FROM notifications'),
    env.DB.prepare('DELETE FROM sessions'),
    // stream B
    env.DB.prepare('DELETE FROM asset_metadata_audit'),
    env.DB.prepare('DELETE FROM asset_metadata'),
    // stream E
    env.DB.prepare('DELETE FROM tag_asset'),
    env.DB.prepare('DELETE FROM tags'),
    env.DB.prepare('DELETE FROM stack_audit'),
    env.DB.prepare('DELETE FROM stacks'),
    env.DB.prepare('DELETE FROM asset_exif'),
    env.DB.prepare('DELETE FROM asset_audit'),
    env.DB.prepare('DELETE FROM r2_delete_queue'),
    env.DB.prepare('DELETE FROM assets'),
    env.DB.prepare('DELETE FROM user_audit'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('UPDATE seq SET v = 0 WHERE id = 1'),
  ]);
  await emptyBucket(env.MEDIA);
  await emptyBucket(env.BACKUP);
  resetFakeVectors();
});
