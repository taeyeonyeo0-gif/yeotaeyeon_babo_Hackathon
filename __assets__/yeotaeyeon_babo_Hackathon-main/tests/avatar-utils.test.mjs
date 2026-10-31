import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidAvatarFileHeader, userAvatarPath } from '../avatar-utils.mjs';

test('avatar files require an allowed MIME type and matching image signature', () => {
  assert.equal(isValidAvatarFileHeader('image/jpeg', 12, Uint8Array.from([0xff, 0xd8, 0xff])), true);
  assert.equal(isValidAvatarFileHeader('image/png', 12, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
  assert.equal(isValidAvatarFileHeader('image/webp', 12, new TextEncoder().encode('RIFF0000WEBP')), true);
  assert.equal(isValidAvatarFileHeader('image/png', 12, Uint8Array.from([0xff, 0xd8, 0xff])), false);
  assert.equal(isValidAvatarFileHeader('image/svg+xml', 12, new TextEncoder().encode('<svg/>')), false);
});

test('avatar files enforce the five-megabyte limit and non-empty data', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff]);
  assert.equal(isValidAvatarFileHeader('image/jpeg', 0, jpeg), false);
  assert.equal(isValidAvatarFileHeader('image/jpeg', 5 * 1024 * 1024, jpeg), true);
  assert.equal(isValidAvatarFileHeader('image/jpeg', 5 * 1024 * 1024 + 1, jpeg), false);
});

test('avatar paths are restricted to the authenticated user folder', () => {
  const user = { id: 'user-1', user_metadata: { avatar_path: 'user-1/photo.webp' } };
  assert.equal(userAvatarPath(user), 'user-1/photo.webp');
  assert.equal(userAvatarPath({ ...user, user_metadata: { avatar_path: 'user-2/photo.webp' } }), null);
  assert.equal(userAvatarPath({ ...user, user_metadata: { avatar_path: 'user-1/../photo.webp' } }), null);
  assert.equal(userAvatarPath({ ...user, user_metadata: { avatar_path: 'user-1/photo.webp/extra' } }), null);
});
