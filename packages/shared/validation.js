function normalizeUsername(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32); }
function isStrongPassword(value) { return typeof value === 'string' && value.length >= 8 && /[0-9]/.test(value) && /[A-Za-z]/.test(value); }
module.exports = { normalizeUsername, isStrongPassword };
