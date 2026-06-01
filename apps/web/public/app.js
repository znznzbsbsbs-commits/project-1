const state = {
  token: localStorage.token,
  refresh: localStorage.refresh,
  user: null,
  chats: [],
  messages: [],
  activeChat: null,
  ws: null,
  searchController: null,
  typingTimer: null,
  call: null,
  pendingCallSignals: new Map(),
  groupDraftIds: new Map(),
  latencyMs: 0,
  networkProblem: null,
  networkTimer: null,
  networkSlowCount: 0,
  networkGame: null,
  desktopUnread: 0,
  extensions: { marketplace: [], installed: [], history: [], safeMode: false },
};

const $ = selector => document.querySelector(selector);
const app = $('#app');

function debounce(fn, delay = 180) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const debouncedSearch = debounce(query => search(query), 180);

const HIGH_PING_MS = 900;
const PING_TIMEOUT_MS = 4500;
const PING_INTERVAL_MS = 5000;

function desktopBridge() {
  return window.LiquidDesktop?.isDesktop ? window.LiquidDesktop : null;
}

function notificationsAllowed() {
  return currentSettings().notifications !== false;
}

function desktopNotify(title, body) {
  if (!notificationsAllowed()) return;
  const bridge = desktopBridge();
  if (bridge) bridge.notify(title, body).catch(() => {});
}

function playNotificationSound() {
  if (currentSettings().sound === false) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  const context = new Context();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = 620;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.2);
}

function applyUserPreferences() {
  const settings = currentSettings();
  document.body.classList.toggle('reduce-motion', Boolean(settings.reduceMotion));
  document.body.classList.toggle('compact-mode', Boolean(settings.compactMode));
  document.body.classList.toggle('theme-dark', settings.theme === 'dark');
}

function setDesktopUnread(count) {
  state.desktopUnread = Math.max(0, count);
  const bridge = desktopBridge();
  if (bridge) bridge.setBadge(state.desktopUnread).catch(() => {});
}

function incrementDesktopUnread() {
  setDesktopUnread(state.desktopUnread + 1);
}


function ensureNetworkLayer() {
  let layer = document.getElementById('networkLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'networkLayer';
    document.body.appendChild(layer);
  }
  return layer;
}

function stopNetworkGame() {
  if (!state.networkGame) return;
  cancelAnimationFrame(state.networkGame.raf);
  clearInterval(state.networkGame.interval);
  state.networkGame = null;
}

function resetNetworkGame() {
  stopNetworkGame();
  state.networkGame = {
    pos: 0,
    dir: 1,
    score: 0,
    net: 0,
    time: 20,
    zonePos: 50,
    zoneSize: 25,
    raf: 0,
    interval: 0,
  };
}

function renderNetworkGameStats(statusText) {
  const game = state.networkGame;
  if (!game) return;
  const score = document.getElementById('networkGameScore');
  const net = document.getElementById('networkGameNet');
  const time = document.getElementById('networkGameTime');
  const status = document.getElementById('networkGameStatus');
  const zone = document.getElementById('networkGameZone');
  if (score) score.textContent = game.score;
  if (net) net.textContent = game.net;
  if (time) time.textContent = game.time;
  if (status && statusText) status.textContent = statusText;
  if (zone) {
    zone.style.left = `${game.zonePos}%`;
    zone.style.width = `${game.zoneSize}%`;
  }
}

function startNetworkGameLoop() {
  const game = state.networkGame;
  const indicator = document.getElementById('networkGameIndicator');
  if (!game || !indicator) return;
  const loop = () => {
    game.pos += game.dir * 1.4;
    if (game.pos >= 100) {
      game.pos = 100;
      game.dir = -1;
    }
    if (game.pos <= 0) {
      game.pos = 0;
      game.dir = 1;
    }
    indicator.style.left = `${game.pos}%`;
    game.raf = requestAnimationFrame(loop);
  };
  game.raf = requestAnimationFrame(loop);
  game.interval = setInterval(() => {
    if (!state.networkGame) return;
    game.time = Math.max(0, game.time - 1);
    game.net = Math.min(100, game.net + 5);
    const statusText = game.net >= 100 ? 'Сеть проверяется автоматически' : undefined;
    renderNetworkGameStats(statusText);
  }, 1000);
}

function tapNetworkGame() {
  const game = state.networkGame;
  if (!game || game.net >= 100) return;
  const hit = game.pos > game.zonePos && game.pos < game.zonePos + game.zoneSize;
  game.score = Math.max(0, game.score + (hit ? 10 : -2));
  game.zonePos = Math.random() * 70;
  game.zoneSize = 10 + Math.random() * 25;
  renderNetworkGameStats(hit ? 'Хороший сигнал' : 'Потеря пакетов…');
}

function renderOfflineMiniGame(layer) {
  if (document.getElementById('networkGame')) return;
  resetNetworkGame();
  layer.innerHTML = `
    <div class="network-overlay network-game-overlay">
      <div class="network-game-window" id="networkGame">
        <div class="network-game-header">
          <div class="network-game-title">Слабое соединение</div>
          <div class="network-game-subtitle">Сеть восстанавливается автоматически</div>
        </div>
        <div class="network-game-hud">
          <div>Очки: <span id="networkGameScore">0</span></div>
          <div>Восстановление: <span id="networkGameNet">0</span>%</div>
          <div>Время: <span id="networkGameTime">20</span>s</div>
        </div>
        <div class="network-game-body">
          <div class="network-game-status" id="networkGameStatus">Игра для ожидания сети</div>
          <div class="network-game-track">
            <div class="network-game-zone" id="networkGameZone"></div>
            <div class="network-game-indicator" id="networkGameIndicator"></div>
          </div>
        </div>
        <button type="button" class="network-game-button" id="networkGameTap">Стабилизировать</button>
      </div>
    </div>
  `;
  document.getElementById('networkGameTap')?.addEventListener('click', tapNetworkGame);
  renderNetworkGameStats();
  startNetworkGameLoop();
}

function renderNetworkWarning() {
  const layer = ensureNetworkLayer();
  if (!state.networkProblem) {
    stopNetworkGame();
    layer.innerHTML = '';
    return;
  }

  if (state.networkProblem === 'offline') {
    renderOfflineMiniGame(layer);
    return;
  }

  stopNetworkGame();
  const title = 'Высокий пинг';
  const subtitle = `Пинг до сервера ${Math.round(state.latencyMs)} мс.<br>Сообщения могут отправляться с задержкой.`;

  layer.innerHTML = `
    <div class="network-overlay">
      <div class="network-window">
        <div class="network-icon-wrap">
          <div class="network-spinner"></div>
          <div class="network-signal">
            <div class="network-bar"></div>
            <div class="network-bar"></div>
            <div class="network-bar"></div>
          </div>
        </div>
        <div class="network-title">${title}</div>
        <div class="network-subtitle">${subtitle}</div>
        <div class="network-dots">
          <div class="network-dot"></div>
          <div class="network-dot"></div>
          <div class="network-dot"></div>
        </div>
      </div>
    </div>
  `;
}

