export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_admin: number;
  is_onboarded: number;
  avatar_color: string | null;
  profile_changed_at: string;
  quota_bytes: number | null;
  usage_bytes: number;
  storage_label: string | null;
  preferences: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  update_id: string;
  // stream A (migration 0010)
  should_change_password: number;
  pin_code: string | null;
  /** R2 key of the profile image, or '' when there is none. */
  profile_image_path: string;
  status: 'active' | 'removing' | 'deleted';
  /** JSON {licenseKey, activationKey, activatedAt} or NULL. */
  license: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_sha256: string;
  device_type: string;
  device_os: string;
  reset_at: string | null;
  created_at: string;
  updated_at: string;
  // stream A (migration 0010)
  pin_expires_at: string | null;
  expires_at: string | null;
  parent_id: string | null;
  is_pending_sync_reset: number;
}

// stream A
export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_sha256: string;
  /** JSON array of Immich permission names. */
  permissions: string;
  created_at: string;
  updated_at: string;
}

export type AssetStatus = 'pending' | 'ready' | 'needs_media' | 'failed';

export interface AssetRow {
  id: string;
  owner_id: string;
  device_asset_id: string;
  device_id: string;
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'OTHER';
  original_path: string;
  original_file_name: string;
  checksum: string;
  file_created_at: string;
  file_modified_at: string;
  local_date_time: string;
  duration: number | null;
  is_favorite: number;
  visibility: 'archive' | 'timeline' | 'hidden' | 'locked';
  live_photo_video_id: string | null;
  thumbhash: string | null;
  width: number | null;
  height: number | null;
  file_size: number;
  status: AssetStatus;
  error: string | null;
  has_thumbnail: number;
  backed_up_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  update_id: string;
  stack_id: string | null; // stream E
  ml_at: string | null; // phase 4
  duplicate_id: string | null; // phase 4
  duplicates_checked_at: string | null; // phase 4
  faces_recognized_at: string | null; // phase 4
  ml_claim_at: string | null; // phase 4
}

export interface ExifRow {
  asset_id: string;
  owner_id: string;
  make: string | null;
  model: string | null;
  lens_model: string | null;
  exposure_time: string | null;
  f_number: number | null;
  focal_length: number | null;
  iso: number | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  date_time_original: string | null;
  modify_date: string | null;
  time_zone: string | null;
  orientation: string | null;
  rating: number | null;
  description: string | null;
  exif_image_width: number | null;
  exif_image_height: number | null;
  file_size_in_byte: number | null;
  profile_description: string | null;
  projection_type: string | null;
  fps: number | null;
  locked_properties: string | null;
  update_id: string;
}
