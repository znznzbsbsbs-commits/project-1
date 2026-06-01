const { permissions } = require('./permissions');
const all = new Set([...permissions.safe, ...permissions.sensitive, ...permissions.critical]);
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Manifest must be an object');
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(String(manifest.id || ''))) throw new Error('Invalid extension id');
  for (const field of ['name', 'version', 'entry']) if (!manifest[field]) throw new Error(`Missing ${field}`);
  if (/^https?:\/\//i.test(manifest.entry) || String(manifest.entry).includes('..')) throw new Error('Entry must be a local package file');
  const requested = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const permission of requested) if (!all.has(permission)) throw new Error(`Unknown permission: ${permission}`);
  return { ...manifest, permissions: [...new Set(requested)] };
}
module.exports = { validateManifest };
