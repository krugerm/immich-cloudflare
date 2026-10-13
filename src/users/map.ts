import type { UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';

type AvatarColor = Dto<'UserAvatarColor'>;

// Same order as Immich's UserAvatarColor enum.
const AVATAR_COLORS: AvatarColor[] = ['primary', 'pink', 'red', 'yellow', 'blue', 'green', 'purple', 'orange', 'gray', 'amber'];

/** Port of emailToAvatarColor in immich server/src/dtos/user.dto.ts: sum of the email's code points modulo the colour count. */
export function emailToAvatarColor(email: string): AvatarColor {
  const sum = [...email].map((ch) => ch.codePointAt(0) ?? 0).reduce((a, b) => a + b, 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

export function mapUserAdmin(u: UserRow): Dto<'UserAdminResponseDto'> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.is_admin === 1,
    avatarColor: (u.avatar_color as AvatarColor | null) ?? emailToAvatarColor(u.email),
    profileImagePath: u.profile_image_path,
    profileChangedAt: u.profile_changed_at,
    shouldChangePassword: u.should_change_password === 1,
    storageLabel: u.storage_label,
    quotaSizeInBytes: u.quota_bytes,
    quotaUsageInBytes: u.usage_bytes,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    deletedAt: u.deleted_at,
    oauthId: '',
    status: u.status,
    license: u.license ? (JSON.parse(u.license) as Dto<'UserLicense'>) : null,
    clusterGroupId: u.id,
  };
}

export function mapSyncAuthUser(u: UserRow): Dto<'SyncAuthUserV2'> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.is_admin === 1,
    avatarColor: u.avatar_color as AvatarColor | null,
    deletedAt: u.deleted_at,
    hasProfileImage: u.profile_image_path !== '',
    profileChangedAt: u.profile_changed_at,
    oauthId: null,
    pinCode: u.pin_code,
    quotaSizeInBytes: u.quota_bytes,
    quotaUsageInBytes: u.usage_bytes,
    storageLabel: u.storage_label,
  };
}

export function mapSyncUser(u: UserRow): Dto<'SyncUserV1'> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarColor: u.avatar_color as AvatarColor | null,
    deletedAt: u.deleted_at,
    hasProfileImage: u.profile_image_path !== '',
    profileChangedAt: u.profile_changed_at,
  };
}
