const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const { v4: uuid } = require('uuid');
const { pool, query, transaction } = require('./db');
require('dotenv').config();

const PORT = Number(process.env.PORT || 8080);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me-32-characters';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me-32-characters';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'storage/uploads');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const STATIC_DIR = path.join(__dirname, '../../../apps/web/public');
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || PUBLIC_URL).split(',').map(origin => origin.trim()).filter(Boolean);
const MAX_WS_PAYLOAD_BYTES = Number(process.env.MAX_WS_PAYLOAD_BYTES || 8192);
const MAX_CHAT_CACHE_MS = Number(process.env.MAX_CHAT_CACHE_MS || 15000);
const ALLOWED_UPLOAD_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'audio/mpeg', 'audio/webm', 'application/pdf',
  'text/plain', 'application/zip', 'application/json',
]);
const LEGAL_VERSION = process.env.LEGAL_VERSION || '2026-06-01';
const LEGAL_DOCUMENTS = Object.freeze({
  version: LEGAL_VERSION,
  termsVersion: LEGAL_VERSION,
  privacyVersion: LEGAL_VERSION,
  callPolicyVersion: LEGAL_VERSION,
  developerPolicyVersion: LEGAL_VERSION,
  termsUrl: '/legal.html#terms',
  privacyUrl: '/legal.html#privacy',
  callPolicyUrl: '/legal.html#calls',
  developerPolicyUrl: '/legal.html#developers',
});

if (IS_PRODUCTION && (ACCESS_SECRET.startsWith('dev-') || REFRESH_SECRET.startsWith('dev-'))) {
  throw new Error('Production requires strong JWT_ACCESS_SECRET and JWT_REFRESH_SECRET values');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;

const limiter = new RateLimiterMemory({ points: Number(process.env.RATE_LIMIT_POINTS || 600), duration: 60 });
const authLimiter = new RateLimiterMemory({ points: Number(process.env.AUTH_RATE_LIMIT_POINTS || 20), duration: 60 });
const wsLimiter = new RateLimiterMemory({ points: Number(process.env.WS_RATE_LIMIT_POINTS || 120), duration: 10 });
const sockets = new Map();
const chatMembersCache = new Map();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", 'data:', 'blob:'],
      "media-src": ["'self'", 'blob:'],
      "connect-src": ["'self'", 'ws:', 'wss:'],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
}));
app.use(compression({ threshold: 1024 }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || (!IS_PRODUCTION && /^https?:\/\/localhost(:\d+)?$/.test(origin))) return callback(null, true);
    return callback(new Error('CORS origin denied'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb', strict: true }));
app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false, immutable: true, maxAge: '7d', index: false }));
app.use('/admin', express.static(path.join(__dirname, '../../../apps/admin/public'), { immutable: true, maxAge: '1h', etag: true }));
app.use(express.static(STATIC_DIR, { immutable: true, maxAge: '1h', etag: true }));
app.use(async (req, res, next) => {
  try { await limiter.consume(req.ip); next(); } catch { res.status(429).json({ error: 'Слишком много запросов' }); }
});

