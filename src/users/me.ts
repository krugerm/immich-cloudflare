import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { hashPassword } from '../auth/password';
import { disconnectSessions } from '../realtime/emit';
import { deleteOtherSessions, requireSessionToken } from '../sessions/routes';
import { requireAuth } from '../auth/session';
import { commit } from '../db/changes';
import type { UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { readDto, uuidPathParam } from '../http/validate';
import { boundaryOf, MultipartError, parseMultipart } from '../upload/multipart';
import { mapUserShort } from './extra';
import { mapUserAdmin } from './map';
import { updatedPreferences } from './preferences';
import { getUserById, updateUser, userUpdate } from './repo';

// Immich user.service.ts: the caller's profile, preferences, license, onboarding and profile image, plus GET /users/{id}.

export const meRoutes = new Hono<AppEnv>();

export const MAX_PROFILE_IMAGE = 10 * 1024 * 1024;

/** Rejects an email that belongs to another account (soft-deleted ones included: the column is unique). */
export async function assertEmailAvailable(db: D1Database, email: string, userId: string | null): Promise<void> {
  const other = await db.prepare('SELECT id FROM users WHERE email = ?1').bind(email.toLowerCase()).first<{ id: string }>();
  if (other && other.id !== userId) throw new ImmichError(400, 'Email is not available');
}

meRoutes.put('/users/me', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const dto = await readDto(c, 'UserUpdateMeDto');
  // The web and mobile "Change Password" screens shown when shouldChangePassword is set (after an admin creates the user
  // or resets the password) send the new password here, with no current password. Immich accepts it at any time;
  // here it is accepted only while that flag is set, and otherwise POST /auth/change-password (current password) is required.
  if (dto.password !== undefined && user.should_change_password !== 1) {
    throw new ImmichError(400, 'Use POST /auth/change-password to change the password');
  }
  // A password set here needs a logged-in session (never an API key), and it ends the user's other sessions, as
  // POST /auth/change-password does.
  if (dto.password !== undefined) requireSessionToken(c.get('auth'));
  if (dto.email) await assertEmailAvailable(c.env.DB, dto.email, user.id);
  const fields = {
    email: dto.email?.toLowerCase(),
    name: dto.name,
    avatar_color: dto.avatarColor,
    ...(dto.password !== undefined ? { password_hash: await hashPassword(dto.password), should_change_password: 0 } : {}),
  };
  if (dto.password === undefined) return c.json(mapUserAdmin(await updateUser(c.env.DB, user.id, fields)));
  const { session } = c.get('auth');
  const [readSessions, deleteSessions] = deleteOtherSessions(c.env.DB, user.id, session.id);
  const results = await commit(c.env.DB, [userUpdate(user.id, fields), readSessions, deleteSessions]);
  const deleted = (results[results.length - 2].results ?? []) as Array<{ id: string }>;
  c.executionCtx.waitUntil(disconnectSessions(c.env, user.id, deleted.map((s) => s.id)));
  return c.json(mapUserAdmin((await getUserById(c.env.DB, user.id))!));
});

meRoutes.put('/users/me/preferences', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const dto = await readDto(c, 'UserPreferencesUpdateDto');
  const { prefs, stored } = updatedPreferences(user.preferences, dto);
  await commit(c.env.DB, [userUpdate(user.id, { preferences: stored })]);
  return c.json(prefs);
});

meRoutes.get('/users/me/license', requireAuth, (c) => {
  const { license } = c.get('auth').user;
  if (!license) throw new ImmichError(404, 'Not Found');
  return c.json(JSON.parse(license) as Dto<'LicenseResponseDto'>);
});

/** Stores the license as given. Immich also verifies the activation key against its public keys; that check is not ported. */
meRoutes.put('/users/me/license', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const dto = await readDto(c, 'LicenseKeyDto');
  const license: Dto<'LicenseResponseDto'> = { licenseKey: dto.licenseKey, activationKey: dto.activationKey, activatedAt: new Date().toISOString() };
  await commit(c.env.DB, [userUpdate(user.id, { license: JSON.stringify(license) })]);
  return c.json(license);
});

meRoutes.delete('/users/me/license', requireAuth, async (c) => {
  await commit(c.env.DB, [userUpdate(c.get('auth').user.id, { license: null })]);
  return c.body(null, 204);
});

meRoutes.get('/users/me/onboarding', requireAuth, (c) => c.json({ isOnboarded: c.get('auth').user.is_onboarded === 1 }));

meRoutes.put('/users/me/onboarding', requireAuth, async (c) => {
  const dto = await readDto(c, 'OnboardingDto');
  await commit(c.env.DB, [userUpdate(c.get('auth').user.id, { is_onboarded: dto.isOnboarded ? 1 : 0 })]);
  return c.json({ isOnboarded: dto.isOnboarded });
});

