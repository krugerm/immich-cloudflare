-- avatar_color becomes nullable: NULL means "never set explicitly" (Immich derives a default from the email on REST reads).
-- ADD/DROP/RENAME COLUMN avoids rebuilding users, which other tables reference with ON DELETE CASCADE.
ALTER TABLE users ADD COLUMN avatar_color_next TEXT;
ALTER TABLE users DROP COLUMN avatar_color;
ALTER TABLE users RENAME COLUMN avatar_color_next TO avatar_color;