async function measureServerLatency() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  const started = performance.now();
  try {
    await fetch(`/api/health?ping=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    state.latencyMs = performance.now() - started;
    state.networkSlowCount = state.latencyMs > HIGH_PING_MS ? state.networkSlowCount + 1 : 0;
    state.networkProblem = state.networkSlowCount >= 2 ? 'high-ping' : null;
  } catch {
    state.networkSlowCount += 1;
    state.networkProblem = 'offline';
  } finally {
    clearTimeout(timeout);
    renderNetworkWarning();
  }
}

function startNetworkMonitor() {
  if (state.networkTimer) clearInterval(state.networkTimer);
  window.addEventListener('online', measureServerLatency);
  window.addEventListener('offline', () => {
    state.networkProblem = 'offline';
    renderNetworkWarning();
  });
  measureServerLatency();
  state.networkTimer = setInterval(measureServerLatency, PING_INTERVAL_MS);
}


function svgIcon(name, className = 'icon') {
  const icons = {
    message: '<path d="M4 6h16v10H8l-4 4V6z"/><path d="M8 10h8"/><path d="M8 13h5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M16 16l4 4"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    settings: '<path d="M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z"/><path d="M4 12h2"/><path d="M18 12h2"/><path d="M12 4v2"/><path d="M12 18v2"/><path d="M6.6 6.6l1.4 1.4"/><path d="M16 16l1.4 1.4"/><path d="M17.4 6.6L16 8"/><path d="M8 16l-1.4 1.4"/>',
    star: '<path d="M12 3l2.7 5.5l6.1.9l-4.4 4.3l1 6.1L12 17l-5.4 2.8l1-6.1l-4.4-4.3l6.1-.9L12 3z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.8"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2a19.8 19.8 0 0 1-8.6-3.1a19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.7.6 2.5a2 2 0 0 1-.4 2.1L8 9.6a16 16 0 0 0 6.4 6.4l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.6.5 2.5.6a2 2 0 0 1 1.7 2z"/>',
    video: '<path d="M4 7h10v10H4z"/><path d="M14 10l6-3v10l-6-3z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    send: '<path d="M4 12h16"/><path d="M14 6l6 6l-6 6"/>',
    like: '<path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/><path d="M7 11l4-8a3 3 0 0 1 3 3v5h5a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7V11z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1l1-4L16.5 3.5z"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
    privacy: '<path d="M4 11V7a8 8 0 0 1 16 0v4"/><path d="M5 11h14v10H5z"/><path d="M12 15v2"/>',
    sound: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8a5 5 0 0 1 0 8"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    device: '<path d="M6 4h12v16H6z"/><path d="M9 8h6"/><path d="M10 18h4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5l-5-5"/><path d="M21 12H9"/>',
  };
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.message}</svg>`;
}


async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const headers = {
    ...(isForm ? {} : { 'Content-Type': 'application/json' }),
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...(opts.headers || {}),
  };

  const res = await fetch(`/api${path}`, {
    ...opts,
    headers,
    body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function saveTokens(data) {
  if (data.accessToken) {
    localStorage.token = data.accessToken;
    state.token = data.accessToken;
  }

  if (data.refreshToken) {
    localStorage.refresh = data.refreshToken;
    state.refresh = data.refreshToken;
  }
}

function authView(mode = 'login') {
  const title = mode === 'register'
    ? 'Создайте новый аккаунт'
    : mode === 'forgot'
      ? 'Восстановление пароля'
      : 'Войдите в аккаунт';

  const fields = mode === 'register'
    ? `
      <input class="input" name="username" placeholder="Имя пользователя" minlength="3" required>
      <input class="input" name="email" type="email" placeholder="Email" required>
    `
    : mode === 'forgot'
      ? '<input class="input" name="email" type="email" placeholder="Email" required>'
      : '<input class="input" name="login" placeholder="Email или username" required>';

  app.innerHTML = `
    <section class="auth-card">
      <div class="logo">${svgIcon('message', 'logo-icon')}</div>
      <h1>Liquid Messenger</h1>
      <div class="subtitle">${title}</div>
      <div id="error"></div>
      <form id="authForm">
        ${fields}
        ${mode !== 'forgot' ? '<input class="input" name="password" type="password" placeholder="Пароль" minlength="8" required>' : ''}
        ${mode === 'register' ? '<input class="input" name="confirm" type="password" placeholder="Подтверждение пароля" minlength="8" required>' : ''}
        ${mode === 'register' ? `
          <label class="legal-consent">
            <input type="checkbox" name="acceptedLegal" value="true" required>
            <span>Я принимаю <a href="/legal.html#terms" target="_blank" rel="noopener">Terms of Service</a>, <a href="/legal.html#privacy" target="_blank" rel="noopener">Privacy Policy</a>, <a href="/legal.html#calls" target="_blank" rel="noopener">Call Policy</a> и <a href="/legal.html#developers" target="_blank" rel="noopener">Extension Developer Policy</a>.</span>
          </label>
        ` : ''}
        <button class="register-btn">${mode === 'register' ? 'Создать аккаунт' : mode === 'forgot' ? 'Получить ссылку' : 'Войти'}</button>
      </form>
      <div class="footer">
        ${mode === 'login'
          ? '<span class="link" data-mode="register">Регистрация</span> · <span class="link" data-mode="forgot">Забыли пароль?</span>'
          : 'Уже есть аккаунт? <span class="link" data-mode="login">Войти</span>'}
      </div>
    </section>
  `;

  document.querySelectorAll('[data-mode]').forEach(link => {
    link.onclick = () => authView(link.dataset.mode);
  });

  $('#authForm').onsubmit = async event => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    $('#error').innerHTML = '';

    try {
      if (mode === 'register' && form.password !== form.confirm) {
        throw new Error('Пароли не совпадают');
      }
      if (mode === 'register' && form.acceptedLegal !== 'true') {
        throw new Error('Для регистрации нужно принять юридические условия сервиса');
      }

      const data = await api(
        mode === 'register' ? '/auth/register' : mode === 'forgot' ? '/auth/forgot-password' : '/auth/login',
        { method: 'POST', body: form },
      );

      if (mode === 'forgot') {
        $('#error').innerHTML = `<div class="error">Токен восстановления: ${data.resetToken || 'скрыт'}</div>`;
        return;
      }

      saveTokens(data);
      state.user = data.user;
      await loadApp();
    } catch (err) {
      $('#error').innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    }
  };
}

function connectWs() {
  if (state.ws) state.ws.close();

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${protocol}://${location.host}/ws?token=${state.token}`);

  state.ws.onopen = () => {
    if (state.networkProblem === 'offline') {
      state.networkProblem = null;
      renderNetworkWarning();
    }
  };
  state.ws.onclose = () => {
    state.networkProblem = 'offline';
    renderNetworkWarning();
  };
  state.ws.onerror = () => {
    state.networkProblem = 'offline';
    renderNetworkWarning();
  };

  state.ws.onmessage = event => {
    const { event: name, data } = JSON.parse(event.data);

    if (name === 'message:new' && data.chat_id === state.activeChat?.id) {
      state.messages.push(data);
      renderMessages();
    }

    if (name === 'message:new' && data.chat_id !== state.activeChat?.id) {
      incrementDesktopUnread();
      desktopNotify(data.display_name || data.username || 'Новое сообщение', data.body || 'Откройте чат');
      playNotificationSound();
      loadChats().catch(() => {});
    }

    if (name === 'message:edited' && data.chat_id === state.activeChat?.id) {
      state.messages = state.messages.map(message => message.id === data.id ? data : message);
      renderMessages();
    }

    if (name === 'message:deleted') {
      state.messages = state.messages.filter(message => message.id !== data.id);
      renderMessages();
    }

    if (name === 'chat:read') toast('Сообщения прочитаны');
    if (name === 'typing') toast('Печатает...');
    if (name === 'call:ring') {
      desktopNotify('Входящий звонок', data.from?.displayName || data.from?.username || 'Liquid Messenger');
      playNotificationSound();
      handleIncomingCall(data);
    }
    if (name === 'call:update') handleCallUpdate(data);
    if (name === 'call:join') handleCallJoin(data);
    if (name === 'call:signal') handleCallSignal(data);
    if (name === 'notification') {
      incrementDesktopUnread();
      desktopNotify(data.title, data.body);
      playNotificationSound();
      toast(`${data.title}: ${data.body}`);
    }
  };
}

function shell() {
  app.innerHTML = `
    <div class="window">
      <aside class="sidebar">
        <div class="search">
          <input id="search" class="input" placeholder="Поиск" style="margin:0">
        </div>
        <div class="toolbar" data-extension-slot="sidebar.top">
          <button class="pill icon-pill" id="newChat">${svgIcon('plus')}</button>
          <button class="pill" id="contacts">Контакты</button>
          <button class="pill icon-pill" id="settings">${svgIcon('settings')}</button>
          <button class="pill icon-pill" id="saved">${svgIcon('star')}</button>
        </div>
        <div class="chat-list" id="chatList"></div>
        <div class="toolbar extension-slot" data-extension-slot="sidebar.bottom"></div>
      </aside>
      <section class="chat">
        <header class="header">
          <div>
            <b id="chatTitle">Выберите чат</b>
            <div class="muted" id="chatMeta">online presence, группы и каналы</div>
          </div>
          <div class="toolbar">
            <div class="toolbar extension-slot" data-extension-slot="header.left"></div>
            <button class="pill icon-pill" id="members">${svgIcon('users')}</button>
            <button class="pill icon-pill" id="voice">${svgIcon('phone')}</button>
            <button class="pill icon-pill" id="video">${svgIcon('video')}</button>
            <button class="pill icon-pill" id="files">${svgIcon('file')}</button>
            <button class="pill icon-pill" id="notify">${svgIcon('bell')}</button>
            <div class="toolbar extension-slot" data-extension-slot="header.right"></div>
            <div class="toolbar extension-slot" data-extension-slot="toolbar"></div>
            <button class="pill danger" id="logout">Выйти</button>
          </div>
        </header>
        <div class="messages" id="messages"></div>
        <form class="bottom" id="sendForm">
          <input class="input" id="messageInput" placeholder="Сообщение...">
          <button class="send">${svgIcon('send')}</button>
        </form>
      </section>
      <div id="panel"></div>
      <div id="callLayer"></div>
    </div>
  `;
  bindShell();
}

function bindShell() {
  $('#logout').onclick = logout;
  $('#newChat').onclick = newChatPanel;
  $('#contacts').onclick = contactsPanel;
  $('#settings').onclick = settingsPanel;
  $('#notify').onclick = notificationsPanel;
  $('#files').onclick = filePanel;
  $('#members').onclick = membersPanel;
  $('#saved').onclick = savedPanel;
  $('#voice').onclick = () => startCall('voice');
  $('#video').onclick = () => startCall('video');
  $('#search').oninput = event => debouncedSearch(event.target.value);
  $('#sendForm').onsubmit = sendMessage;
  $('#messageInput').oninput = () => {
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      if (state.activeChat && state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ event: 'typing', chatId: state.activeChat.id }));
      }
    }, 120);
  };
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.clear();
  location.reload();
}


