export const avatarExtensions = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

export function isValidAvatarFileHeader(type, size, bytes) {
  if (!Object.hasOwn(avatarExtensions, type) || !Number.isFinite(size) || size < 1 || size > 5 * 1024 * 1024) return false;
  if (!(bytes instanceof Uint8Array)) return false;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const isWebp = bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  return (type === 'image/jpeg' && isJpeg)
    || (type === 'image/png' && isPng)
    || (type === 'image/webp' && isWebp);
}

export function userAvatarPath(user) {
  const path = user?.user_metadata?.avatar_path;
  if (typeof user?.id !== 'string' || typeof path !== 'string') return null;
  const parts = path.split('/');
  if (parts.length !== 2 || parts[0] !== user.id || !parts[1] || parts[1] === '.' || parts[1] === '..' || path.includes('\\')) return null;
  return path;
}