meRoutes.delete('/users/me/onboarding', requireAuth, async (c) => {
  await commit(c.env.DB, [userUpdate(c.get('auth').user.id, { is_onboarded: 0 })]);
  return c.body(null, 204);
});

/** Image type from the file's magic bytes; null when it is not an image the apps can show. */
export function sniffImage(b: Uint8Array): { ext: string; contentType: string } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpeg', contentType: 'image/jpeg' };
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return { ext: 'png', contentType: 'image/png' };
  if (ascii(0, 4) === 'GIF8') return { ext: 'gif', contentType: 'image/gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', contentType: 'image/webp' };
  if (ascii(4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(8, 12))) {
    return { ext: 'heic', contentType: 'image/heic' };
  }
  return null;
}

/** Whole request body cap: the image plus room for multipart headers and small fields. */
const MAX_PROFILE_BODY = MAX_PROFILE_IMAGE + 64 * 1024;

/** Errors the stream once more than `max` bytes have passed, so a chunked body without Content-Length is never read past the cap. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > max) throw new ImmichError(400, 'Profile image is too large');
        ctl.enqueue(chunk);
      },
    }),
  );
}

/** Streams the multipart body and keeps only the `file` part, stopping as soon as it passes MAX_PROFILE_IMAGE. */
async function readProfileImage(req: Request): Promise<Uint8Array> {
  if (!req.body) throw new ImmichError(400, 'file is required');
  let boundary: string;
  try {
    boundary = boundaryOf(req.headers.get('content-type'));
  } catch {
    throw new ImmichError(400, 'Expected multipart/form-data with a file field');
  }
  let image: Uint8Array | null = null;
  try {
    await parseMultipart(capped(req.body, MAX_PROFILE_BODY), boundary, {
      field: () => {},
      file: async (part) => {
        if (part.name !== 'file' || image) return; // other parts are drained by the parser, within the body cap
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = part.stream.getReader();
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.byteLength;
          if (size > MAX_PROFILE_IMAGE) {
            await reader.cancel();
            throw new ImmichError(400, 'Profile image is too large');
          }
          chunks.push(r.value);
        }
        image = new Uint8Array(size);
        let at = 0;
        for (const ch of chunks) {
          image.set(ch, at);
          at += ch.byteLength;
        }
      },
    });
  } catch (err) {
    if (err instanceof ImmichError) throw err;
    if (err instanceof MultipartError) throw new ImmichError(400, err.message);
    throw err;
  }
  if (!image) throw new ImmichError(400, 'file is required');
  return image;
}

meRoutes.post('/users/profile-image', requireAuth, async (c) => {
  const { user } = c.get('auth');
  if (Number(c.req.header('content-length') ?? 0) > MAX_PROFILE_BODY) throw new ImmichError(400, 'Profile image is too large');
  const bytes = await readProfileImage(c.req.raw);
  const type = sniffImage(bytes);
  if (!type) throw new ImmichError(400, 'Unable to process profile image');
  const key = `profile/${user.id}.${type.ext}`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type.contentType } });
  const now = new Date().toISOString();
  const updated = await updateUser(c.env.DB, user.id, { profile_image_path: key, profile_changed_at: now });
  if (user.profile_image_path && user.profile_image_path !== key) await c.env.MEDIA.delete(user.profile_image_path);
  return c.json({ userId: updated.id, profileImagePath: updated.profile_image_path, profileChangedAt: updated.profile_changed_at }, 201);
});

meRoutes.delete('/users/profile-image', requireAuth, async (c) => {
  const { user } = c.get('auth');
  if (user.profile_image_path === '') throw new ImmichError(400, "Can't delete a missing profile Image");
  await updateUser(c.env.DB, user.id, { profile_image_path: '', profile_changed_at: new Date().toISOString() });
  await c.env.MEDIA.delete(user.profile_image_path);
  return c.body(null, 204);
});

meRoutes.get('/users/:id', requireAuth, async (c) => {
  const u = await getUserById(c.env.DB, uuidPathParam(c));
  if (!u) throw new ImmichError(400, 'User not found');
  return c.json(mapUserShort(u));
});

meRoutes.get('/users/:id/profile-image', requireAuth, async (c) => {
  const u: UserRow | null = await getUserById(c.env.DB, uuidPathParam(c));
  const obj = u?.profile_image_path ? await c.env.MEDIA.get(u.profile_image_path) : null;
  if (!obj) throw new ImmichError(404, 'Not Found');
  // Stored as uploaded (EXIF is not stripped); nosniff keeps browsers to the sniffed-on-upload image type.
  // Immich sends no Cache-Control here; private/no-cache keeps shared caches from holding a replaced image.
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-length': String(obj.size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-cache, no-transform',
    },
  });
});