function detectExtensionCrashLoop() {
  const bootState = JSON.parse(localStorage.getItem('extensions.boot') || '{"pending":false,"crashes":0}');
  if (bootState.pending) bootState.crashes = Number(bootState.crashes || 0) + 1;
  if (bootState.crashes >= 3) localStorage.setItem('extensions.safeMode', 'true');
  localStorage.setItem('extensions.boot', JSON.stringify({ pending: true, crashes: bootState.crashes || 0, startedAt: Date.now() }));
}

function markExtensionBootSuccessful() {
  localStorage.setItem('extensions.boot', JSON.stringify({ pending: false, crashes: 0, finishedAt: Date.now() }));
}

function configureExtensionHost() {
  window.LiquidExtensions?.configure({
    notify: desktopNotify,
    panel,
    toast,
    calls: {
      join: () => toast('Подключение к звонку выполняется из активного звонка'),
      leave: () => endCall('ended'),
      mute: () => { if (!state.call?.muted) toggleMute(); },
      unmute: () => { if (state.call?.muted) toggleMute(); },
      enableCamera: () => { if (state.call?.cameraOff) toggleCamera(); },
      disableCamera: () => { if (!state.call?.cameraOff) toggleCamera(); },
      startScreenShare: shareScreen,
      getParticipants: () => state.call?.participants || [],
    },
  });
}

async function loadExtensions() {
  const result = await api('/extensions').catch(() => ({ marketplace: [], installed: [], safeMode: true }));
  state.extensions = { ...state.extensions, ...result, safeMode: Boolean(result.safeMode || localStorage.getItem('extensions.safeMode') === 'true') };
  window.LiquidExtensions?.setSafeMode(state.extensions.safeMode);
  await window.LiquidExtensions?.loadInstalled(result.installed || []);
}

function permissionLabel(permission) {
  const labels = {
    ui: 'Изменение интерфейса', commands: 'Команды', events: 'События', storage: 'Локальное хранилище', notifications: 'Уведомления', theme: 'Темы', network: 'Сетевые запросы', voice: 'Голосовые функции', video: 'Видео', 'call-events': 'События звонков', microphone: 'Высокоуровневое управление микрофоном', camera: 'Высокоуровневое управление камерой', screenshare: 'Демонстрация экрана', filesystem: 'Файловая система', desktop: 'Desktop API', admin: 'Администрирование',
  };
  return labels[permission] || permission;
}

function permissionBadges(manifest) {
  return (manifest.permissions || []).map(permission => `<span class="extension-permission ${window.LiquidExtensions?.permissions.level(permission) || 'safe'}">${escapeHtml(permissionLabel(permission))}</span>`).join('');
}

function renderExtensionHtml(value) {
  return window.LiquidExtensions?.sanitizeHtml ? window.LiquidExtensions.sanitizeHtml(value) : escapeHtml(value);
}

async function installExtension(id, permissions) {
  const extension = state.extensions.marketplace.find(item => item.id === id || item.manifest?.id === id);
  const manifest = extension?.manifest;
  const hasCritical = manifest?.permissions?.some(permission => window.LiquidExtensions?.permissions.level(permission) === 'critical');
  if (hasCritical && !confirm(`Расширение "${manifest.name}" запрашивает критические разрешения. Разрешить установку?`)) return;
  await api(`/extensions/install/${id}`, { method: 'POST', body: { confirmedPermissions: permissions } });
  await loadExtensions();
  await extensionsPanel();
}

async function extensionAction(id, action) {
  if (action === 'remove') await api(`/extensions/${id}`, { method: 'DELETE' });
  else if (action === 'update') await api(`/extensions/update/${id}`, { method: 'POST', body: {} });
  else await api(`/extensions/${id}/${action}`, { method: 'POST', body: {} });
  await window.LiquidExtensions?.deactivateExtension(id);
  await loadExtensions();
  await extensionsPanel();
}

async function toggleExtensionSafeMode(enabled) {
  localStorage.setItem('extensions.safeMode', String(enabled));
  await api('/extensions/safe-mode', { method: 'POST', body: { enabled } }).catch(() => {});
  window.LiquidExtensions?.setSafeMode(enabled);
  await loadExtensions();
  await extensionsPanel();
}

async function rollbackLastExtension() {
  await api('/extensions/rollback-last', { method: 'POST', body: {} });
  await loadExtensions();
  await extensionsPanel();
}

async function reportExtension(id) {
  const reason = prompt('Почему вы жалуетесь на расширение?');
  if (!reason) return;
  await api(`/extensions/${id}/report`, { method: 'POST', body: { reason } });
  toast('Жалоба отправлена на модерацию');
}

async function extensionsPanel() {
  await loadExtensions();
  const installedIds = new Set(state.extensions.installed.map(item => item.extension_id || item.id));
  panel(`
    <h3>Расширения</h3>
    <div class="extension-card">
      <b>Recovery Mode</b>
      <p class="muted">Safe Mode отключает плагины, темы, виджеты и CSS overrides без удаления файлов.</p>
      <button class="small-btn ${state.extensions.safeMode ? 'danger' : ''}" id="toggleSafeMode">${state.extensions.safeMode ? 'Выключить Safe Mode' : 'Запустить без расширений'}</button>
      <button class="small-btn" id="rollbackExtension">Откатить последнее изменение</button>
    </div>
    <div class="section-title">УСТАНОВЛЕННЫЕ</div>
    ${(state.extensions.installed || []).map(item => `
      <div class="extension-card">
        <b>${escapeHtml(item.manifest.name)}</b> <span class="muted">${escapeHtml(item.manifest.version)} · ${item.enabled ? 'active' : 'disabled'}</span>
        <p>${escapeHtml(item.manifest.description || '')}</p>
        <div>${permissionBadges(item.manifest)}</div>
        <button class="small-btn" data-extension-action="${item.enabled ? 'disable' : 'enable'}" data-extension-id="${item.extension_id || item.id}">${item.enabled ? 'Отключить' : 'Включить'}</button>
        <button class="small-btn" data-extension-action="update" data-extension-id="${item.extension_id || item.id}">Обновить</button>
        <button class="small-btn danger" data-extension-action="remove" data-extension-id="${item.extension_id || item.id}">Удалить</button>
        <button class="small-btn" data-extension-report="${item.extension_id || item.id}">Report</button>
      </div>`).join('') || '<p class="muted">Расширения пока не установлены.</p>'}
    <div class="section-title">MARKETPLACE</div>
    ${(state.extensions.marketplace || []).map(item => `
      <div class="extension-card">
        <b>${escapeHtml(item.manifest.name)}</b> <span class="muted">${escapeHtml(item.trust)} · ${escapeHtml(item.category)} · ${escapeHtml(item.risk)}</span>
        <p>${escapeHtml(item.manifest.description || '')}</p>
        <div>${permissionBadges(item.manifest)}</div>
        <button class="small-btn" ${installedIds.has(item.id) ? 'disabled' : ''} data-install-extension="${item.id}" data-permissions="${encodeURIComponent(JSON.stringify(item.manifest.permissions || []))}">${installedIds.has(item.id) ? 'Установлено' : 'Установить'}</button>
      </div>`).join('')}
  `);
  $('#toggleSafeMode').onclick = () => toggleExtensionSafeMode(!state.extensions.safeMode);
  $('#rollbackExtension').onclick = () => rollbackLastExtension().catch(error => toast(error.message));
  document.querySelectorAll('[data-install-extension]').forEach(button => {
    button.onclick = () => installExtension(button.dataset.installExtension, JSON.parse(decodeURIComponent(button.dataset.permissions)));
  });
  document.querySelectorAll('[data-extension-action]').forEach(button => {
    button.onclick = () => extensionAction(button.dataset.extensionId, button.dataset.extensionAction).catch(error => toast(error.message));
  });
  document.querySelectorAll('[data-extension-report]').forEach(button => {
    button.onclick = () => reportExtension(button.dataset.extensionReport).catch(error => toast(error.message));
  });
}

