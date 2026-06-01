const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('database schema contains core messenger tables and performance indexes', () => {
  const sql = fs.readFileSync('database/migrations/001_init.sql', 'utf8');
  for (const table of [
    'users', 'profiles', 'refresh_tokens', 'password_resets', 'legal_acceptances', 'user_devices',
    'push_subscriptions', 'contacts', 'chats', 'chat_members', 'messages',
    'message_receipts', 'saved_messages', 'reactions', 'attachments', 'calls',
    'call_participants', 'notifications', 'reports', 'audit_logs', 'extension_marketplace', 'user_extensions', 'extension_history', 'extension_reports',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  for (const index of [
    'users_username_lower_idx', 'users_email_lower_idx', 'users_username_trgm_idx',
    'profiles_display_name_trgm_idx', 'chat_members_user_updated_idx',
    'notifications_user_unread_idx', 'messages_chat_created_idx', 'reports_status_created_idx', 'legal_acceptances_user_accepted_idx', 'extension_marketplace_status_idx', 'user_extensions_user_enabled_idx',
  ]) {
    assert.ok(sql.includes(index), `${index} missing`);
  }
});

test('web client includes optimized search and realtime actions', () => {
  const app = fs.readFileSync('apps/web/public/app.js', 'utf8');
  for (const feature of [
    '/auth/register', 'acceptedLegal', '/legal.html#terms', '/auth/login', '/chats', '/contacts', '/calls', '/uploads',
    '/saved-messages', '/devices', '/search/users', 'new WebSocket', 'membersPanel',
    'receiptsPanel', 'debouncedSearch', 'AbortController', 'RTCPeerConnection', 'getUserMedia', 'createOffer', 'createAnswer', 'settingsPanel', 'settings-toggle', 'svgIcon', 'startNetworkMonitor', 'measureServerLatency', 'network-window', 'networkGame', 'applyUserPreferences', 'playNotificationSound', 'tapNetworkGame', 'network-game-track', 'groupDraftIds', 'renderGroupUserSearch', 'renderMemberAddSearch', 'call-remote-grid', 'handleCallJoin', 'targetUserId', 'extensionsPanel', 'configureExtensionHost', '/extensions/install/', '/extensions/update/',
  ]) {
    assert.ok(app.includes(feature), `${feature} missing`);
  }
});

test('api gateway exposes secure and scalable routes beyond basic send/receive', () => {
  const server = fs.readFileSync('backend/gateway/src/server.js', 'utf8');
  for (const feature of [
    '/api/legal/current', 'LEGAL_DOCUMENTS', 'legal_acceptances', '/api/chats/:id/members', '/api/chats/:id/read', '/api/messages/:id/receipts',
    '/api/messages/:id/save', '/api/saved-messages', '/api/devices',
    '/api/push-subscriptions', '/api/search/users', '/api/calls/:id/participants', '/api/extensions', '/api/extensions/install/:id', '/api/extensions/update/:id', '/api/extensions/safe-mode', '/api/extensions/rollback-last', '/api/reports', '/api/admin/stats',
    'contentSecurityPolicy', 'authLimiter', 'verifyAccess', 'ALLOWED_UPLOAD_MIME',
    'pg_notify', 'LISTEN chat_events', 'perMessageDeflate: false', 'rtcConfig', 'call_participants', 'call:join', 'targetUserId', 'callParticipantRows', 'sanitizeExtensionManifest', 'extensionRiskLevel', 'recordExtensionHistory',
  ]) {
    assert.ok(server.includes(feature), `${feature} missing`);
  }
});


test('service folders contain executable contracts and security audit is present', () => {
  for (const dir of ['auth','users','chats','messages','websocket','calls','notifications','uploads','search','moderation','extensions']) {
    const manifest = `backend/${dir}/service.json`;
    assert.ok(fs.existsSync(manifest), `${manifest} missing`);
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.equal(parsed.service, dir);
  }
  for (const file of ['apps/admin/public/app.js', 'apps/mobile/src/App.js', 'apps/desktop/src/main.js', 'apps/web/public/legal.html', 'apps/web/public/extensions.js', 'apps/web/public/plugins/core-tools/index.js', 'app/sdk/index.js', 'scripts/security-audit.js']) {
    assert.ok(fs.existsSync(file), `${file} missing`);
  }
});

test('desktop app reuses the web client with native Electron integration', () => {
  const main = fs.readFileSync('apps/desktop/src/main.js', 'utf8');
  const preload = fs.readFileSync('apps/desktop/src/preload.js', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('apps/desktop/package.json', 'utf8'));
  for (const feature of [
    'startEmbeddedGateway', 'backend/gateway/src/server.js', 'LIQUID_MESSENGER_URL',
    'setPermissionRequestHandler', 'setDisplayMediaRequestHandler', 'requestSingleInstanceLock',
    'Tray', 'Notification', 'desktop:set-badge', 'contextIsolation: true', 'nodeIntegration: false', 'sandbox: true',
  ]) {
    assert.ok(main.includes(feature), `${feature} missing`);
  }
  assert.ok(fs.readFileSync('apps/admin/public/app.js', 'utf8').includes('escapeHtml'), 'admin escaping missing');
  for (const bridge of ['LiquidDesktop', 'notify', 'setBadge', 'clearBadge', 'onGatewayExit']) {
    assert.ok(preload.includes(bridge), `${bridge} missing`);
  }
  assert.equal(pkg.main, 'src/main.js');
  assert.ok(pkg.scripts.dist, 'desktop dist script missing');
});


test('extension host exposes SDK, permissions, marketplace plugins and recovery controls', () => {
  const host = fs.readFileSync('apps/web/public/extensions.js', 'utf8');
  for (const feature of ['validateManifest', 'createApi', 'addButton', 'addPage', 'addSettingsSection', 'commands', 'events', 'theme', 'calls', 'safeMode', 'deactivateExtension', 'auditExtensionSource', 'safeNetworkRequest', 'sanitizeHtml']) {
    assert.ok(host.includes(feature), `${feature} missing`);
  }
  for (const plugin of ['core-tools','theme-pack','safe-mode-controller']) {
    assert.ok(fs.existsSync(`apps/web/public/plugins/${plugin}/manifest.json`), `${plugin} manifest missing`);
    assert.ok(fs.existsSync(`apps/web/public/plugins/${plugin}/index.js`), `${plugin} entry missing`);
  }
  const sdk = fs.readFileSync('app/sdk/index.js', 'utf8');
  assert.ok(sdk.includes('validateManifest'));
  assert.ok(sdk.includes('createEventBus'));
  assert.ok(sdk.includes('createExtensionNetwork'));
  assert.ok(host.includes('api.network.request') || host.includes('network: Object.freeze'));
  assert.ok(fs.readFileSync('database/migrations/001_init.sql', 'utf8').includes("'update'"));
});
