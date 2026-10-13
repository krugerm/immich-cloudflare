import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { commit, tracked } from '../db/changes';
import type { UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { mapUserShort } from '../users/extra';

export const partnerRoutes = new Hono<AppEnv>();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidParam(id: string | undefined, name = 'id'): string {
  if (!id || !UUID_V4.test(id)) throw new ImmichError(400, `${name} must be a UUID`);
  return id;
}

async function jsonBody(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ImmichError(400, 'Invalid request body');
  return body as Record<string, unknown>;
}

export function mapPartner(user: UserRow, inTimeline: number): Dto<'PartnerResponseDto'> {
  return { ...mapUserShort(user), inTimeline: inTimeline === 1 };
}

async function liveUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?1 AND deleted_at IS NULL').bind(id).first<UserRow>();
}

async function createPartner(db: D1Database, me: UserRow, sharedWithId: string): Promise<Dto<'PartnerResponseDto'>> {
  const exists = await db
    .prepare('SELECT 1 AS ok FROM partners WHERE shared_by_id = ?1 AND shared_with_id = ?2')
    .bind(me.id, sharedWithId)
    .first();
  if (exists) throw new ImmichError(400, 'Partner already exists');
  const user = sharedWithId === me.id ? null : await liveUser(db, sharedWithId);
  if (!user) throw new ImmichError(400, 'Invalid user');
  const now = new Date().toISOString();
  const [, insert] = await commit(db, [
    tracked(
      `INSERT INTO partners (shared_by_id, shared_with_id, in_timeline, created_at, updated_at, create_id, update_id)
       VALUES (?1, ?2, 0, ?3, ?3, :cursor, :cursor) ON CONFLICT DO NOTHING`,
      me.id,
      sharedWithId,
      now,
    ),
  ]);
  if (!insert.meta.changes) throw new ImmichError(400, 'Partner already exists');
  return mapPartner(user, 0);
}

partnerRoutes.get('/partners', requireAuth, async (c) => {
  const direction = c.req.query('direction');
  if (direction !== 'shared-by' && direction !== 'shared-with') throw new ImmichError(400, 'direction must be one of: shared-by, shared-with');
  const me = c.get('auth').user.id;
  // shared-by: partners I share with, returning the shared-with user; shared-with: the reverse
  const [mine, other] = direction === 'shared-by' ? ['shared_by_id', 'shared_with_id'] : ['shared_with_id', 'shared_by_id'];
  const { results } = await c.env.DB.prepare(
    `SELECT u.*, p.in_timeline AS partner_in_timeline FROM partners p
     JOIN users u ON u.id = p.${other} AND u.deleted_at IS NULL
     JOIN users m ON m.id = p.${mine} AND m.deleted_at IS NULL
     WHERE p.${mine} = ?1 ORDER BY p.create_id`,
  )
    .bind(me)
    .all<UserRow & { partner_in_timeline: number }>();
  return c.json(results.map((r) => mapPartner(r, r.partner_in_timeline)));
});

partnerRoutes.post('/partners', requireAuth, async (c) => {
  const body = await jsonBody(c.req);
  const id = uuidParam(typeof body.sharedWithId === 'string' ? body.sharedWithId : undefined, 'sharedWithId');
  return c.json(await createPartner(c.env.DB, c.get('auth').user, id), 201);
});

// Deprecated alias of POST /partners.
partnerRoutes.post('/partners/:id', requireAuth, async (c) =>
  c.json(await createPartner(c.env.DB, c.get('auth').user, uuidParam(c.req.param('id'))), 201),
);

partnerRoutes.put('/partners/:id', requireAuth, async (c) => {
  const sharedById = uuidParam(c.req.param('id'));
  const body = await jsonBody(c.req);
  if (typeof body.inTimeline !== 'boolean') throw new ImmichError(400, 'inTimeline must be a boolean');
  const me = c.get('auth').user.id;
  const db = c.env.DB;
  const exists = await db.prepare('SELECT 1 AS ok FROM partners WHERE shared_by_id = ?1 AND shared_with_id = ?2').bind(sharedById, me).first();
  if (!exists) throw new ImmichError(400, 'Not found or no partner.update access');
  await commit(db, [
    tracked(
      'UPDATE partners SET in_timeline = ?3, updated_at = ?4, update_id = :cursor WHERE shared_by_id = ?1 AND shared_with_id = ?2',
      sharedById,
      me,
      body.inTimeline ? 1 : 0,
      new Date().toISOString(),
    ),
  ]);
  const sharer = await db.prepare('SELECT * FROM users WHERE id = ?1').bind(sharedById).first<UserRow>();
  if (!sharer) throw new ImmichError(400, 'Not found or no partner.update access');
  return c.json(mapPartner(sharer, body.inTimeline ? 1 : 0));
});

partnerRoutes.delete('/partners/:id', requireAuth, async (c) => {
  const sharedWithId = uuidParam(c.req.param('id'));
  const me = c.get('auth').user.id;
  const db = c.env.DB;
  const exists = await db.prepare('SELECT 1 AS ok FROM partners WHERE shared_by_id = ?1 AND shared_with_id = ?2').bind(me, sharedWithId).first();
  if (!exists) throw new ImmichError(400, 'Partner not found');
  await commit(db, [
    db.prepare('DELETE FROM partners WHERE shared_by_id = ?1 AND shared_with_id = ?2').bind(me, sharedWithId),
    tracked(
      'INSERT INTO partner_audit (id, shared_by_id, shared_with_id, deleted_at) VALUES (:cursor, ?1, ?2, ?3)',
      me,
      sharedWithId,
      new Date().toISOString(),
    ),
  ]);
  return c.body(null, 204);
});