async function loadApp() {
  if (!state.user) state.user = (await api('/me')).user;
  detectExtensionCrashLoop();
  applyUserPreferences();
  shell();
  configureExtensionHost();
  connectWs();
  await loadChats();
  await loadExtensions();
  markExtensionBootSuccessful();
}

async function loadChats() {
  state.chats = (await api('/chats')).chats;
  renderChats();
  if (!state.activeChat && state.chats[0]) selectChat(state.chats[0].id);
}

function renderChats() {
  $('#chatList').innerHTML = state.chats.map(chat => `
    <div class="chat-item ${state.activeChat?.id === chat.id ? 'active' : ''}" data-chat="${chat.id}">
      <b>${escapeHtml(chat.title || (chat.type === 'private' ? 'Личный чат' : 'Без названия'))}</b>
      <div class="muted">${chat.type} · ${escapeHtml(chat.last_message || 'пока нет сообщений')}</div>
    </div>
  `).join('');

  document.querySelectorAll('[data-chat]').forEach(item => {
    item.onclick = () => selectChat(item.dataset.chat);
  });
}

async function selectChat(id) {
  state.activeChat = state.chats.find(chat => chat.id === id);
  $('#chatTitle').textContent = state.activeChat.title || (state.activeChat.type === 'private' ? 'Личный чат' : 'Чат');
  $('#chatMeta').textContent = state.activeChat.description || state.activeChat.type;
  state.messages = (await api(`/chats/${id}/messages`)).messages;
  setDesktopUnread(0);
  await api(`/chats/${id}/read`, { method: 'POST' }).catch(() => {});
  renderChats();
  renderMessages();
}

function renderMessages() {
  $('#messages').innerHTML = state.messages.map(message => `
    <div class="message ${message.sender_id === state.user.id ? 'right' : 'left'}" data-mid="${message.id}">
      <div class="muted">${escapeHtml(message.display_name || message.username || '')}</div>
      ${escapeHtml(message.body)}
      <div class="muted">${new Date(message.created_at).toLocaleTimeString()} ${message.edited_at ? '· изменено' : ''}</div>
      <button class="small-btn icon-action" data-message-action="react" data-message-id="${message.id}">${svgIcon('like')}</button>
      <button class="small-btn icon-action" data-message-action="save" data-message-id="${message.id}">${svgIcon('star')}</button>
      <button class="small-btn" data-message-action="receipts" data-message-id="${message.id}">✓✓</button>
      ${message.sender_id === state.user.id ? `
        <button class="small-btn icon-action" data-message-action="edit" data-message-id="${message.id}">${svgIcon('edit')}</button>
        <button class="small-btn danger icon-action" data-message-action="delete" data-message-id="${message.id}">${svgIcon('close')}</button>
      ` : ''}
    </div>
  `).join('');

  document.querySelectorAll('[data-message-action]').forEach(button => {
    button.onclick = () => handleMessageAction(button.dataset.messageAction, button.dataset.messageId);
  });
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function handleMessageAction(action, id) {
  if (action === 'react') return react(id);
  if (action === 'save') return saveMsg(id);
  if (action === 'receipts') return receiptsPanel(id);
  if (action === 'edit') return editMsg(id);
  if (action === 'delete') return delMsg(id);
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.activeChat) return toast('Сначала создайте чат');

  const input = $('#messageInput');
  if (!input.value.trim()) return;

  const { message } = await api(`/chats/${state.activeChat.id}/messages`, {
    method: 'POST',
    body: { body: input.value },
  });

  input.value = '';
  if (!state.messages.find(item => item.id === message.id)) state.messages.push(message);
  renderMessages();
  await loadChats();
}

async function search(query) {
  const normalized = query.trim();
  if (normalized.length < 2) return loadChats();
  if (state.searchController) state.searchController.abort();
  state.searchController = new AbortController();

  let users = [];
  try {
    users = (await api(`/search/users?q=${encodeURIComponent(normalized)}&limit=30`, { signal: state.searchController.signal })).users;
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw err;
  }
  $('#chatList').innerHTML = users.map(user => `
    <div class="chat-item">
      <b>${escapeHtml(user.displayName)}</b>
      <div class="muted">@${escapeHtml(user.username)} · ${escapeHtml(user.status)}</div>
      <button class="small-btn" data-private-chat="${user.id}" data-private-name="${escapeHtml(user.displayName)}">Написать</button>
      <button class="small-btn" data-add-contact="${user.id}">В контакт</button>
    </div>
  `).join('');
  document.querySelectorAll('[data-private-chat]').forEach(button => {
    button.onclick = () => privateChat(button.dataset.privateChat, button.dataset.privateName);
  });
  document.querySelectorAll('[data-add-contact]').forEach(button => {
    button.onclick = () => addContact(button.dataset.addContact);
  });
}

async function privateChat(id, name) {
  const { chat } = await api('/chats', {
    method: 'POST',
    body: { type: 'private', title: name, memberIds: [id] },
  });
  state.chats.unshift(chat);
  selectChat(chat.id);
}

async function addContact(id) {
  await api(`/contacts/${id}`, { method: 'POST', body: {} });
  toast('Контакт добавлен');
}

function panel(html) {
  $('#panel').innerHTML = `<div class="panel">${html}</div>`;
}

function closePanel() {
  $('#panel').innerHTML = '';
}

function renderSelectedMembers() {
  const selected = [...state.groupDraftIds.values()];
  const target = $('#selectedMembers');
  if (!target) return;
  target.innerHTML = selected.length ? selected.map(user => `
    <button type="button" class="member-chip" data-remove-member="${user.id}">
      <span>${escapeHtml(user.displayName || user.username)}</span>
      <small>@${escapeHtml(user.username)}</small>
    </button>
  `).join('') : '<p class="muted">Пользователи ещё не выбраны.</p>';
  target.querySelectorAll('[data-remove-member]').forEach(button => {
    button.onclick = () => {
      state.groupDraftIds.delete(button.dataset.removeMember);
      renderSelectedMembers();
    };
  });
}