function cleanText(value, max = 2000) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function normalizeUsername(value) {
  return cleanText(value, 32).toLowerCase().replace(/[^a-z0-9_]/g, '');
}
function normalizeEmail(value) {
  return cleanText(value, 254).toLowerCase();
}
function isStrongPassword(value) {
  return typeof value === 'string' && value.length >= 10 && /[A-Za-z]/.test(value) && /\d/.test(value);
}
function parseLimit(value, fallback = 50, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
function rtcConfig() {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return { iceServers };
}
async function callParticipantRows(callId) {
  const result = await query(`SELECT cp.*,u.username,p.display_name,p.avatar_url
    FROM call_participants cp
    JOIN users u ON u.id=cp.user_id
    JOIN profiles p ON p.user_id=u.id
    WHERE cp.call_id=$1
    ORDER BY CASE cp.status WHEN 'joined' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END, p.display_name`, [callId]);
  return result.rows;
}

const EXTENSION_PERMISSIONS = new Set(['ui','commands','events','storage','notifications','theme','network','voice','video','call-events','microphone','camera','screenshare','filesystem','desktop','admin']);
const SENSITIVE_EXTENSION_PERMISSIONS = new Set(['network','voice','video','call-events']);
const CRITICAL_EXTENSION_PERMISSIONS = new Set(['microphone','camera','screenshare','filesystem','desktop','admin']);
function sanitizeExtensionManifest(raw) {
  const manifest = raw && typeof raw === 'object' ? raw : {};
  const id = cleanText(manifest.id, 64).toLowerCase();
  const entry = cleanText(manifest.entry || 'index.js', 160);
  const permissions = Array.isArray(manifest.permissions) ? [...new Set(manifest.permissions.map(item => cleanText(item, 40)).filter(Boolean))] : [];
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error('Некорректный id расширения');
  if (!manifest.name || !manifest.version || !entry || /^https?:\/\//i.test(entry) || entry.includes('..')) throw new Error('Некорректный manifest расширения');
  if (permissions.some(permission => !EXTENSION_PERMISSIONS.has(permission))) throw new Error('Manifest содержит неизвестные разрешения');
  return {
    id,
    name: cleanText(manifest.name, 80),
    version: cleanText(manifest.version, 40),
    author: cleanText(manifest.author || 'Unknown', 80),
    trust: ['official','verified','community'].includes(manifest.trust) ? manifest.trust : 'community',
    category: cleanText(manifest.category || 'Plugins', 60),
    description: cleanText(manifest.description || '', 500),
    permissions,
    entry,
  };
}
function extensionRiskLevel(permissions = []) {
  if (permissions.some(permission => CRITICAL_EXTENSION_PERMISSIONS.has(permission))) return 'critical';
  if (permissions.some(permission => SENSITIVE_EXTENSION_PERMISSIONS.has(permission))) return 'sensitive';
  return 'safe';
}
async function recordExtensionHistory(userId, extensionId, action, manifest = {}, snapshot = {}) {
  await query('INSERT INTO extension_history(user_id,extension_id,version,action,snapshot) VALUES($1,$2,$3,$4,$5)', [userId, extensionId, cleanText(manifest.version || '', 40), action, snapshot]);
}

function signAccess(user) { return jwt.sign({ sub: user.id, role: user.role, username: user.username }, ACCESS_SECRET, { expiresIn: '15m', algorithm: 'HS256', issuer: 'liquid-messenger' }); }
function signRefresh(user) { return jwt.sign({ sub: user.id, jti: uuid() }, REFRESH_SECRET, { expiresIn: '30d', algorithm: 'HS256', issuer: 'liquid-messenger' }); }
function verifyAccess(token) { return jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'liquid-messenger' }); }
function verifyRefresh(token) { return jwt.verify(token, REFRESH_SECRET, { algorithms: ['HS256'], issuer: 'liquid-messenger' }); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function safeUser(row) { return row && { id: row.id, username: row.username, role: row.role, status: row.status, lastSeen: row.last_seen, displayName: row.display_name, avatarUrl: row.avatar_url, bio: row.bio, privacy: row.privacy, settings: row.settings }; }
function pickUser(row) { return safeUser(row); }
async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нужна авторизация' });
  try {
    const payload = verifyAccess(token);
    const user = await query('SELECT u.*, p.display_name, p.avatar_url, p.bio, p.privacy, p.settings FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1', [payload.sub]);
    if (!user.rows[0]) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = user.rows[0];
    next();
  } catch { res.status(401).json({ error: 'Токен недействителен' }); }
}
function requireAdmin(req, res, next) { return req.user.role === 'admin' || req.user.role === 'moderator' ? next() : res.status(403).json({ error: 'Нет прав' }); }
async function isMember(userId, chatId) { const r = await query('SELECT 1 FROM chat_members WHERE user_id=$1 AND chat_id=$2', [userId, chatId]); return r.rowCount > 0; }
async function getChatMembers(chatId) {
  const cached = chatMembersCache.get(chatId);
  if (cached && cached.expires > Date.now()) return cached.members;
  const result = await query('SELECT user_id FROM chat_members WHERE chat_id=$1', [chatId]);
  const members = result.rows.map(row => row.user_id);
  chatMembersCache.set(chatId, { members, expires: Date.now() + MAX_CHAT_CACHE_MS });
  return members;
}
function invalidateChatMembers(chatId) { chatMembersCache.delete(chatId); }
function sendPreparedToUser(userId, payload) {
  for (const ws of sockets.get(userId) || []) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(payload);
  }
}
function sendToUser(userId, event, data) { sendPreparedToUser(userId, JSON.stringify({ event, data })); }
async function notify(userId, type, title, body, payload = {}) {
  const r = await query('INSERT INTO notifications(user_id,type,title,body,payload) VALUES($1,$2,$3,$4,$5) RETURNING *', [userId, cleanText(type, 40), cleanText(title, 120), cleanText(body, 500), payload]);
  await query('SELECT pg_notify($1, $2)', ['user_events', JSON.stringify({ userId, event: 'notification', data: r.rows[0] })]);
  return r.rows[0];
}
async function deliverChatEvent(chatId, event, data) {
  const payload = JSON.stringify({ event, data });
  const members = await getChatMembers(chatId);
  members.forEach(userId => sendPreparedToUser(userId, payload));
}
async function broadcastChat(chatId, event, data) {
  await query('SELECT pg_notify($1, $2)', ['chat_events', JSON.stringify({ chatId, event, data })]);
}
async function startRealtimeBus() {
  const client = await pool.connect();
  client.on('notification', notification => {
    try {
      const message = JSON.parse(notification.payload);
      if (notification.channel === 'chat_events') deliverChatEvent(message.chatId, message.event, message.data).catch(console.error);
      if (notification.channel === 'user_events') sendToUser(message.userId, message.event, message.data);
    } catch (error) {
      console.error('Invalid realtime event', error);
    }
  });
  client.on('error', error => console.error('Realtime bus error', error));
  await client.query('LISTEN chat_events');
  await client.query('LISTEN user_events');
}

