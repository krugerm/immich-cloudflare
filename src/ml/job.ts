// Phase 4: the `asset-ml` queue job. One ML call per asset (preview JPEG → SigLIP2 embedding + buffalo_l faces), then
// the results go to smart search (Task B) and faces (Task D). Idempotent: Queues delivers at least once. The queue has
// no dead-letter queue: an asset whose retries run out keeps ml_at null and the daily cron re-enqueues it.
import type { AssetRow } from '../db/rows';
import { storeFaces } from '../faces/store'; // phase 4 Task D
import { continueDuplicateRun, type DuplicateRunMessage } from '../jobs/ml';
import { thumbKey } from '../process/thumbs';
import { storeClip } from './clip'; // phase 4 Task B
import { mlClient } from './client'; // phase 4 Task A
import { MlBadImageError, MlInputError, type MlClient } from './contract';

export interface MlMessage {
  assetId: string;
  /** Re-run even when ml_at is set (admin "all"/force). */
  force?: boolean;
  /** Which parts to (re)compute; default both. */
  clip?: boolean;
  faces?: boolean;
}

async function stamp(env: Env, a: AssetRow, now: string): Promise<void> {
  // ml_at and ml_claim_at are not part of any sync payload, so a plain statement is enough (no update_id bump).
  await env.DB.prepare('UPDATE assets SET ml_at = ?2, ml_claim_at = NULL WHERE id = ?1').bind(a.id, now).run();
}

/** A claim older than this belongs to a consumer that died mid-job. */
const CLAIM_MS = 5 * 60_000;

/**
 * Claims the asset for this job. Two jobs for the same asset (a cron re-send, an admin start, a redelivery) would both
 * read "no faces yet" and both insert the same faces; only the job that wins the claim runs.
 */
async function claim(env: Env, assetId: string, now: Date): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE assets SET ml_claim_at = ?2 WHERE id = ?1 AND (ml_claim_at IS NULL OR ml_claim_at < ?3)')
    .bind(assetId, now.toISOString(), new Date(now.getTime() - CLAIM_MS).toISOString())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

async function release(env: Env, assetId: string): Promise<void> {
  await env.DB.prepare('UPDATE assets SET ml_claim_at = NULL WHERE id = ?1').bind(assetId).run();
}

/** Delivery attempt from which an MlBadImageError stamps the asset instead of retrying (queue max_retries is 5). */
export const ML_FINAL_ATTEMPT = 5;

export async function processMl(env: Env, msg: MlMessage, ml: MlClient, opts: { attempts?: number } = {}): Promise<void> {
  const a = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(msg.assetId).first<AssetRow>();
  if (!a || a.status !== 'ready' || a.deleted_at !== null) return;
  if (a.ml_at !== null && !msg.force) return;
  const started = new Date();
  if (!(await claim(env, a.id, started))) return; // another job has this asset; it stamps or releases it
  const now = started.toISOString();
  try {
    const preview = await env.MEDIA.get(thumbKey(a.id, 'preview'));
    if (!preview) return await stamp(env, a, now); // nothing to look at (no thumbnail); a forced run retries later
    const want = { clip: msg.clip !== false, faces: msg.faces !== false };
    let result;
    try {
      result = await ml.predict(new Uint8Array(await preview.arrayBuffer()), want);
    } catch (err) {
      if (err instanceof MlInputError) return await stamp(env, a, now);
      // A bare 500 on an image is most likely an undecodable preview, but could be transient: retry until the last try.
      if (err instanceof MlBadImageError && (opts.attempts ?? 1) >= ML_FINAL_ATTEMPT) return await stamp(env, a, now);
      throw err; // MlUnavailableError, MlBadImageError before the final attempt, anything else: the queue retries
    }
    if (want.clip && result.clip) await storeClip(env, a, result.clip);
    if (want.faces && result.faces) await storeFaces(env, a, result);
    await stamp(env, a, now);
  } catch (err) {
    await release(env, a.id).catch(() => {}); // let the retry claim it; an unreleased claim expires after 5 minutes
    throw err;
  }
}

/** The asset-ml queue carries per-asset ML jobs and the batches of an admin-started duplicate run. */
export type MlQueueMessage = MlMessage | DuplicateRunMessage;

export async function handleMlBatch(batch: MessageBatch<MlQueueMessage>, env: Env, client?: MlClient): Promise<void> {
  const ml = client ?? mlClient(env);
  for (const msg of batch.messages) {
    const body = msg.body;
    try {
      if ('duplicateRun' in body) await continueDuplicateRun(env, body.duplicateRun);
      else if (!ml) {
        msg.retry({ delaySeconds: 3600 }); // ML not configured: keep the job for later
        continue;
      } else await processMl(env, body, ml, { attempts: msg.attempts });
      msg.ack();
    } catch (err) {
      console.error('ml job failed', 'duplicateRun' in body ? 'duplicate run' : body.assetId, err);
      msg.retry();
    }
  }
}

/** Queues the ML job for a ready asset; failures are logged (the daily cron picks up assets with ml_at null). */
export async function enqueueMl(env: Env, assetId: string): Promise<void> {
  if (!env.ML_QUEUE) return;
  try {
    await env.ML_QUEUE.send({ assetId } satisfies MlMessage);
  } catch (err) {
    console.error('failed to enqueue ml', assetId, err);
  }
}