async function renderGroupUserSearch(query) {
  const target = $('#groupUserResults');
  if (!target) return;
  const normalized = query.trim();
  if (normalized.length < 2) {
    target.innerHTML = '<p class="muted">Введите минимум 2 символа username или имени.</p>';
    return;
  }
  target.innerHTML = '<p class="muted">Ищем пользователей…</p>';
  const users = (await api(`/search/users?q=${encodeURIComponent(normalized)}&limit=20`)).users
    .filter(user => !state.groupDraftIds.has(user.id));
  target.innerHTML = users.map(user => `
    <div class="row search-user-row">
      <span>${escapeHtml(user.displayName)}<br><span class="muted">@${escapeHtml(user.username)} · ${escapeHtml(user.status)}</span></span>
      <button type="button" class="small-btn" data-add-member="${user.id}" data-user="${encodeURIComponent(JSON.stringify(user))}">Добавить</button>
    </div>
  `).join('') || '<p class="muted">Никого не нашли.</p>';
  target.querySelectorAll('[data-add-member]').forEach(button => {
    button.onclick = () => {
      const user = JSON.parse(decodeURIComponent(button.dataset.user));
      state.groupDraftIds.set(user.id, user);
      renderSelectedMembers();
      renderGroupUserSearch($('#groupUserSearch').value).catch(error => toast(error.message));
    };
  });
}

function newChatPanel() {
  state.groupDraftIds = new Map();
  panel(`
    <h3>Новый чат или группа</h3>
    <form id="createChat">
      <select class="input" name="type" id="chatType">
        <option value="private">Личный</option>
        <option value="group" selected>Группа</option>
        <option value="channel">Канал</option>
      </select>
      <input class="input" name="title" id="chatTitle" placeholder="Название группы или канала">
      <textarea class="textarea" name="description" placeholder="Описание"></textarea>
      <div class="group-builder">
        <label class="muted" for="groupUserSearch">Поиск участников по username или имени</label>
        <input class="input" id="groupUserSearch" autocomplete="off" placeholder="Например: maria">
        <div id="groupUserResults" class="search-results"><p class="muted">Введите минимум 2 символа username или имени.</p></div>
        <div class="section-title">Выбранные участники</div>
        <div id="selectedMembers" class="member-list"></div>
      </div>
      <button class="primary">Создать</button>
    </form>
  `);
  renderSelectedMembers();

  const debouncedGroupSearch = debounce(value => renderGroupUserSearch(value).catch(error => toast(error.message)), 220);
  $('#groupUserSearch').oninput = event => debouncedGroupSearch(event.target.value);
  $('#chatType').onchange = event => {
    $('#chatTitle').placeholder = event.target.value === 'private' ? 'Название личного чата (необязательно)' : 'Название группы или канала';
  };
  $('#createChat').onsubmit = async event => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    const memberIds = [...state.groupDraftIds.keys()];
    if (!memberIds.length) return toast('Выберите хотя бы одного участника');
    const data = await api('/chats', {
      method: 'POST',
      body: { ...form, memberIds },
    });
    closePanel();
    await loadChats();
    selectChat(data.chat.id);
  };
}

async function contactsPanel() {
  const contacts = (await api('/contacts')).contacts;
  panel(`
    <h3>Контакты</h3>
    ${contacts.map(contact => `
      <div class="row">
        <span>${escapeHtml(contact.displayName)}<br><span class="muted">@${escapeHtml(contact.username)}</span></span>
        <button class="small-btn" data-private-chat="${contact.id}" data-private-name="${escapeHtml(contact.displayName)}">Чат</button>
        <button class="small-btn danger" data-block-user="${contact.id}">Блок</button>
      </div>
    `).join('') || '<p class="muted">Найдите пользователя через поиск.</p>'}
  `);
  document.querySelectorAll('[data-private-chat]').forEach(button => {
    button.onclick = () => privateChat(button.dataset.privateChat, button.dataset.privateName);
  });
  document.querySelectorAll('[data-block-user]').forEach(button => {
    button.onclick = () => blockUser(button.dataset.blockUser);
  });
}


async function renderMemberAddSearch(query) {
  const target = $('#memberSearchResults');
  if (!target || !state.activeChat) return;
  const normalized = query.trim();
  if (normalized.length < 2) {
    target.innerHTML = '<p class="muted">Введите минимум 2 символа для поиска.</p>';
    return;
  }
  target.innerHTML = '<p class="muted">Ищем пользователей…</p>';
  const users = (await api(`/search/users?q=${encodeURIComponent(normalized)}&limit=20`)).users;
  target.innerHTML = users.map(user => `
    <div class="row search-user-row">
      <span>${escapeHtml(user.displayName)}<br><span class="muted">@${escapeHtml(user.username)} · ${escapeHtml(user.status)}</span></span>
      <button type="button" class="small-btn" data-add-chat-member="${user.id}">Добавить</button>
    </div>
  `).join('') || '<p class="muted">Никого не нашли.</p>';
  target.querySelectorAll('[data-add-chat-member]').forEach(button => {
    button.onclick = async () => {
      await api(`/chats/${state.activeChat.id}/members`, { method: 'POST', body: { userId: button.dataset.addChatMember } });
      toast('Участник добавлен');
      await membersPanel();
    };
  });
}

async function membersPanel() {
  if (!state.activeChat) return toast('Выберите чат');
  const members = (await api(`/chats/${state.activeChat.id}/members`)).members;
  panel(`
    <h3>Участники</h3>
    <div class="group-builder">
      <label class="muted" for="memberSearchInput">Добавить участника по username или имени</label>
      <input class="input" id="memberSearchInput" autocomplete="off" placeholder="Например: alexey">
      <div id="memberSearchResults" class="search-results"><p class="muted">Введите минимум 2 символа для поиска.</p></div>
    </div>
    ${members.map(member => `
      <div class="row">
        <span>${escapeHtml(member.display_name)}<br><span class="muted">${member.role} · ${member.status}</span></span>
        <button class="small-btn danger" data-remove-member-id="${member.user_id}">Удалить</button>
      </div>
    `).join('')}
  `);

  document.querySelectorAll('[data-remove-member-id]').forEach(button => {
    button.onclick = () => removeMember(button.dataset.removeMemberId);
  });
  const debouncedMemberSearch = debounce(value => renderMemberAddSearch(value).catch(error => toast(error.message)), 220);
  $('#memberSearchInput').oninput = event => debouncedMemberSearch(event.target.value);
}

function currentSettings() {
  return {
    theme: 'liquid',
    language: 'ru',
    notifications: true,
    sound: true,
    compactMode: false,
    reduceMotion: false,
    ...(state.user.settings || {}),
  };
}

function currentPrivacy() {
  return {
    profile: 'contacts',
    lastSeen: 'contacts',
    calls: 'contacts',
    readReceipts: true,
    ...(state.user.privacy || {}),
  };
}

function closeSettings() {
  const layer = $('#callLayer');
  if (layer) layer.innerHTML = '';
}

async function patchMeProfile(patch) {
  const { profile } = await api('/me/profile', { method: 'PATCH', body: patch });
  state.user = {
    ...state.user,
    displayName: profile.display_name ?? state.user.displayName,
    bio: profile.bio ?? state.user.bio,
    privacy: profile.privacy ?? state.user.privacy,
    settings: profile.settings ?? state.user.settings,
  };
  applyUserPreferences();
  return profile;
}

