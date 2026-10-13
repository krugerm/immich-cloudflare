import { ImmichError } from '../http/errors';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth, type AuthContext } from '../auth/session';
import { nowCursor } from '../db/changes';
import { deleteAcks, getCheckpointAcks, needsReset, resetSession, setAcks } from './acks';
import { BudgetExhausted, PASSES, REQUEST_ORDER, type SyncContext } from './passes';

export const PAGE_SIZE = 500;
export const QUERY_BUDGET = 950;

const enc = new TextEncoder();
const line = (type: string, data: unknown, ack: string) => enc.encode(JSON.stringify({ type, data, ack }) + '\n');

/** Yields one encoded chunk per page, so at most one page of lines is held in memory. */
async function* generate(db: D1Database, auth: AuthContext, wanted: Set<string>, pageSize: number, budget: number) {
  if (needsReset(auth.session)) {
    yield line('SyncResetV1', {}, 'SyncResetV1|reset');
    return;
  }
  let queries = 2;
  const acks = await getCheckpointAcks(db, auth.session.id);
  const checkpoints = new Map([...acks].map(([type, a]) => [type, a.updateId]));
  const now = await nowCursor(db);
  // context for StreamPass (album and partner backfill, album asset creates/updates), sharing the query budget
  const ctx: SyncContext = {
    db,
    userId: auth.user.id,
    sessionId: auth.session.id,
    now,
    pageSize,
    acks,
    async all<T>(stmt: D1PreparedStatement) {
      if (queries >= budget) throw new BudgetExhausted();
      queries++;
      return (await stmt.all<T>()).results;
    },
  };
  for (const request of REQUEST_ORDER) {
    if (!wanted.has(request)) continue;
    for (const pass of PASSES[request]) {
      if ('stream' in pass) {
        try {
          for await (const text of pass.stream(ctx)) yield enc.encode(text);
        } catch (err) {
          if (err instanceof BudgetExhausted) return; // same as below: close without SyncCompleteV1
          throw err;
        }
        continue;
      }
      let after = checkpoints.get(pass.entity) ?? '';
      for (;;) {
        if (queries >= budget) return; // close without SyncCompleteV1; the client acks what it has and the next sync resumes
        const page = await pass.fetch(db, auth.user.id, after, now, pageSize);
        queries++;
        let text = '';
        for (const row of page) text += JSON.stringify({ type: pass.entity, data: row.data, ack: `${pass.entity}|${row.cursor}` }) + '\n';
        if (text) yield enc.encode(text);
        if (page.length < pageSize) break;
        after = page[page.length - 1].cursor;
      }
    }
  }
  yield line('SyncCompleteV1', {}, `SyncCompleteV1|${now}`);
}

export function streamSync(
  db: D1Database,
  auth: AuthContext,
  types: string[],
  opts: { pageSize?: number; queryBudget?: number } = {},
): ReadableStream<Uint8Array> {
  const gen = generate(db, auth, new Set(types), opts.pageSize ?? PAGE_SIZE, opts.queryBudget ?? QUERY_BUDGET);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await gen.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (err) {
        console.error('sync stream failed', err);
        controller.close(); // never end with an error: the client would drop unacked lines
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

export const syncRoutes = new Hono<AppEnv>();

syncRoutes.post('/sync/stream', requireAuth, async (c) => {
  const body = await c.req.json<{ types?: string[]; reset?: boolean }>();
  const auth = c.get('auth');
  if (body.reset) {
    await resetSession(c.env.DB, auth.session.id);
    auth.session.reset_at = new Date().toISOString();
    auth.session.is_pending_sync_reset = 0;
  }
  return new Response(streamSync(c.env.DB, auth, body.types ?? []), {
    headers: { 'content-type': 'application/jsonlines+json', 'cache-control': 'no-store' },
  });
});

syncRoutes.get('/sync/ack', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT entity_type, ack FROM sync_checkpoints WHERE session_id = ?1')
    .bind(c.get('auth').session.id)
    .all<{ entity_type: string; ack: string }>();
  return c.json(results.map((r) => ({ type: r.entity_type, ack: r.ack })));
});

syncRoutes.post('/sync/ack', requireAuth, async (c) => {
  const body = await c.req.json<{ acks?: unknown }>().catch(() => null);
  if (!body || (body.acks !== undefined && !Array.isArray(body.acks))) throw new ImmichError(400, 'acks must be an array');
  await setAcks(c.env.DB, c.get('auth').session.id, body.acks ?? []);
  return c.body(null, 204);
});

syncRoutes.delete('/sync/ack', requireAuth, async (c) => {
  const body = await c.req.json<{ types?: string[] }>().catch(() => ({}) as { types?: string[] });
  await deleteAcks(c.env.DB, c.get('auth').session.id, body.types);
  return c.body(null, 204);
});