app.get('/api/health', async (_req, res) => { await query('SELECT 1'); res.json({ ok: true, service: 'liquid-messenger', time: new Date().toISOString() }); });
app.get('/api/legal/current', (_req, res) => res.json(LEGAL_DOCUMENTS));
app.post('/api/auth/register', async (req, res) => {
  try { await authLimiter.consume(req.ip); } catch { return res.status(429).json({ error: 'Слишком много попыток регистрации' }); }
  const username = normalizeUsername(req.body.username);
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  const acceptedLegal = req.body.acceptedLegal === true || req.body.acceptedLegal === 'true' || req.body.acceptedLegal === 'on';
  const displayName = cleanText(req.body.displayName || username, 80);
  if (!acceptedLegal) return res.status(400).json({ error: 'Нужно принять Terms of Service, Privacy Policy, Call Policy и Extension Developer Policy' });
  if (!username || username.length < 3 || !email.includes('@') || !isStrongPassword(password)) return res.status(400).json({ error: 'Введите username, email и пароль от 10 символов с буквами и цифрами' });
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const user = await transaction(async c => {
      const u = await c.query('INSERT INTO users(username,email,password_hash) VALUES($1,lower($2),$3) RETURNING *', [username, email, passwordHash]);
      await c.query('INSERT INTO profiles(user_id,display_name) VALUES($1,$2)', [u.rows[0].id, displayName]);
      await c.query('INSERT INTO legal_acceptances(user_id,terms_version,privacy_version,call_policy_version,developer_policy_version,ip_address,user_agent,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [u.rows[0].id, LEGAL_DOCUMENTS.termsVersion, LEGAL_DOCUMENTS.privacyVersion, LEGAL_DOCUMENTS.callPolicyVersion, LEGAL_DOCUMENTS.developerPolicyVersion, cleanText(req.ip, 80), cleanText(req.headers['user-agent'], 300), { acceptedLegal: true, acceptedAt: new Date().toISOString() }]);
      return u.rows[0];
    });
    const refreshToken = signRefresh(user);
    await query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [user.id, hashToken(refreshToken)]);
    res.status(201).json({ accessToken: signAccess(user), refreshToken, user: pickUser({ ...user, display_name: displayName, bio: '', privacy: {}, settings: {} }) });
  } catch (e) { res.status(409).json({ error: 'Username или email уже занят' }); }
});
app.post('/api/auth/login', async (req, res) => {
  try { await authLimiter.consume(req.ip); } catch { return res.status(429).json({ error: 'Слишком много попыток входа' }); }
  const login = cleanText(req.body.login, 254).toLowerCase();
  const { password } = req.body;
  const r = await query('SELECT u.*, p.display_name, p.avatar_url, p.bio, p.privacy, p.settings FROM users u JOIN profiles p ON p.user_id=u.id WHERE lower(u.email)=$1 OR lower(u.username)=$1', [login]);
  const user = r.rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const refreshToken = signRefresh(user);
  await query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [user.id, hashToken(refreshToken)]);
  await query("UPDATE users SET status='online', last_seen=now() WHERE id=$1", [user.id]);
  res.json({ accessToken: signAccess(user), refreshToken, user: pickUser(user) });
});
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body; const p = verifyRefresh(refreshToken);
    const token = await query('SELECT * FROM refresh_tokens WHERE user_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>now()', [p.sub, hashToken(refreshToken)]);
    if (!token.rows[0]) return res.status(401).json({ error: 'Refresh token недействителен' });
    const u = await query('SELECT * FROM users WHERE id=$1', [p.sub]);
    res.json({ accessToken: signAccess(u.rows[0]) });
  } catch { res.status(401).json({ error: 'Refresh token недействителен' }); }
});
app.post('/api/auth/logout', auth, async (req, res) => { await query("UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [req.user.id]); await query("UPDATE users SET status='offline', last_seen=now() WHERE id=$1", [req.user.id]); res.json({ ok: true }); });
app.post('/api/auth/forgot-password', async (req, res) => {
  try { await authLimiter.consume(req.ip); } catch { return res.status(429).json({ error: 'Слишком много запросов восстановления' }); }
  const u = await query('SELECT id FROM users WHERE lower(email)=$1', [normalizeEmail(req.body.email)]);
  if (u.rows[0]) {
    const token = crypto.randomBytes(32).toString('hex');
    await query("INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [u.rows[0].id, hashToken(token)]);
    return res.json({ ok: true, ...(IS_PRODUCTION ? {} : { resetToken: token }) });
  }
  res.json({ ok: true });
});
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body; if (!token || !isStrongPassword(password)) return res.status(400).json({ error: 'Неверные данные' });
  const r = await query('SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()', [hashToken(token)]);
  if (!r.rows[0]) return res.status(400).json({ error: 'Токен недействителен' });
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 12), r.rows[0].user_id]);
  await query('UPDATE password_resets SET used_at=now() WHERE id=$1', [r.rows[0].id]);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: pickUser(req.user) }));
app.patch('/api/me/profile', auth, async (req, res) => {
  const displayName = req.body.displayName === undefined ? undefined : cleanText(req.body.displayName, 80);
  const bio = req.body.bio === undefined ? undefined : cleanText(req.body.bio, 500);
  const privacy = req.body.privacy && typeof req.body.privacy === 'object' ? req.body.privacy : undefined;
  const settings = req.body.settings && typeof req.body.settings === 'object' ? req.body.settings : undefined;
  const r = await query('UPDATE profiles SET display_name=COALESCE($2,display_name), bio=COALESCE($3,bio), privacy=COALESCE($4,privacy), settings=COALESCE($5,settings), updated_at=now() WHERE user_id=$1 RETURNING *', [req.user.id, displayName, bio, privacy, settings]);
  res.json({ profile: r.rows[0] });
});
async function searchUsers(req, res) {
  const term = cleanText(req.query.q, 64).toLowerCase();
  const limit = parseLimit(req.query.limit, 25, 50);
  if (term.length < 2) return res.json({ users: [] });
  const r = await query(`
    SELECT u.id,u.username,u.role,u.status,u.last_seen,p.display_name,p.avatar_url,p.bio
    FROM users u
    JOIN profiles p ON p.user_id=u.id
    WHERE u.id<>$1 AND (lower(u.username) LIKE $2 OR lower(p.display_name) LIKE $2 OR lower(u.email)=$3)
    ORDER BY CASE WHEN lower(u.username) LIKE $4 THEN 0 ELSE 1 END, u.status DESC, u.username
    LIMIT $5`, [req.user.id, `${term}%`, term, `${term}%`, limit]);
  res.json({ users: r.rows.map(safeUser) });
}
app.get('/api/users/search', auth, searchUsers);
app.get('/api/search/users', auth, searchUsers);
app.get('/api/contacts', auth, async (req, res) => {
  const r = await query('SELECT c.*, u.username,u.status,u.last_seen,p.display_name,p.avatar_url,p.bio FROM contacts c JOIN users u ON u.id=c.contact_id JOIN profiles p ON p.user_id=u.id WHERE c.owner_id=$1 ORDER BY p.display_name', [req.user.id]);
  res.json({ contacts: r.rows.map(row => ({ ...pickUser(row), alias: row.alias, blocked: row.blocked })) });
});
app.post('/api/contacts/:id', auth, async (req, res) => { await query('INSERT INTO contacts(owner_id,contact_id,alias) VALUES($1,$2,$3) ON CONFLICT(owner_id,contact_id) DO UPDATE SET alias=EXCLUDED.alias, blocked=false', [req.user.id, req.params.id, req.body.alias ? cleanText(req.body.alias, 80) : null]); res.status(201).json({ ok: true }); });
app.post('/api/contacts/:id/block', auth, async (req, res) => { await query('INSERT INTO contacts(owner_id,contact_id,blocked) VALUES($1,$2,true) ON CONFLICT(owner_id,contact_id) DO UPDATE SET blocked=true', [req.user.id, req.params.id]); res.json({ ok: true }); });