async function settingsPanel() {
  const settings = currentSettings();
  const privacy = currentPrivacy();
  const devices = await api('/devices').then(result => result.devices).catch(() => []);
  const layer = $('#callLayer');
  if (!layer) return;

  layer.innerHTML = `
    <div class="settings-overlay">
      <div class="settings-window">
        <div class="settings-header">
          <div>
            <div class="settings-title">Настройки</div>
            <div class="settings-subtitle">Управление аккаунтом и приложением</div>
          </div>
          <button class="settings-close icon-action" id="closeSettings">${svgIcon('close')}</button>
        </div>
        <div class="settings-content">
          <div class="settings-section">
            <div class="settings-section-title">АККАУНТ</div>
            <form id="settingsProfileForm" class="settings-form">
              <label class="settings-item editable">
                <div class="settings-left">${svgIcon('user')}<span>Профиль</span></div>
                <input class="settings-input" name="displayName" value="${escapeHtml(state.user.displayName || '')}" placeholder="Имя">
              </label>
              <label class="settings-item editable textarea-row">
                <div class="settings-left">${svgIcon('edit')}<span>О себе</span></div>
                <textarea class="settings-input settings-textarea" name="bio" placeholder="Короткое био">${escapeHtml(state.user.bio || '')}</textarea>
              </label>
              <button class="settings-button" type="submit">Сохранить профиль</button>
            </form>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">ПРИВАТНОСТЬ</div>
            <label class="settings-item">
              <div class="settings-left">${svgIcon('privacy')}<span>Профиль виден</span></div>
              <select class="settings-select" id="privacyProfile">
                <option value="everyone" ${privacy.profile === 'everyone' ? 'selected' : ''}>Всем</option>
                <option value="contacts" ${privacy.profile === 'contacts' ? 'selected' : ''}>Контактам</option>
                <option value="nobody" ${privacy.profile === 'nobody' ? 'selected' : ''}>Никому</option>
              </select>
            </label>
            <label class="settings-item">
              <div class="settings-left">${svgIcon('users')}<span>Последний онлайн</span></div>
              <select class="settings-select" id="privacyLastSeen">
                <option value="everyone" ${privacy.lastSeen === 'everyone' ? 'selected' : ''}>Всем</option>
                <option value="contacts" ${privacy.lastSeen === 'contacts' ? 'selected' : ''}>Контактам</option>
                <option value="nobody" ${privacy.lastSeen === 'nobody' ? 'selected' : ''}>Никому</option>
              </select>
            </label>
            <div class="settings-item">
              <div class="settings-left">${svgIcon('phone')}<span>Звонки от контактов</span></div>
              <div class="settings-toggle ${privacy.calls !== 'nobody' ? 'active' : ''}" data-privacy-toggle="calls"></div>
            </div>
            <div class="settings-item">
              <div class="settings-left">${svgIcon('message')}<span>Отчёты о прочтении</span></div>
              <div class="settings-toggle ${privacy.readReceipts ? 'active' : ''}" data-privacy-toggle="readReceipts"></div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">УВЕДОМЛЕНИЯ</div>
            <div class="settings-item">
              <div class="settings-left">${svgIcon('bell')}<span>Уведомления</span></div>
              <div class="settings-toggle ${settings.notifications ? 'active' : ''}" data-settings-toggle="notifications"></div>
            </div>
            <div class="settings-item">
              <div class="settings-left">${svgIcon('sound')}<span>Звук</span></div>
              <div class="settings-toggle ${settings.sound ? 'active' : ''}" data-settings-toggle="sound"></div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">ПРИЛОЖЕНИЕ</div>
            <label class="settings-item">
              <div class="settings-left">${svgIcon('settings')}<span>Язык</span></div>
              <select class="settings-select" id="settingsLanguage">
                <option value="ru" ${settings.language === 'ru' ? 'selected' : ''}>Русский</option>
                <option value="en" ${settings.language === 'en' ? 'selected' : ''}>English</option>
              </select>
            </label>
            <label class="settings-item">
              <div class="settings-left">${svgIcon('star')}<span>Тема</span></div>
              <select class="settings-select" id="settingsTheme">
                <option value="liquid" ${settings.theme === 'liquid' ? 'selected' : ''}>Liquid Glass</option>
                <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
              </select>
            </label>
            <div class="settings-item">
              <div class="settings-left">${svgIcon('message')}<span>Компактный режим</span></div>
              <div class="settings-toggle ${settings.compactMode ? 'active' : ''}" data-settings-toggle="compactMode"></div>
            </div>
            <div class="settings-item">
              <div class="settings-left">${svgIcon('settings')}<span>Меньше анимаций</span></div>
              <div class="settings-toggle ${settings.reduceMotion ? 'active' : ''}" data-settings-toggle="reduceMotion"></div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">УСТРОЙСТВА</div>
            <button class="settings-button" id="settingsRegisterDevice">Добавить это устройство</button>
            ${devices.map(device => `
              <div class="settings-item">
                <div class="settings-left">${svgIcon('device')}<span>${escapeHtml(device.name)}</span></div>
                <button class="settings-mini danger" data-delete-device="${device.id}">Удалить</button>
              </div>
            `).join('') || '<div class="settings-muted">Активных устройств пока нет.</div>'}
          </div>

          <div class="settings-section">
            <div class="settings-section-title">РАСШИРЕНИЯ</div>
            <div class="settings-item">
              <div class="settings-left">${svgIcon('settings')}<span>Extension Marketplace и Safe Mode</span></div>
              <button class="settings-mini" id="openExtensions">Открыть</button>
            </div>
            <div data-extension-slot="settings.plugins"></div>
            ${[...(window.LiquidExtensions?.state.settingsSections.values?.() || [])].map(section => `
              <div class="settings-item extension-settings-section">
                <div>${escapeHtml(section.title)}<br><span class="muted">${renderExtensionHtml(section.component())}</span></div>
              </div>`).join('')}
          </div>

          <div class="settings-section">
            <div class="settings-section-title">ОПАСНОЕ</div>
            <button class="settings-button danger" id="settingsLogout">${svgIcon('logout')}<span>Выйти из аккаунта</span></button>
          </div>
        </div>
      </div>
    </div>
  `;

  $('#closeSettings').onclick = closeSettings;
  $('#settingsLogout').onclick = logout;
  $('#settingsRegisterDevice').onclick = async () => { await registerDevice(); await settingsPanel(); };
  $('#openExtensions').onclick = extensionsPanel;
  document.querySelectorAll('[data-delete-device]').forEach(button => {
    button.onclick = async () => { await deleteDevice(button.dataset.deleteDevice); await settingsPanel(); };
  });

  $('#settingsProfileForm').onsubmit = async event => {
    event.preventDefault();
    await patchMeProfile(Object.fromEntries(new FormData(event.target)));
    toast('Профиль сохранён');
  };

  const saveSettings = async next => {
    await patchMeProfile({ settings: { ...currentSettings(), ...next } });
    toast('Настройки сохранены');
    await settingsPanel();
  };
  const savePrivacy = async next => {
    await patchMeProfile({ privacy: { ...currentPrivacy(), ...next } });
    toast('Приватность сохранена');
    await settingsPanel();
  };

  document.querySelectorAll('[data-settings-toggle]').forEach(toggle => {
    toggle.onclick = () => saveSettings({ [toggle.dataset.settingsToggle]: !currentSettings()[toggle.dataset.settingsToggle] });
  });
  document.querySelectorAll('[data-privacy-toggle]').forEach(toggle => {
    const key = toggle.dataset.privacyToggle;
    if (key === 'calls') toggle.onclick = () => savePrivacy({ calls: currentPrivacy().calls === 'nobody' ? 'contacts' : 'nobody' });
    if (key === 'readReceipts') toggle.onclick = () => savePrivacy({ readReceipts: !currentPrivacy().readReceipts });
  });
  $('#privacyProfile').onchange = event => savePrivacy({ profile: event.target.value });
  $('#privacyLastSeen').onchange = event => savePrivacy({ lastSeen: event.target.value });
  $('#settingsLanguage').onchange = event => saveSettings({ language: event.target.value });
  $('#settingsTheme').onchange = event => saveSettings({ theme: event.target.value });
}

async function devicesPanel() {
  const devices = (await api('/devices')).devices;
  panel(`
    <h3>Устройства</h3>
    <button class="small-btn" id="registerDeviceButton">Добавить это устройство</button>
    ${devices.map(device => `
      <div class="chat-item">
        <b>${escapeHtml(device.name)}</b>
        <div class="muted">${new Date(device.last_seen).toLocaleString()}</div>
        <button class="small-btn danger" data-delete-device="${device.id}">Удалить</button>
      </div>
    `).join('')}
  `);
  $('#registerDeviceButton').onclick = registerDevice;
  document.querySelectorAll('[data-delete-device]').forEach(button => {
    button.onclick = () => deleteDevice(button.dataset.deleteDevice);
  });
}

async function notificationsPanel() {
  const notifications = (await api('/notifications')).notifications;
  panel(`
    <h3>Уведомления</h3>
    <button class="small-btn" id="readNotificationsButton">Прочитать все</button>
    ${notifications.map(item => `
      <div class="chat-item">
        <b>${escapeHtml(item.title)}</b>
        <div>${escapeHtml(item.body)}</div>
        <div class="muted">${new Date(item.created_at).toLocaleString()}</div>
      </div>
    `).join('')}
  `);
  $('#readNotificationsButton').onclick = () => api('/notifications/read', { method: 'POST' }).then(notificationsPanel);
}

