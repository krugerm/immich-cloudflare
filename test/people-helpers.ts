// Phase 4 E test helpers: faces and embeddings are seeded directly (Task D writes them in production).
import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { commit, tracked } from '../src/db/changes';
import { FACE_DIM, toBlob } from '../src/ml/contract';
import { vectorStore } from '../src/ml/vectors';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

export async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...authHeaders(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function user(email = 'admin@example.com', isAdmin = true) {
  await createUser({ email, name: email.split('@')[0], isAdmin });
  const token = await login(email);
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: string }>();
  return { token, id: row!.id };
}

let n = 0;
export async function asset(token: string, opts: { visibility?: string; fileCreatedAt?: string } = {}): Promise<string> {
  n++;
  const res = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(64 + (n % 50))), {
    filename: `IMG_${n}.JPG`,
    fields: opts.fileCreatedAt ? { fileCreatedAt: opts.fileCreatedAt, fileModifiedAt: opts.fileCreatedAt } : {},
  });
  if (opts.visibility) await env.DB.prepare('UPDATE assets SET visibility = ?1 WHERE id = ?2').bind(opts.visibility, res.body.id).run();
  return res.body.id;
}

/** Deterministic pseudo-random generator so clustering tests are stable. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

/** A random 512-d direction; distinct seeds are near-orthogonal (cosine around 0). */
export function base(seed: number): number[] {
  const r = rng(seed);
  return Array.from({ length: FACE_DIM }, () => r());
}

/** `b` plus noise: cosine to `b` about 0.95 at noise 0.3. */
export function near(b: number[], seed: number, noise = 0.3): number[] {
  const r = rng(seed * 7919 + 13);
  return b.map((v) => v + noise * r());
}

export async function seedFace(
  assetId: string,
  ownerId: string,
  opts: { embedding?: number[]; personGroupId?: string | null; source?: 'machine-learning' | 'manual' | 'exif'; x1?: number; indexed?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const x1 = opts.x1 ?? 10;
  await commit(env.DB, [
    tracked(
      `INSERT INTO asset_faces (id, asset_id, owner_id, cluster_group_id, person_group_id, image_width, image_height, x1, y1, x2, y2, score, source_type, updated_at, update_id)
       VALUES (?1, ?2, ?3, ?3, ?4, 1000, 800, ?5, 20, ?6, 120, 0.9, ?7, ?8, :cursor)`,
      id,
      assetId,
      ownerId,
      opts.personGroupId ?? null,
      x1,
      x1 + 100,
      opts.source ?? 'machine-learning',
      now,
    ),
  ]);
  if (opts.embedding) {
    await env.DB.prepare('INSERT INTO face_embeddings (face_id, embedding) VALUES (?1, ?2)').bind(id, toBlob(opts.embedding)).run();
    if (opts.indexed !== false) {
      const metadata = opts.personGroupId ? { assigned: '1' } : undefined;
      await vectorStore(env, 'face')!.upsert([{ id, values: opts.embedding, namespace: ownerId, metadata }]);
    }
  }
  return id;
}

/** A person row plus group, as POST /people would create (no faces). */
export async function seedPerson(token: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await call(token, 'POST', '/people', body);
  if (res.status !== 201) throw new Error(`create person ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export function hub(clusterGroupId: string) {
  return env.CLUSTER_HUB.get(env.CLUSTER_HUB.idFromName(clusterGroupId));
}

export interface HubStatus {
  pending: number;
  deferred: number;
  scanning: boolean;
  resetting: boolean;
  running: boolean;
}

export async function hubStatus(clusterGroupId: string): Promise<HubStatus> {
  return (await (await hub(clusterGroupId).fetch('https://cluster-hub/status')).json()) as HubStatus;
}

/** Fires the hub's alarm (the run) and waits until the hub is idle with an empty queue. */
export async function settle(clusterGroupId: string): Promise<HubStatus> {
  await runDurableObjectAlarm(hub(clusterGroupId));
  for (let i = 0; i < 200; i++) {
    const s = await hubStatus(clusterGroupId);
    if (!s.running && s.pending === 0 && s.deferred === 0 && !s.scanning && !s.resetting) return s;
    if (!s.running) await runDurableObjectAlarm(hub(clusterGroupId));
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`cluster hub did not settle: ${JSON.stringify(await hubStatus(clusterGroupId))}`);
}

export async function clusterFaces(clusterGroupId: string, faceIds: string[]) {
  const res = await hub(clusterGroupId).fetch('https://cluster-hub/faces', { method: 'POST', body: JSON.stringify({ faceIds }) });
  if (res.status !== 202) throw new Error(`hub /faces ${res.status}`);
  return settle(clusterGroupId);
}

export async function recluster(clusterGroupId: string, force: boolean) {
  const res = await hub(clusterGroupId).fetch('https://cluster-hub/run', { method: 'POST', body: JSON.stringify({ clusterGroupId, force }) });
  if (res.status !== 202) throw new Error(`hub /run ${res.status}`);
  return settle(clusterGroupId);
}

export async function personOf(faceId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT person_group_id FROM asset_faces WHERE id = ?1').bind(faceId).first<{ person_group_id: string | null }>();
  return row!.person_group_id;
}