app.get('/api/chats', auth, async (req, res) => {
  const r = await query(`SELECT c.*, (SELECT body FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) last_message FROM chats c JOIN chat_members cm ON cm.chat_id=c.id WHERE cm.user_id=$1 ORDER BY c.updated_at DESC`, [req.user.id]);
  res.json({ chats: r.rows });
});
app.post('/api/chats', auth, async (req, res) => {
  const type = req.body.type || 'private';
  const title = cleanText(req.body.title, 120);
  const description = cleanText(req.body.description, 1000);
  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds.map(id => cleanText(id, 64)).filter(Boolean).slice(0, 500) : [];
  if (memberIds.some(id => !isUuid(id))) return res.status(400).json({ error: 'Некорректный ID участника' });
  if (!['private','group','channel'].includes(type)) return res.status(400).json({ error: 'Неверный тип чата' });
  if ((type === 'group' || type === 'channel') && !title) return res.status(400).json({ error: 'Для группы или канала нужно название' });
  if (type === 'private' && memberIds.length !== 1) return res.status(400).json({ error: 'Личный чат создаётся ровно с одним участником' });
  if (type === 'group' && memberIds.length < 1) return res.status(400).json({ error: 'Для группы выберите хотя бы одного участника' });
  const validUsers = memberIds.length ? await query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [memberIds]) : { rows: [] };
  if (validUsers.rows.length !== new Set(memberIds).size) return res.status(400).json({ error: 'Один или несколько пользователей не найдены' });
  const members = [...new Set([req.user.id, ...memberIds])];
  const chat = await transaction(async c => {
    const cr = await c.query('INSERT INTO chats(type,title,description,owner_id) VALUES($1,$2,$3,$4) RETURNING *', [type, title || (type === 'private' ? null : 'Новый чат'), description, req.user.id]);
    for (const id of members) await c.query('INSERT INTO chat_members(chat_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [cr.rows[0].id, id, id === req.user.id ? 'owner' : (type === 'channel' ? 'subscriber' : 'member')]);
    return cr.rows[0];
  });
  invalidateChatMembers(chat.id);
  members.filter(id => id !== req.user.id).forEach(id => notify(id, 'chat_invite', 'Новый чат', title || req.user.username, { chatId: chat.id }));
  res.status(201).json({ chat });
});
app.get('/api/chats/:id/messages', auth, async (req, res) => {
  if (!(await isMember(req.user.id, req.params.id))) return res.status(403).json({ error: 'Нет доступа' });
  const limit = parseLimit(req.query.limit, 80, 200);
  const before = req.query.before ? new Date(req.query.before) : null;
  const beforeIso = before && !Number.isNaN(before.valueOf()) ? before.toISOString() : null;
  const r = await query(`SELECT * FROM (
    SELECT m.*, u.username, p.display_name, COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL),'[]') attachments
    FROM messages m
    JOIN users u ON u.id=m.sender_id
    JOIN profiles p ON p.user_id=u.id
    LEFT JOIN attachments a ON a.message_id=m.id
    WHERE m.chat_id=$1 AND m.deleted_at IS NULL AND ($2::timestamptz IS NULL OR m.created_at < $2)
    GROUP BY m.id,u.username,p.display_name
    ORDER BY m.created_at DESC
    LIMIT $3
  ) page ORDER BY created_at ASC`, [req.params.id, beforeIso, limit]);
  res.json({ messages: r.rows });
});
app.post('/api/chats/:id/messages', auth, async (req, res) => {
  if (!(await isMember(req.user.id, req.params.id))) return res.status(403).json({ error: 'Нет доступа' });
  const body = cleanText(req.body.body, 4000);
  const { replyTo, threadRoot } = req.body;
  if (!body) return res.status(400).json({ error: 'Пустое сообщение' });
  const r = await query('INSERT INTO messages(chat_id,sender_id,body,reply_to,thread_root) VALUES($1,$2,$3,$4,$5) RETURNING *', [req.params.id, req.user.id, body, replyTo || null, threadRoot || null]);
  await query('UPDATE chats SET updated_at=now() WHERE id=$1', [req.params.id]);
  await broadcastChat(req.params.id, 'message:new', { ...r.rows[0], username: req.user.username, display_name: req.user.display_name });
  const members = await query('SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id<>$2', [req.params.id, req.user.id]);
  members.rows.forEach(m => notify(m.user_id, 'message', req.user.display_name, body.slice(0, 120), { chatId: req.params.id, messageId: r.rows[0].id }));
  res.status(201).json({ message: r.rows[0] });
});
app.patch('/api/messages/:id', auth, async (req, res) => {
  const body = cleanText(req.body.body, 4000);
  if (!body) return res.status(400).json({ error: 'Пустое сообщение' });
  const r = await query('UPDATE messages SET body=$2, edited_at=now() WHERE id=$1 AND sender_id=$3 AND deleted_at IS NULL RETURNING *', [req.params.id, body, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Сообщение не найдено' });
  await broadcastChat(r.rows[0].chat_id, 'message:edited', r.rows[0]); res.json({ message: r.rows[0] });
});
app.delete('/api/messages/:id', auth, async (req, res) => {
  const r = await query('UPDATE messages SET deleted_at=now() WHERE id=$1 AND sender_id=$2 RETURNING *', [req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Сообщение не найдено' });
  await broadcastChat(r.rows[0].chat_id, 'message:deleted', { id: req.params.id }); res.json({ ok: true });
});
app.post('/api/messages/:id/reactions', auth, async (req, res) => { const r = await query('INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *', [req.params.id, req.user.id, cleanText(req.body.emoji || 'like', 16)]); res.status(201).json({ reaction: r.rows[0] }); });
app.post('/api/messages/:id/pin', auth, async (req, res) => { const r = await query('UPDATE messages SET pinned=NOT pinned WHERE id=$1 AND chat_id IN (SELECT chat_id FROM chat_members WHERE user_id=$2 AND role IN (\'owner\',\'admin\')) RETURNING *', [req.params.id, req.user.id]); res.json({ message: r.rows[0] }); });

app.get('/api/chats/:id/members', auth, async (req, res) => {
  if (!(await isMember(req.user.id, req.params.id))) return res.status(403).json({ error: 'Нет доступа' });
  const r = await query('SELECT cm.chat_id,cm.user_id,cm.role,cm.muted_until,cm.joined_at,u.username,u.status,p.display_name,p.avatar_url FROM chat_members cm JOIN users u ON u.id=cm.user_id JOIN profiles p ON p.user_id=u.id WHERE cm.chat_id=$1 ORDER BY cm.role, p.display_name', [req.params.id]);
  res.json({ members: r.rows });
});
app.post('/api/chats/:id/members', auth, async (req, res) => {
  const owner = await query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2 AND role IN ('owner','admin')", [req.params.id, req.user.id]);
  if (!owner.rows[0]) return res.status(403).json({ error: 'Только администратор чата может добавлять участников' });
  const role = ['admin','member','subscriber'].includes(req.body.role) ? req.body.role : 'member';
  const ids = (Array.isArray(req.body.userIds) ? req.body.userIds : [req.body.userId]).filter(Boolean).slice(0, 500);
  for (const id of ids) {
    await query('INSERT INTO chat_members(chat_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(chat_id,user_id) DO UPDATE SET role=EXCLUDED.role', [req.params.id, id, role]);
    await notify(id, 'chat_invite', 'Вас добавили в чат', cleanText(req.body.title, 120) || 'Откройте Liquid Messenger', { chatId: req.params.id });
  }
  invalidateChatMembers(req.params.id);
  await broadcastChat(req.params.id, 'chat:members_changed', { chatId: req.params.id });
  res.status(201).json({ ok: true, added: ids.length });
});
app.patch('/api/chats/:id/members/:userId', auth, async (req, res) => {
  const owner = await query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2 AND role IN ('owner','admin')", [req.params.id, req.user.id]);
  if (!owner.rows[0]) return res.status(403).json({ error: 'Нет прав управления участниками' });
  const role = ['owner','admin','member','subscriber'].includes(req.body.role) ? req.body.role : null;
  const r = await query('UPDATE chat_members SET role=COALESCE($3,role), muted_until=$4 WHERE chat_id=$1 AND user_id=$2 RETURNING *', [req.params.id, req.params.userId, role, req.body.mutedUntil || null]);
  invalidateChatMembers(req.params.id);
  await broadcastChat(req.params.id, 'chat:members_changed', { chatId: req.params.id });
  res.json({ member: r.rows[0] });
});
app.delete('/api/chats/:id/members/:userId', auth, async (req, res) => {
  const owner = await query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2 AND role IN ('owner','admin')", [req.params.id, req.user.id]);
  if (!owner.rows[0] && req.user.id !== req.params.userId) return res.status(403).json({ error: 'Нет прав удалить участника' });
  await query('DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
  invalidateChatMembers(req.params.id);
  await broadcastChat(req.params.id, 'chat:members_changed', { chatId: req.params.id });
  res.json({ ok: true });
});
app.post('/api/chats/:id/read', auth, async (req, res) => {
  if (!(await isMember(req.user.id, req.params.id))) return res.status(403).json({ error: 'Нет доступа' });
  await query(`INSERT INTO message_receipts(message_id,user_id,delivered_at,read_at)
    SELECT id,$2,now(),now() FROM messages WHERE chat_id=$1 AND sender_id<>$2 AND deleted_at IS NULL
    ON CONFLICT(message_id,user_id) DO UPDATE SET delivered_at=COALESCE(message_receipts.delivered_at,now()), read_at=now()`, [req.params.id, req.user.id]);
  await broadcastChat(req.params.id, 'chat:read', { chatId: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});
app.post('/api/messages/:id/attachments/:attachmentId', auth, async (req, res) => {
  const message = await query('SELECT * FROM messages WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL', [req.params.id, req.user.id]);
  if (!message.rows[0]) return res.status(404).json({ error: 'Сообщение не найдено' });
  const r = await query('UPDATE attachments SET message_id=$1 WHERE id=$2 AND uploader_id=$3 RETURNING *', [req.params.id, req.params.attachmentId, req.user.id]);
  await broadcastChat(message.rows[0].chat_id, 'message:attachment', { messageId: req.params.id, attachment: r.rows[0] });
  res.json({ attachment: r.rows[0] });
});
app.get('/api/messages/:id/receipts', auth, async (req, res) => {
  const msg = await query('SELECT chat_id FROM messages WHERE id=$1', [req.params.id]);
  if (!msg.rows[0] || !(await isMember(req.user.id, msg.rows[0].chat_id))) return res.status(403).json({ error: 'Нет доступа' });
  const r = await query('SELECT mr.*, u.username, p.display_name FROM message_receipts mr JOIN users u ON u.id=mr.user_id JOIN profiles p ON p.user_id=u.id WHERE mr.message_id=$1', [req.params.id]);
  res.json({ receipts: r.rows });
});
app.post('/api/messages/:id/save', auth, async (req, res) => {
  const msg = await query('SELECT chat_id FROM messages WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  if (!msg.rows[0] || !(await isMember(req.user.id, msg.rows[0].chat_id))) return res.status(403).json({ error: 'Нет доступа' });
  const r = await query('INSERT INTO saved_messages(user_id,message_id,note) VALUES($1,$2,$3) ON CONFLICT(user_id,message_id) DO UPDATE SET note=EXCLUDED.note RETURNING *', [req.user.id, req.params.id, cleanText(req.body.note, 500)]);
  res.status(201).json({ saved: r.rows[0] });
});
app.get('/api/saved-messages', auth, async (req, res) => {
  const r = await query('SELECT sm.note,sm.created_at saved_at,m.*,u.username,p.display_name FROM saved_messages sm JOIN messages m ON m.id=sm.message_id JOIN users u ON u.id=m.sender_id JOIN profiles p ON p.user_id=u.id WHERE sm.user_id=$1 AND m.deleted_at IS NULL ORDER BY sm.created_at DESC', [req.user.id]);
  res.json({ messages: r.rows });
});
app.delete('/api/messages/:id/save', auth, async (req, res) => {
  await query('DELETE FROM saved_messages WHERE user_id=$1 AND message_id=$2', [req.user.id, req.params.id]);
  res.json({ ok: true });
});
app.post('/api/devices', auth, async (req, res) => {
  const r = await query('INSERT INTO user_devices(user_id,name,user_agent,ip_address) VALUES($1,$2,$3,$4) RETURNING *', [req.user.id, cleanText(req.body.name || 'Web browser', 80), cleanText(req.headers['user-agent'], 300), req.ip]);
  res.status(201).json({ device: r.rows[0] });
});
app.get('/api/devices', auth, async (req, res) => {
  const r = await query('SELECT * FROM user_devices WHERE user_id=$1 ORDER BY last_seen DESC', [req.user.id]);
  res.json({ devices: r.rows });
});
app.delete('/api/devices/:id', auth, async (req, res) => {
  await query('DELETE FROM user_devices WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});
app.post('/api/push-subscriptions', auth, async (req, res) => {
  const { endpoint, keys = {} } = req.body;
  if (!/^https:\/\//.test(endpoint || '') || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'Неверная push-подписка' });
  const r = await query('INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth RETURNING *', [req.user.id, cleanText(endpoint, 500), cleanText(keys.p256dh, 200), cleanText(keys.auth, 200)]);
  res.status(201).json({ subscription: r.rows[0] });
});
app.delete('/api/push-subscriptions/:id', auth, async (req, res) => {
  await query('DELETE FROM push_subscriptions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});
app.get('/api/search/messages', auth, async (req, res) => { const r = await query("SELECT m.* FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id WHERE cm.user_id=$1 AND m.deleted_at IS NULL AND to_tsvector('simple', m.body) @@ plainto_tsquery('simple', $2) LIMIT 50", [req.user.id, cleanText(req.query.q, 120)]); res.json({ messages: r.rows }); });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${uuid()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(ALLOWED_UPLOAD_MIME.has(file.mimetype) ? null : new Error('Недопустимый тип файла'), ALLOWED_UPLOAD_MIME.has(file.mimetype)),
});
app.post('/api/uploads', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const kind = ['image','video','audio','document','voice','avatar'].includes(req.body.kind) ? req.body.kind : 'document';
  const publicUrl = `${PUBLIC_URL}/uploads/${req.file.filename}`;
  const r = await query('INSERT INTO attachments(uploader_id,kind,original_name,mime_type,size_bytes,storage_path,public_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.user.id, kind, cleanText(req.file.originalname, 180), req.file.mimetype, req.file.size, req.file.path, publicUrl]);
  res.status(201).json({ attachment: r.rows[0] });
});
app.get('/api/notifications', auth, async (req, res) => { const r = await query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]); res.json({ notifications: r.rows }); });
app.post('/api/notifications/read', auth, async (req, res) => { await query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]); res.json({ ok: true }); });

app.get('/api/extensions', auth, async (req, res) => {
  const marketplace = await query("SELECT id,manifest,trust,category,publisher,rating,downloads,package_url,signature,status FROM extension_marketplace WHERE status='active' ORDER BY trust, category, id");
  const installed = await query('SELECT extension_id,manifest,enabled,installed_at,updated_at FROM user_extensions WHERE user_id=$1 ORDER BY installed_at DESC', [req.user.id]);
  res.json({
    marketplace: marketplace.rows.map(row => { const manifest = sanitizeExtensionManifest(row.manifest); return { ...row, manifest, risk: extensionRiskLevel(manifest.permissions) }; }),
    installed: installed.rows.map(row => { const manifest = sanitizeExtensionManifest(row.manifest); return { ...row, id: row.extension_id, manifest, risk: extensionRiskLevel(manifest.permissions) }; }),
    safeMode: Boolean(req.user.settings?.extensionsSafeMode),
  });
});
app.get('/api/extensions/history', auth, async (req, res) => {
  const r = await query('SELECT * FROM extension_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  res.json({ history: r.rows });
});
app.get('/api/extensions/:id', auth, async (req, res) => {
  const r = await query('SELECT * FROM extension_marketplace WHERE id=$1 AND status=$2', [cleanText(req.params.id, 64), 'active']);
  if (!r.rows[0]) return res.status(404).json({ error: 'Расширение не найдено' });
  const manifest = sanitizeExtensionManifest(r.rows[0].manifest);
  res.json({ extension: { ...r.rows[0], manifest, risk: extensionRiskLevel(manifest.permissions) } });
});
app.post('/api/extensions/install/:id', auth, async (req, res) => {
  const id = cleanText(req.params.id, 64).toLowerCase();
  const r = await query("SELECT * FROM extension_marketplace WHERE id=$1 AND status='active'", [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Расширение не найдено' });
  const manifest = sanitizeExtensionManifest(r.rows[0].manifest);
  const confirmed = new Set(Array.isArray(req.body.confirmedPermissions) ? req.body.confirmedPermissions : []);
  if (manifest.permissions.some(permission => !confirmed.has(permission))) return res.status(400).json({ error: 'Нужно подтвердить все разрешения расширения' });
  await query('INSERT INTO user_extensions(user_id,extension_id,manifest,enabled) VALUES($1,$2,$3,true) ON CONFLICT(user_id,extension_id) DO UPDATE SET manifest=EXCLUDED.manifest, enabled=true, updated_at=now()', [req.user.id, id, manifest]);
  await query('UPDATE extension_marketplace SET downloads=downloads+1 WHERE id=$1', [id]);
  await recordExtensionHistory(req.user.id, id, 'install', manifest, { risk: extensionRiskLevel(manifest.permissions), permissions: manifest.permissions });
  res.status(201).json({ extension: { id, manifest, enabled: true, risk: extensionRiskLevel(manifest.permissions) } });
});
app.post('/api/extensions/update/:id', auth, async (req, res) => {
  const id = cleanText(req.params.id, 64).toLowerCase();
  const r = await query("SELECT * FROM extension_marketplace WHERE id=$1 AND status='active'", [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Расширение не найдено' });
  const installed = await query('SELECT manifest FROM user_extensions WHERE user_id=$1 AND extension_id=$2', [req.user.id, id]);
  if (!installed.rows[0]) return res.status(404).json({ error: 'Расширение не установлено' });
  const manifest = sanitizeExtensionManifest(r.rows[0].manifest);
  await query('UPDATE user_extensions SET manifest=$3, updated_at=now() WHERE user_id=$1 AND extension_id=$2', [req.user.id, id, manifest]);
  await recordExtensionHistory(req.user.id, id, 'update', manifest, { previousVersion: installed.rows[0].manifest?.version || '', risk: extensionRiskLevel(manifest.permissions) });
  res.json({ extension: { id, manifest, enabled: true, risk: extensionRiskLevel(manifest.permissions) } });
});
app.post('/api/extensions/:id/enable', auth, async (req, res) => {
  const id = cleanText(req.params.id, 64).toLowerCase();
  const r = await query('UPDATE user_extensions SET enabled=true, updated_at=now() WHERE user_id=$1 AND extension_id=$2 RETURNING *', [req.user.id, id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Расширение не установлено' });
  await recordExtensionHistory(req.user.id, id, 'enable', r.rows[0].manifest);
  res.json({ extension: r.rows[0] });
});
app.post('/api/extensions/:id/disable', auth, async (req, res) => {
  const id = cleanText(req.params.id, 64).toLowerCase();
  const r = await query('UPDATE user_extensions SET enabled=false, updated_at=now() WHERE user_id=$1 AND extension_id=$2 RETURNING *', [req.user.id, id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Расширение не установлено' });
  await recordExtensionHistory(req.user.id, id, 'disable', r.rows[0].manifest);
  res.json({ extension: r.rows[0] });
});
app.delete('/api/extensions/:id', auth, async (req, res) => {
  const id = cleanText(req.params.id, 64).toLowerCase();
  const r = await query('DELETE FROM user_extensions WHERE user_id=$1 AND extension_id=$2 RETURNING *', [req.user.id, id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Расширение не установлено' });
  await recordExtensionHistory(req.user.id, id, 'remove', r.rows[0].manifest);
  res.json({ ok: true });
});
app.post('/api/extensions/safe-mode', auth, async (req, res) => {
  const enabled = Boolean(req.body.enabled);
  const settings = { ...(req.user.settings || {}), extensionsSafeMode: enabled };
  const r = await query('UPDATE profiles SET settings=$2, updated_at=now() WHERE user_id=$1 RETURNING settings', [req.user.id, settings]);
  await recordExtensionHistory(req.user.id, 'all', 'safe-mode', { version: '' }, { enabled });
  res.json({ safeMode: enabled, settings: r.rows[0].settings });
});
app.post('/api/extensions/rollback-last', auth, async (req, res) => {
  const last = await query("SELECT * FROM extension_history WHERE user_id=$1 AND action IN ('install','enable') ORDER BY created_at DESC LIMIT 1", [req.user.id]);
  if (!last.rows[0]) return res.status(404).json({ error: 'Нет действий для отката' });
  await query('UPDATE user_extensions SET enabled=false, updated_at=now() WHERE user_id=$1 AND extension_id=$2', [req.user.id, last.rows[0].extension_id]);
  await recordExtensionHistory(req.user.id, last.rows[0].extension_id, 'rollback', { version: last.rows[0].version }, { rolledBackHistoryId: last.rows[0].id });
  res.json({ ok: true, disabled: last.rows[0].extension_id });
});
app.post('/api/extensions/:id/report', auth, async (req, res) => {
  const id = cleanText(req.params.id, 64).toLowerCase();
  const reason = cleanText(req.body.reason, 1000);
  if (!reason) return res.status(400).json({ error: 'Укажите причину жалобы' });
  const r = await query('INSERT INTO extension_reports(reporter_id,extension_id,reason) VALUES($1,$2,$3) RETURNING *', [req.user.id, id, reason]);
  res.status(201).json({ report: r.rows[0] });
});

app.post('/api/calls', auth, async (req, res) => {
  if (!(await isMember(req.user.id, req.body.chatId))) return res.status(403).json({ error: 'Нет доступа' });
  const type = ['voice','video','screen'].includes(req.body.type) ? req.body.type : 'voice';
  const rtc = rtcConfig();
  const call = await transaction(async client => {
    const created = await client.query('INSERT INTO calls(chat_id,initiator_id,type) VALUES($1,$2,$3) RETURNING *', [req.body.chatId, req.user.id, type]);
    await client.query("INSERT INTO call_participants(call_id,user_id,status,joined_at) VALUES($1,$2,'joined',now())", [created.rows[0].id, req.user.id]);
    await client.query("INSERT INTO call_participants(call_id,user_id,status) SELECT $1,user_id,'invited' FROM chat_members WHERE chat_id=$2 AND user_id<>$3 ON CONFLICT DO NOTHING", [created.rows[0].id, req.body.chatId, req.user.id]);
    return created.rows[0];
  });
  const participants = await callParticipantRows(call.id);
  await broadcastChat(req.body.chatId, 'call:ring', { call, rtc, participants, from: safeUser(req.user) });
  res.status(201).json({ call, rtc, participants });
});
app.patch('/api/calls/:id', auth, async (req, res) => {
  const requestedStatus = ['ringing','active','ended','missed','rejected','left'].includes(req.body.status) ? req.body.status : 'active';
  const existing = await query('SELECT * FROM calls WHERE id=$1', [req.params.id]);
  const call = existing.rows[0];
  if (!call || !(await isMember(req.user.id, call.chat_id))) return res.status(404).json({ error: 'Звонок не найден' });

  const participantStatus = requestedStatus === 'active' ? 'joined' : requestedStatus === 'left' || requestedStatus === 'ended' ? 'left' : requestedStatus === 'rejected' ? 'rejected' : 'invited';
  await query("INSERT INTO call_participants(call_id,user_id,status,joined_at,left_at) VALUES($1,$2,$3,CASE WHEN $3='joined' THEN now() ELSE NULL END,CASE WHEN $3 IN ('left','rejected') THEN now() ELSE NULL END) ON CONFLICT(call_id,user_id) DO UPDATE SET status=EXCLUDED.status, joined_at=COALESCE(call_participants.joined_at,EXCLUDED.joined_at), left_at=CASE WHEN EXCLUDED.status IN ('left','rejected') THEN now() ELSE call_participants.left_at END", [req.params.id, req.user.id, participantStatus]);

  const hasJoinedParticipants = await query("SELECT 1 FROM call_participants WHERE call_id=$1 AND user_id<>$2 AND status='joined' LIMIT 1", [req.params.id, req.user.id]);
  const participantCount = await query('SELECT count(*)::int count FROM call_participants WHERE call_id=$1', [req.params.id]);
  const isGroupCall = Number(participantCount.rows[0]?.count || 0) > 2;
  const finalStatus = (requestedStatus === 'left' || (requestedStatus === 'rejected' && isGroupCall)) && hasJoinedParticipants.rows[0]
    ? 'active'
    : requestedStatus === 'left'
      ? 'ended'
      : requestedStatus;
  const r = await query("UPDATE calls SET status=$2, ended_at=CASE WHEN $2 IN ('ended','missed','rejected') THEN COALESCE(ended_at,now()) ELSE ended_at END WHERE id=$1 RETURNING *", [req.params.id, finalStatus]);
  const participants = await callParticipantRows(req.params.id);
  await broadcastChat(r.rows[0].chat_id, 'call:update', { call: r.rows[0], participants, by: req.user.id, participantStatus });
  res.json({ call: r.rows[0], participants });
});
app.get('/api/calls/:id/participants', auth, async (req, res) => {
  const call = await query('SELECT * FROM calls WHERE id=$1', [req.params.id]);
  if (!call.rows[0] || !(await isMember(req.user.id, call.rows[0].chat_id))) return res.status(404).json({ error: 'Звонок не найден' });
  res.json({ participants: await callParticipantRows(req.params.id) });
});
app.post('/api/reports', auth, async (req, res) => { const r = await query('INSERT INTO reports(reporter_id,target_type,target_id,reason) VALUES($1,$2,$3,$4) RETURNING *', [req.user.id, req.body.targetType, req.body.targetId, cleanText(req.body.reason, 1000)]); res.status(201).json({ report: r.rows[0] }); });

app.get('/api/reports', auth, requireAdmin, async (req, res) => {
  const r = await query('SELECT r.*, u.username reporter_username FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 200');
  res.json({ reports: r.rows });
});
app.patch('/api/reports/:id', auth, requireAdmin, async (req, res) => {
  const r = await query('UPDATE reports SET status=$2, resolved_at=CASE WHEN $2 IN (\'resolved\',\'rejected\') THEN now() ELSE resolved_at END WHERE id=$1 RETURNING *', [req.params.id, ['open','reviewing','resolved','rejected'].includes(req.body.status) ? req.body.status : 'reviewing']);
  await query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [req.user.id, 'report_status_changed', 'report', req.params.id, { status: req.body.status }]);
  res.json({ report: r.rows[0] });
});
app.get('/api/admin/stats', auth, requireAdmin, async (_req, res) => { const [users, chats, messages, reports] = await Promise.all([query('SELECT count(*) FROM users'), query('SELECT count(*) FROM chats'), query('SELECT count(*) FROM messages'), query("SELECT count(*) FROM reports WHERE status='open'")]); res.json({ users: Number(users.rows[0].count), chats: Number(chats.rows[0].count), messages: Number(messages.rows[0].count), openReports: Number(reports.rows[0].count) }); });

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, maxPayload: MAX_WS_PAYLOAD_BYTES });
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));
wss.on('connection', async (ws, req) => {
  try {
    const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    const payload = verifyAccess(token); ws.userId = payload.sub; ws.isAlive = true;
    if (!sockets.has(ws.userId)) sockets.set(ws.userId, new Set()); sockets.get(ws.userId).add(ws);
    await query("UPDATE users SET status='online', last_seen=now() WHERE id=$1", [ws.userId]);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async raw => {
      try {
        await wsLimiter.consume(ws.userId);
        const msg = JSON.parse(raw);
        if (!msg.chatId || !(await isMember(ws.userId, msg.chatId))) return;
        if (msg.event === 'typing') await broadcastChat(msg.chatId, 'typing', { chatId: msg.chatId, userId: ws.userId });
        if (msg.event === 'call:join') {
          const call = await query('SELECT * FROM calls WHERE id=$1 AND chat_id=$2', [msg.callId, msg.chatId]);
          if (!call.rows[0]) return;
          await query("UPDATE call_participants SET status='joined', joined_at=COALESCE(joined_at,now()), left_at=NULL WHERE call_id=$1 AND user_id=$2", [msg.callId, ws.userId]);
          await broadcastChat(msg.chatId, 'call:join', { chatId: msg.chatId, callId: msg.callId, userId: ws.userId, participants: await callParticipantRows(msg.callId) });
        }
        if (msg.event === 'call:signal') {
          const call = await query('SELECT chat_id FROM calls WHERE id=$1 AND chat_id=$2', [msg.callId, msg.chatId]);
          if (!call.rows[0]) return;
          if (msg.targetUserId && (!isUuid(msg.targetUserId) || !(await isMember(msg.targetUserId, msg.chatId)))) return;
          await broadcastChat(msg.chatId, 'call:signal', { from: ws.userId, targetUserId: msg.targetUserId || null, signal: msg.signal, callId: msg.callId });
        }
      } catch { ws.close(1008, 'bad message'); }
    });
    ws.on('close', async () => { sockets.get(ws.userId)?.delete(ws); if (!sockets.get(ws.userId)?.size) { sockets.delete(ws.userId); await query("UPDATE users SET status='offline', last_seen=now() WHERE id=$1", [ws.userId]); } });
  } catch { ws.close(1008, 'unauthorized'); }
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint не найден' }));
app.use((error, _req, res, _next) => {
  console.error(error.message || error);
  if (error.message === 'CORS origin denied') return res.status(403).json({ error: 'Origin запрещён' });
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл слишком большой' });
  if (error.message === 'Недопустимый тип файла') return res.status(415).json({ error: error.message });
  return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});
app.get('*', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

async function startServer() {
  await startRealtimeBus();
  return new Promise(resolve => {
    server.listen(PORT, () => {
      console.log(`Liquid Messenger listening on ${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('Failed to start server', error);
    process.exit(1);
  });
}
module.exports = { app, server, startServer, signAccess, hashToken };