function filePanel() {
  panel(`
    <h3>Файлы</h3>
    <form id="upload">
      <input class="input" type="file" name="file" required>
      <select class="input" name="kind">
        <option>document</option>
        <option>image</option>
        <option>video</option>
        <option>audio</option>
        <option>voice</option>
        <option>avatar</option>
      </select>
      <button class="primary">Загрузить</button>
    </form>
    <div id="uploadResult"></div>
  `);

  $('#upload').onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const result = await api('/uploads', { method: 'POST', body: form });
    const link = document.createElement('a');
    link.href = result.attachment.public_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = result.attachment.original_name;
    $('#uploadResult').replaceChildren(link);
  };
}

async function savedPanel() {
  const saved = (await api('/saved-messages')).messages;
  panel(`
    <h3>Сохранённые</h3>
    ${saved.map(message => `
      <div class="chat-item">
        <b>${escapeHtml(message.display_name)}</b>
        <div>${escapeHtml(message.body)}</div>
        <div class="muted">${escapeHtml(message.note || '')}</div>
      </div>
    `).join('') || '<p class="muted">Сохранённых сообщений пока нет.</p>'}
  `);
}

async function receiptsPanel(id) {
  const receipts = (await api(`/messages/${id}/receipts`)).receipts;
  panel(`
    <h3>Статусы</h3>
    ${receipts.map(receipt => `
      <div class="row">
        <span>${escapeHtml(receipt.display_name)}</span>
        <span class="muted">${receipt.read_at ? 'прочитано' : receipt.delivered_at ? 'доставлено' : 'отправлено'}</span>
      </div>
    `).join('') || '<p class="muted">Нет статусов.</p>'}
  `);
}

function defaultIceServers() {
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

function chatName(chatId) {
  const chat = state.chats.find(item => item.id === chatId) || state.activeChat;
  return chat?.title || (chat?.type === 'private' ? 'Личный чат' : 'Собеседник');
}

function callStatusText() {
  if (!state.call) return 'Звонок';
  if (state.call.status === 'incoming') return 'Входящий звонок…';
  if (state.call.status === 'outgoing') return 'Исходящий звонок…';
  if (state.call.status === 'connecting') return 'Соединение WebRTC…';
  if (state.call.status === 'active') return state.call.isGroup ? 'Групповой разговор идёт' : 'Разговор идёт';
  return 'Звонок завершён';
}

function sendCallSignal(signal, targetUserId) {
  if (!state.call || state.ws?.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({
    event: 'call:signal',
    chatId: state.call.chatId,
    callId: state.call.id,
    targetUserId,
    signal,
  }));
}

function sendCallJoin() {
  if (!state.call || state.ws?.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ event: 'call:join', chatId: state.call.chatId, callId: state.call.id }));
}

async function ensureLocalCallStream(type) {
  if (state.call?.localStream) return state.call.localStream;
  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } : false,
  });
  state.call.localStream = localStream;
  return localStream;
}

async function createPeerConnection({ remoteUserId, type, rtc, initiator }) {
  const localStream = await ensureLocalCallStream(type);
  const remoteStream = new MediaStream();
  const pc = new RTCPeerConnection({ iceServers: rtc?.iceServers || defaultIceServers() });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = event => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
    state.call.remoteStreams.set(remoteUserId, remoteStream);
    attachCallMedia();
  };

  pc.onicecandidate = event => {
    if (event.candidate) sendCallSignal({ type: 'candidate', candidate: event.candidate }, remoteUserId);
  };

  pc.onconnectionstatechange = () => {
    if (!state.call) return;
    if (['connected', 'completed'].includes(pc.connectionState)) {
      state.call.status = 'active';
      renderCallWindow();
    }
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      if (pc.connectionState === 'failed') toast('WebRTC соединение прервано');
    }
  };

  state.call.peers.set(remoteUserId, pc);
  state.call.remoteStreams.set(remoteUserId, remoteStream);
  renderCallWindow();
  attachCallMedia();

  if (initiator) {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: type === 'video' });
    await pc.setLocalDescription(offer);
    sendCallSignal({ type: 'offer', sdp: offer }, remoteUserId);
  }
  return pc;
}

function attachCallMedia() {
  if (!state.call) return;
  const local = $('#localVideo');
  if (local && state.call.localStream) local.srcObject = state.call.localStream;
  for (const [userId, stream] of state.call.remoteStreams.entries()) {
    const video = document.getElementById(`remoteVideo-${userId}`);
    const audio = document.getElementById(`remoteAudio-${userId}`);
    if (video) video.srcObject = stream;
    if (audio) audio.srcObject = stream;
  }
}

function remoteUserName(userId) {
  const participant = state.call?.participants?.find(item => item.user_id === userId);
  return participant?.display_name || participant?.username || 'Участник';
}

function renderRemoteMedia() {
  if (!state.call?.remoteStreams?.size) return '<div class="call-avatar"></div>';
  return `<div class="call-remote-grid">${[...state.call.remoteStreams.keys()].map(userId => `
    <div class="call-remote-tile">
      <video id="remoteVideo-${userId}" class="call-video-tile ${state.call.type === 'video' ? '' : 'hidden'}" autoplay playsinline></video>
      <audio id="remoteAudio-${userId}" autoplay></audio>
      <div class="call-tile-name">${escapeHtml(remoteUserName(userId))}</div>
    </div>
  `).join('')}</div>`;
}

function renderCallWindow() {
  const layer = $('#callLayer');
  if (!layer || !state.call) return;
  const isVideo = state.call.type === 'video';
  const isIncoming = state.call.status === 'incoming';
  const isActive = ['active', 'connecting', 'outgoing'].includes(state.call.status);
  const participantCount = state.call.participants?.length || state.call.remoteUserIds?.length || 1;
  layer.innerHTML = `
    <div class="call-overlay">
      <div class="call-window ${state.call.isGroup ? 'group-call-window' : ''}">
        <div class="call-header">
          <div class="call-name">${escapeHtml(chatName(state.call.chatId))}</div>
          <div class="call-status">${callStatusText()} · ${participantCount} участников</div>
        </div>
        <div class="call-center">
          ${renderRemoteMedia()}
          <div class="call-name">${escapeHtml(chatName(state.call.chatId))}</div>
          <video id="localVideo" class="call-local-video ${isVideo && isActive ? '' : 'hidden'}" autoplay playsinline muted></video>
        </div>
        <div class="call-controls">
          <button class="call-btn end" id="declineCall" title="Отклонить / завершить">
            <svg class="icon" viewBox="0 0 24 24"><path d="M6 6 L18 18"/><path d="M18 6 L6 18"/></svg>
          </button>
          ${isIncoming ? `
            <button class="call-btn accept" id="acceptCall" title="Принять">
              <svg class="icon" viewBox="0 0 24 24"><path d="M4 10c2 5 5 8 10 10"/><path d="M8 6c2 2 3 3 4 6"/><path d="M14 6l6 6"/></svg>
            </button>
          ` : ''}
          <button class="call-btn" id="toggleVideo" title="Видео">
            <svg class="icon" viewBox="0 0 24 24"><path d="M4 7h10v10H4z"/><path d="M14 10l6-3v10l-6-3z"/></svg>
          </button>
        </div>
        <div class="call-footer">
          <button class="call-small" id="toggleMute" title="Микрофон"><svg class="icon" viewBox="0 0 24 24"><path d="M3 10v4"/><path d="M7 8v8"/><path d="M11 6v12"/></svg></button>
          <button class="call-small" id="copyCallId" title="ID звонка"><svg class="icon" viewBox="0 0 24 24"><path d="M6 4h12v16H6z"/><path d="M9 8h6"/></svg></button>
          <button class="call-small" id="shareScreen" title="Демонстрация экрана"><svg class="icon" viewBox="0 0 24 24"><path d="M12 2v20"/><path d="M2 12h20"/></svg></button>
        </div>
      </div>
    </div>
  `;
  $('#declineCall').onclick = () => endCall(isIncoming ? 'rejected' : 'ended');
  if ($('#acceptCall')) $('#acceptCall').onclick = acceptCall;
  $('#toggleMute').onclick = toggleMute;
  $('#toggleVideo').onclick = toggleCamera;
  $('#copyCallId').onclick = () => navigator.clipboard?.writeText(state.call.id).then(() => toast('ID звонка скопирован'));
  $('#shareScreen').onclick = shareScreen;
  attachCallMedia();
}

