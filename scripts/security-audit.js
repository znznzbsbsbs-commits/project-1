const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const textFiles = [
  'backend/gateway/src/server.js',
  'apps/web/public/app.js',
  'apps/web/public/extensions.js',
  'apps/web/public/legal.html',
  'apps/admin/public/app.js',
  'database/migrations/001_init.sql',
  '.env.example',
];
const requiredServerControls = [
  'contentSecurityPolicy',
  "app.disable('x-powered-by')",
  'ALLOWED_UPLOAD_MIME',
  'authLimiter',
  'wsLimiter',
  'verifyAccess',
  'verifyRefresh',
  'LEGAL_DOCUMENTS',
  'legal_acceptances',
  'LISTEN chat_events',
  'pg_notify',
  'app.use(\'/api\'',
];
const forbiddenPatterns = [
  { file: 'backend/gateway/src/server.js', pattern: /helmet\(\{\s*contentSecurityPolicy:\s*false/, message: 'CSP must not be disabled' },
  { file: 'apps/web/public/app.js', pattern: /[\u{1F300}-\u{1FAFF}]/u, message: 'Emoji glyphs are not allowed in the client; use inline SVG icons' },
  { file: 'backend/gateway/src/seed.js', pattern: /[\u{1F300}-\u{1FAFF}]/u, message: 'Seed data must not contain emoji glyphs' },
  { file: 'apps/admin/public/app.js', pattern: /<p>\$\{report\.reason\}|<b>\$\{user\.displayName\}|@\$\{user\.username\}/, message: 'Admin-rendered user content must be escaped before innerHTML' },
  { file: 'apps/web/public/app.js', pattern: /onclick="/, message: 'Inline event handlers are not allowed in the web client' },
  { file: 'apps/web/public/extensions.js', pattern: /require\(|child_process|from ['"]electron['"]|from ['"]fs['"]/, message: 'Extension host must not expose Node/Electron primitives' },
];

function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

for (const file of textFiles) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`${file} missing`);
}
const server = read('backend/gateway/src/server.js');
for (const control of requiredServerControls) {
  if (!server.includes(control)) throw new Error(`Security control missing: ${control}`);
}
for (const rule of forbiddenPatterns) {
  const content = read(rule.file);
  if (rule.pattern.test(content)) throw new Error(`${rule.file}: ${rule.message}`);
}
const appClient = read('apps/web/public/app.js');
if (!/name="acceptedLegal"[\s\S]{0,1200}required/.test(appClient)) throw new Error('Registration legal consent checkbox is required');
const legalHtml = read('apps/web/public/legal.html');
for (const section of ['Terms of Service', 'Privacy Policy', 'Call Policy', 'Extension Developer Policy']) {
  if (!legalHtml.includes(section)) throw new Error(`Legal document section missing: ${section}`);
}
for (const dir of ['auth','users','chats','messages','websocket','calls','notifications','uploads','search','moderation','extensions']) {
  const manifest = path.join(root, 'backend', dir, 'service.json');
  JSON.parse(fs.readFileSync(manifest, 'utf8'));
}
console.log('Security audit passed');
