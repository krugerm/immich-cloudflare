const PREFIX = '00000000-0000-7000-8000-';

export const CURSOR_SQL = `(SELECT '${PREFIX}' || printf('%012x', v) FROM seq WHERE id = 1)`;
const BUMP_SQL = 'UPDATE seq SET v = v + 1 WHERE id = 1';

export function formatCursor(n: number): string {
  return PREFIX + n.toString(16).padStart(12, '0');
}

/** A statement that writes exactly one synced row; `:cursor` marks where its update_id goes. */
export class Tracked {
  constructor(readonly sql: string, readonly binds: unknown[]) {}
}

export function tracked(sql: string, ...binds: unknown[]): Tracked {
  if (!sql.includes(':cursor')) throw new Error('tracked SQL must set update_id (or audit id) to :cursor');
  return new Tracked(sql.replaceAll(':cursor', CURSOR_SQL), binds);
}

/**
 * Runs all items in one D1 transaction. Each Tracked item is preceded by a seq bump,
 * so every synced row gets its own cursor and cursor order equals commit order.
 */
export async function commit(db: D1Database, items: Array<Tracked | D1PreparedStatement>): Promise<D1Result[]> {
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    if (item instanceof Tracked) {
      statements.push(db.prepare(BUMP_SQL), db.prepare(item.sql).bind(...item.binds));
    } else {
      statements.push(item);
    }
  }
  return db.batch(statements);
}

export async function nowCursor(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT ${CURSOR_SQL} AS c`).first<{ c: string }>();
  return row!.c;
}
