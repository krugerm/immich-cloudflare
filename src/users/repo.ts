import { hashPassword } from '../auth/password';
import { commit, tracked } from '../db/changes';
import type { UserRow } from '../db/rows';

export async function insertUser(
  db: D1Database,
  input: { email: string; name: string; password: string; isAdmin: boolean; storageLabel?: string | null },
): Promise<UserRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await commit(db, [
    tracked(
      `INSERT INTO users (id, email, name, password_hash, is_admin, storage_label, profile_changed_at, created_at, updated_at, update_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7, :cursor)`,
      id,
      input.email.toLowerCase(),
      input.name,
      await hashPassword(input.password),
      input.isAdmin ? 1 : 0,
      input.storageLabel ?? null,
      now,
    ),
  ]);
  return (await getUserById(db, id))!;
}

/** Inserts the first admin atomically: the row is written only if the users table is empty. Returns null otherwise. */
export async function insertFirstAdmin(
  db: D1Database,
  input: { email: string; name: string; password: string },
): Promise<UserRow | null> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await commit(db, [
    tracked(
      `INSERT INTO users (id, email, name, password_hash, is_admin, storage_label, profile_changed_at, created_at, updated_at, update_id)
       SELECT ?1, ?2, ?3, ?4, 1, 'admin', ?5, ?5, ?5, :cursor
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
      id,
      input.email.toLowerCase(),
      input.name,
      await hashPassword(input.password),
      now,
    ),
  ]);
  if (results[results.length - 1]!.meta.changes === 0) return null;
  return (await getUserById(db, id))!;
}

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?1 AND deleted_at IS NULL').bind(id).first<UserRow>();
}

export function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?1 AND deleted_at IS NULL').bind(email.toLowerCase()).first<UserRow>();
}

export async function countUsers(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT count(*) AS n FROM users').first<number>('n')) ?? 0;
}

// stream A

type UserColumns = Omit<UserRow, 'id' | 'created_at' | 'updated_at' | 'update_id'>;

/** One tracked UPDATE of a single user row; undefined fields are left alone. Bumps updated_at like Immich's trigger. */
export function userUpdate(id: string, fields: Partial<UserColumns>, now = new Date().toISOString()) {
  const cols = (Object.keys(fields) as Array<keyof UserColumns>).filter((k) => fields[k] !== undefined);
  const sets = cols.map((k, i) => `${k} = ?${i + 3}`);
  return tracked(
    `UPDATE users SET ${[...sets, 'updated_at = ?2', 'update_id = :cursor'].join(', ')} WHERE id = ?1`,
    id,
    now,
    ...cols.map((k) => fields[k]),
  );
}

export async function updateUser(db: D1Database, id: string, fields: Partial<UserColumns>): Promise<UserRow> {
  await commit(db, [userUpdate(id, fields)]);
  return (await getUserAnyState(db, id))!;
}

/** Includes soft-deleted users. */
export function getUserAnyState(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<UserRow>();
}

export async function insertUserAdmin(
  db: D1Database,
  input: {
    email: string;
    name: string;
    password: string;
    isAdmin: boolean;
    avatarColor: string | null;
    pinCodeHash: string | null;
    storageLabel: string | null;
    quotaBytes: number | null;
    shouldChangePassword: boolean;
  },
): Promise<UserRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await commit(db, [
    tracked(
      `INSERT INTO users (id, email, name, password_hash, is_admin, avatar_color, pin_code, storage_label, quota_bytes, should_change_password,
         profile_changed_at, created_at, updated_at, update_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11, :cursor)`,
      id,
      input.email.toLowerCase(),
      input.name,
      await hashPassword(input.password),
      input.isAdmin ? 1 : 0,
      input.avatarColor,
      input.pinCodeHash,
      input.storageLabel,
      input.quotaBytes,
      input.shouldChangePassword ? 1 : 0,
      now,
    ),
  ]);
  return (await getUserById(db, id))!;
}