async function callParticipants(callId) {
  return api(`/calls/${callId}/participants`).then(result => result.participants).catch(() => []);
}

function activeParticipantIds(participants) {
  return participants.filter(item => item.user_id !== state.user.id && ['joined','invited'].includes(item.status)).map(item => item.user_id);
}

async function startCall(type) {
  if (!state.activeChat) return toast('Выберите чат');
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast('Браузер не поддерживает WebRTC');
  if (state.call) return toast('Звонок уже активен');

  const result = await api('/calls', { method: 'POST', body: { chatId: state.activeChat.id, type } });
  const participants = await callParticipants(result.call.id);
  const remoteUserIds = activeParticipantIds(participants);
  state.call = {
    id: result.call.id,
    chatId: result.call.chat_id,
    type: result.call.type,
    status: 'outgoing',
    rtc: result.rtc,
    peers: new Map(),
    remoteStreams: new Map(),
    participants,
    remoteUserIds,
    isGroup: state.activeChat.type === 'group' || remoteUserIds.length > 1,
    muted: false,
    cameraOff: false,
  };
  await ensureLocalCallStream(type);
  renderCallWindow();
  for (const userId of remoteUserIds) await createPeerConnection({ remoteUserId: userId, type, rtc: result.rtc, initiator: true });
}

function handleIncomingCall(payload) {
  const call = payload.call || payload;
  if (!call || call.initiator_id === state.user.id || state.call) return;
  const participants = payload.participants || [];
  const remoteUserIds = participants.length ? activeParticipantIds(participants) : [call.initiator_id].filter(Boolean);
  state.call = {
    id: call.id,
    chatId: call.chat_id,
    type: call.type,
    status: 'incoming',
    rtc: payload.rtc,
    peers: new Map(),
    remoteStreams: new Map(),
    participants,
    remoteUserIds,
    isGroup: participants.length > 2,
    muted: false,
    cameraOff: false,
  };
  renderCallWindow();
}

async function acceptCall() {
  if (!state.call) return;
  await api(`/calls/${state.call.id}`, { method: 'PATCH', body: { status: 'active' } }).catch(() => {});
  state.call.participants = await callParticipants(state.call.id);
  state.call.remoteUserIds = activeParticipantIds(state.call.participants);
  state.call.isGroup = state.call.participants.length > 2;
  state.call.status = 'connecting';
  await ensureLocalCallStream(state.call.type);
  renderCallWindow();
  await flushPendingSignals(state.call.id);
  sendCallJoin();
}

function handleCallUpdate(payload) {
  const call = payload.call || payload;
  if (!state.call || call.id !== state.call.id) return;
  if (['ended', 'missed', 'rejected'].includes(call.status)) cleanupCall(false);
}

async function handleCallJoin(payload) {
  if (!state.call || payload.callId !== state.call.id || payload.userId === state.user.id || !state.call.localStream) return;
  state.call.participants = await callParticipants(state.call.id);
  if (!state.call.peers.has(payload.userId)) {
    await createPeerConnection({ remoteUserId: payload.userId, type: state.call.type, rtc: state.call.rtc, initiator: true });
  }
}

async function handleCallSignal(payload) {
  if (!payload || payload.from === state.user.id) return;
  if (payload.targetUserId && payload.targetUserId !== state.user.id) return;
  if (!state.call || state.call.id !== payload.callId || !state.call.localStream) {
    const pending = state.pendingCallSignals.get(payload.callId) || [];
    pending.push(payload);
    state.pendingCallSignals.set(payload.callId, pending);
    return;
  }
  await applyCallSignal(payload.from, payload.signal);
}

async function flushPendingSignals(callId) {
  const pending = state.pendingCallSignals.get(callId) || [];
  state.pendingCallSignals.delete(callId);
  for (const payload of pending) await applyCallSignal(payload.from, payload.signal);
}

async function applyCallSignal(remoteUserId, signal) {
  if (!state.call || !signal || !remoteUserId) return;
  let pc = state.call.peers.get(remoteUserId);
  if (!pc) pc = await createPeerConnection({ remoteUserId, type: state.call.type, rtc: state.call.rtc, initiator: false });
  if (signal.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendCallSignal({ type: 'answer', sdp: answer }, remoteUserId);
  }
  if (signal.type === 'answer') await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
  if (signal.type === 'candidate' && signal.candidate) await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
}

async function endCall(status = 'ended') {
  if (!state.call) return;
  const id = state.call.id;
  const apiStatus = state.call.isGroup && status === 'ended' ? 'left' : status;
  cleanupCall(false);
  await api(`/calls/${id}`, { method: 'PATCH', body: { status: apiStatus } }).catch(() => {});
}

function cleanupCall(showToast = true) {
  if (!state.call) return;
  state.call.localStream?.getTracks().forEach(track => track.stop());
  for (const stream of state.call.remoteStreams?.values?.() || []) stream.getTracks().forEach(track => track.stop());
  for (const pc of state.call.peers?.values?.() || []) pc.close();
  state.pendingCallSignals.delete(state.call.id);
  state.call = null;
  const layer = $('#callLayer');
  if (layer) layer.innerHTML = '';
  if (showToast) toast('Звонок завершён');
}

function toggleMute() {
  if (!state.call?.localStream) return;
  state.call.muted = !state.call.muted;
  state.call.localStream.getAudioTracks().forEach(track => { track.enabled = !state.call.muted; });
  toast(state.call.muted ? 'Микрофон выключен' : 'Микрофон включён');
}

function toggleCamera() {
  if (!state.call?.localStream) return;
  state.call.cameraOff = !state.call.cameraOff;
  state.call.localStream.getVideoTracks().forEach(track => { track.enabled = !state.call.cameraOff; });
  toast(state.call.cameraOff ? 'Камера выключена' : 'Камера включена');
}

async function shareScreen() {
  if (!state.call?.peers?.size || !navigator.mediaDevices?.getDisplayMedia) return toast('Демонстрация экрана недоступна');
  const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const screenTrack = screen.getVideoTracks()[0];
  const senders = [...state.call.peers.values()].map(pc => pc.getSenders().find(item => item.track?.kind === 'video')).filter(Boolean);
  await Promise.all(senders.map(sender => sender.replaceTrack(screenTrack)));
  screenTrack.onended = async () => {
    const cameraTrack = state.call?.localStream?.getVideoTracks()[0];
    if (cameraTrack) await Promise.all(senders.map(sender => sender.replaceTrack(cameraTrack)));
  };
}

async function react(id) {
  await api(`/messages/${id}/reactions`, { method: 'POST', body: { emoji: 'like' } });
  toast('Реакция добавлена');
}

async function saveMsg(id) {
  const note = prompt('Заметка к сохранённому сообщению') || '';
  await api(`/messages/${id}/save`, { method: 'POST', body: { note } });
  toast('Сообщение сохранено');
}

async function editMsg(id) {
  const body = prompt('Новый текст');
  if (!body) return;
  await api(`/messages/${id}`, { method: 'PATCH', body: { body } });
  await selectChat(state.activeChat.id);
}

async function delMsg(id) {
  if (!confirm('Удалить?')) return;
  await api(`/messages/${id}`, { method: 'DELETE' });
  await selectChat(state.activeChat.id);
}

async function blockUser(id) {
  await api(`/contacts/${id}/block`, { method: 'POST' });
  contactsPanel();
}

async function removeMember(id) {
  await api(`/chats/${state.activeChat.id}/members/${id}`, { method: 'DELETE' });
  membersPanel();
}

async function registerDevice() {
  await api('/devices', { method: 'POST', body: { name: navigator.platform || 'Web browser' } });
  devicesPanel();
}

async function deleteDevice(id) {
  await api(`/devices/${id}`, { method: 'DELETE' });
  devicesPanel();
}

function toast(text) {
  const element = document.createElement('div');
  element.className = 'panel';
  element.style.top = '20px';
  element.textContent = text;
  document.body.appendChild(element);
  setTimeout(() => element.remove(), 2500);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

startNetworkMonitor();

if (state.token) {
  loadApp().catch(() => authView('login'));
} else {
  authView('login');
}
