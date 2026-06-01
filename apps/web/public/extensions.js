(function () {
  const SAFE_PERMISSIONS = new Set(['ui', 'storage', 'commands', 'notifications', 'events']);
  const SENSITIVE_PERMISSIONS = new Set(['network', 'voice', 'call-events']);
  const CRITICAL_PERMISSIONS = new Set(['microphone', 'camera', 'screenshare', 'filesystem', 'desktop', 'admin']);
  const ALL_PERMISSIONS = new Set([...SAFE_PERMISSIONS, ...SENSITIVE_PERMISSIONS, ...CRITICAL_PERMISSIONS, 'theme', 'video']);
  const SLOT_NAMES = ['header.left', 'header.center', 'header.right', 'sidebar.top', 'sidebar.content', 'sidebar.bottom', 'settings.general', 'settings.account', 'settings.plugins', 'profile.actions', 'profile.widgets', 'dashboard.toolbar', 'message.actions', 'toolbar'];
  const state = {
    installed: [],
    manifests: new Map(),
    buttons: new Map(),
    pages: new Map(),
    settingsSections: new Map(),
    commands: new Map(),
    listeners: new Map(),
    themes: new Map(),
    activeModules: new Map(),
    context: {},
    safeMode: localStorage.getItem('extensions.safeMode') === 'true',
  };

  function permissionLevel(permission) {
    if (CRITICAL_PERMISSIONS.has(permission)) return 'critical';
    if (SENSITIVE_PERMISSIONS.has(permission)) return 'sensitive';
    return 'safe';
  }

  function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') throw new Error('Manifest должен быть объектом');
    for (const key of ['id', 'name', 'version', 'entry']) {
      if (!manifest[key] || typeof manifest[key] !== 'string') throw new Error(`Manifest: поле ${key} обязательно`);
    }
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(manifest.id)) throw new Error('Manifest: некорректный id');
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (const permission of permissions) {
      if (!ALL_PERMISSIONS.has(permission)) throw new Error(`Manifest: неизвестное разрешение ${permission}`);
    }
    return { ...manifest, permissions };
  }

  function hasPermission(manifest, permission) {
    return manifest.permissions.includes(permission);
  }

  function requirePermission(manifest, permission) {
    if (!hasPermission(manifest, permission)) throw new Error(`Расширению ${manifest.name} нужно разрешение ${permission}`);
  }

  function resolveEntry(manifest) {
    if (/^https?:\/\//i.test(manifest.entry)) throw new Error('Внешние entry URL запрещены');
    const base = `/plugins/${manifest.id}/`;
    return new URL(manifest.entry, `${location.origin}${base}`).href;
  }

  function slotRoot(slot) {
    return document.querySelector(`[data-extension-slot="${slot}"]`);
  }

  function emit(eventName, payload) {
    for (const listener of state.listeners.get(eventName) || []) listener(payload);
  }

  function namespacedKey(extensionId, key) {
    return `extension:${extensionId}:${key}`;
  }

  function sanitizeHtml(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value || '');
    template.content.querySelectorAll('script,iframe,object,embed,link,meta,base,form').forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const val = String(attr.value || '').trim().toLowerCase();
        if (name.startsWith('on') || val.startsWith('javascript:') || (name === 'style' && /url\s*\(/i.test(val))) node.removeAttribute(attr.name);
      }
    });
    return template.innerHTML;
  }

  async function safeNetworkRequest(manifest, url, options = {}) {
    requirePermission(manifest, 'network');
    const target = new URL(url, location.origin);
    if (target.protocol !== 'https:' && target.origin !== location.origin) throw new Error('Network API разрешает только HTTPS или текущий origin');
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('HTTP method запрещён для расширений');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(Number(options.timeout || 8000), 15000));
    try {
      const response = await fetch(target.href, {
        method,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        body: options.body == null ? undefined : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)),
        credentials: 'omit',
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json') ? await response.json() : await response.text();
      return { ok: response.ok, status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function auditExtensionSource(manifest) {
    const source = await fetch(resolveEntry(manifest), { credentials: 'same-origin', cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error(`Не удалось загрузить код расширения ${manifest.id}`);
      return response.text();
    });
    const forbidden = [
      ['require' + '(', 'CommonJS loader запрещён'],
      ['child' + '_process', 'process spawning запрещён'],
      ['elec' + 'tron', 'Desktop runtime API запрещён'],
      ['localStorage', 'Прямой localStorage запрещён: используйте api.storage'],
      ['sessionStorage', 'Прямой sessionStorage запрещён: используйте api.storage'],
      ['document.', 'Прямой DOM запрещён: используйте api.ui'],
      ['window.', 'Прямой window запрещён: используйте SDK'],
      ['eval(', 'eval запрещён'],
      ['new Function', 'Function constructor запрещён'],
      ['XMLHttpRequest', 'XMLHttpRequest запрещён: используйте api.network.request'],
      ['WebSocket', 'WebSocket запрещён для расширений'],
      ['EventSource', 'EventSource запрещён для расширений'],
    ];
    for (const [needle, message] of forbidden) {
      if (source.includes(needle)) throw new Error(`${manifest.id}: ${message}`);
    }
    if (/\bfetch\s*\(/.test(source)) throw new Error(`${manifest.id}: прямой fetch запрещён, используйте api.network.request`);
  }

  function createApi(manifest) {
    const extensionId = manifest.id;
    return Object.freeze({
      manifest: Object.freeze({ ...manifest }),
      ui: Object.freeze({
        addButton(definition) {
          requirePermission(manifest, 'ui');
          if (!definition?.id || !definition?.slot || !SLOT_NAMES.includes(definition.slot)) throw new Error('Некорректная кнопка расширения');
          state.buttons.set(`${extensionId}:${definition.id}`, { ...definition, extensionId });
          renderSlots();
        },
        addPage(definition) {
          requirePermission(manifest, 'ui');
          if (!definition?.id || !definition?.title || typeof definition.component !== 'function') throw new Error('Некорректная страница расширения');
          state.pages.set(`${extensionId}:${definition.id}`, { ...definition, extensionId });
          renderSlots();
        },
        addSettingsSection(definition) {
          requirePermission(manifest, 'ui');
          if (!definition?.id || !definition?.title || typeof definition.component !== 'function') throw new Error('Некорректная секция настроек расширения');
          state.settingsSections.set(`${extensionId}:${definition.id}`, { ...definition, extensionId });
        },
      }),
      commands: Object.freeze({
        register(definition) {
          requirePermission(manifest, 'commands');
          if (!definition?.id || !definition?.title || typeof definition.execute !== 'function') throw new Error('Некорректная команда');
          state.commands.set(`${extensionId}:${definition.id}`, { ...definition, extensionId });
        },
        execute(id, payload) {
          requirePermission(manifest, 'commands');
          const command = state.commands.get(id) || state.commands.get(`${extensionId}:${id}`);
          if (!command) throw new Error(`Команда ${id} не найдена`);
          return command.execute(payload);
        },
        list() {
          requirePermission(manifest, 'commands');
          return [...state.commands.values()].map(command => ({ id: `${command.extensionId}:${command.id}`, title: command.title }));
        },
      }),
      events: Object.freeze({
        on(eventName, callback) {
          requirePermission(manifest, 'events');
          if (typeof callback !== 'function') throw new Error('Callback обязателен');
          const listeners = state.listeners.get(eventName) || new Set();
          listeners.add(callback);
          state.listeners.set(eventName, listeners);
          return () => listeners.delete(callback);
        },
        emit(eventName, payload) {
          requirePermission(manifest, 'events');
          emit(eventName, payload);
        },
      }),
      storage: Object.freeze({
        get(key) {
          requirePermission(manifest, 'storage');
          return JSON.parse(localStorage.getItem(namespacedKey(extensionId, key)) || 'null');
        },
        set(key, value) {
          requirePermission(manifest, 'storage');
          localStorage.setItem(namespacedKey(extensionId, key), JSON.stringify(value));
        },
        remove(key) {
          requirePermission(manifest, 'storage');
          localStorage.removeItem(namespacedKey(extensionId, key));
        },
      }),
      theme: Object.freeze({
        register(definition) {
          if (!hasPermission(manifest, 'theme') && !hasPermission(manifest, 'ui')) throw new Error('Для темы нужно разрешение theme или ui');
          if (!definition?.id || !definition?.name || typeof definition.css !== 'string') throw new Error('Некорректная тема');
          state.themes.set(`${extensionId}:${definition.id}`, { ...definition, extensionId });
        },
        apply(id) {
          const theme = state.themes.get(id) || state.themes.get(`${extensionId}:${id}`);
          if (!theme) throw new Error(`Тема ${id} не найдена`);
          let tag = document.getElementById('extensionThemeStyle');
          if (!tag) {
            tag = document.createElement('style');
            tag.id = 'extensionThemeStyle';
            document.head.appendChild(tag);
          }
          tag.textContent = theme.css;
        },
      }),
      network: Object.freeze({
        request(url, options) {
          return safeNetworkRequest(manifest, url, options);
        },
      }),
      notifications: Object.freeze({
        show(title, body) {
          requirePermission(manifest, 'notifications');
          state.context.notify?.(title, body);
        },
      }),
      calls: Object.freeze({
        join(callId) { requirePermission(manifest, 'voice'); return state.context.calls?.join?.(callId); },
        leave(callId) { requirePermission(manifest, 'voice'); return state.context.calls?.leave?.(callId); },
        mute() { requirePermission(manifest, 'microphone'); return state.context.calls?.mute?.(); },
        unmute() { requirePermission(manifest, 'microphone'); return state.context.calls?.unmute?.(); },
        enableCamera() { requirePermission(manifest, 'camera'); return state.context.calls?.enableCamera?.(); },
        disableCamera() { requirePermission(manifest, 'camera'); return state.context.calls?.disableCamera?.(); },
        startScreenShare() { requirePermission(manifest, 'screenshare'); return state.context.calls?.startScreenShare?.(); },
        getParticipants() { requirePermission(manifest, 'call-events'); return state.context.calls?.getParticipants?.() || []; },
      }),
    });
  }

  function renderButton(button) {
    const element = document.createElement('button');
    element.className = 'small-btn extension-button';
    element.type = 'button';
    element.dataset.extensionButton = `${button.extensionId}:${button.id}`;
    element.textContent = button.title || button.id;
    element.title = button.title || button.id;
    element.onclick = () => button.onClick?.();
    return element;
  }

  function renderSlots() {
    for (const slot of SLOT_NAMES) {
      const root = slotRoot(slot);
      if (!root) continue;
      root.replaceChildren();
      for (const button of state.buttons.values()) {
        if (button.slot === slot) root.appendChild(renderButton(button));
      }
      if (slot === 'sidebar.bottom') {
        for (const page of state.pages.values()) root.appendChild(renderButton({ ...page, onClick: () => openPage(`${page.extensionId}:${page.id}`) }));
      }
    }
  }

  function openPage(pageId) {
    const page = state.pages.get(pageId);
    if (!page) return;
    state.context.panel?.(`<h3>${escapeHtml(page.title)}</h3><div class="extension-page" id="extensionPageHost"></div>`);
    const root = document.getElementById('extensionPageHost');
    const result = page.component({ manifest: state.manifests.get(page.extensionId) });
    if (result instanceof HTMLElement) root.replaceChildren(result);
    else root.innerHTML = sanitizeHtml(result);
    emit('window.open', { route: page.route || page.id, extensionId: page.extensionId });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  async function activateExtension(record) {
    if (state.safeMode || record.enabled === false || state.activeModules.has(record.id)) return;
    const manifest = validateManifest(record.manifest || record);
    state.manifests.set(manifest.id, manifest);
    await auditExtensionSource(manifest);
    const module = await import(resolveEntry(manifest)).catch(error => ({ activate: () => { throw error; } }));
    if (typeof module.activate !== 'function') throw new Error(`Расширение ${manifest.id} не экспортирует activate(api)`);
    await module.activate(createApi(manifest));
    state.activeModules.set(manifest.id, module);
    emit('extension.activated', { id: manifest.id });
  }

  async function deactivateExtension(id) {
    const module = state.activeModules.get(id);
    if (module?.deactivate) await module.deactivate();
    state.activeModules.delete(id);
    for (const map of [state.buttons, state.pages, state.settingsSections, state.commands, state.themes]) {
      for (const key of [...map.keys()]) if (key.startsWith(`${id}:`)) map.delete(key);
    }
    renderSlots();
    emit('extension.deactivated', { id });
  }

  async function loadInstalled(records = []) {
    state.installed = records;
    if (state.safeMode) return renderSlots();
    for (const record of records) await activateExtension(record);
    renderSlots();
    emit('extensions.ready', { count: state.activeModules.size });
  }

  function configure(context = {}) {
    state.context = { ...state.context, ...context };
  }

  function setSafeMode(enabled) {
    state.safeMode = Boolean(enabled);
    localStorage.setItem('extensions.safeMode', String(state.safeMode));
  }

  window.LiquidExtensions = Object.freeze({
    configure,
    loadInstalled,
    activateExtension,
    deactivateExtension,
    renderSlots,
    setSafeMode,
    state,
    sanitizeHtml,
    permissions: Object.freeze({ safe: [...SAFE_PERMISSIONS], sensitive: [...SENSITIVE_PERMISSIONS], critical: [...CRITICAL_PERMISSIONS], level: permissionLevel }),
  });
}());
