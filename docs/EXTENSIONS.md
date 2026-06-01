# Liquid Messenger Extension System

## Goal

Extensions let users and third-party developers add buttons, pages, settings, commands, events, themes, integrations and high-level call controls without changing the core messenger code. The same model runs in Web and Electron because the runtime SDK lives in the renderer and exposes only permission-gated APIs.

## Runtime architecture

```text
Core App -> Extension Host -> Public SDK API -> Extensions
```

- **Core App**: auth, chat UI, settings, calls, storage and realtime state.
- **Extension Host**: `apps/web/public/extensions.js`; validates manifests, checks permissions, audits extension source before activation, loads same-origin modules, sanitizes extension-rendered HTML, controls lifecycle and Safe Mode.
- **Public SDK API**: `api.ui`, `api.commands`, `api.events`, `api.storage`, `api.theme`, `api.notifications`, `api.calls`.
- **Source SDK**: `app/sdk/index.js`, `app/extensions/*`, `app/core/*` for future packaging and developer tooling.

## Extension package format

A runtime package lives under `apps/web/public/plugins/<id>/` and uses the same manifest layout that `.myext` archives must contain. The file layout is:

```text
weather-extension/
├── manifest.json
├── index.js
├── icon.png
└── assets/
```

`manifest.json`:

```json
{
  "id": "weather",
  "name": "Weather",
  "version": "1.0.0",
  "author": "Developer",
  "permissions": ["ui", "network", "storage"],
  "entry": "index.js"
}
```

`index.js` must export `activate(api)` and may export `deactivate()`.

## UI slots

Supported slots are:

- `header.left`, `header.center`, `header.right`
- `sidebar.top`, `sidebar.content`, `sidebar.bottom`
- `settings.general`, `settings.account`, `settings.plugins`
- `profile.actions`, `profile.widgets`
- `dashboard.toolbar`, `message.actions`, `toolbar`

Example:

```js
export function activate(api) {
  api.ui.addButton({
    slot: 'header.right',
    id: 'translate',
    title: 'Translate',
    onClick() { api.events.emit('translate.clicked'); }
  });
}
```

## Permissions

Safe permissions:

- `ui`, `storage`, `commands`, `notifications`, `events`, `theme`

Sensitive permissions:

- `network`, `voice`, `video`, `call-events`

Critical permissions:

- `microphone`, `camera`, `screenshare`, `filesystem`, `desktop`, `admin`

The call API deliberately exposes only high-level actions, not raw microphone/video streams:

```js
api.calls.mute();
api.calls.unmute();
api.calls.enableCamera();
api.calls.disableCamera();
api.calls.startScreenShare();
api.calls.getParticipants();
```

Network integrations must use the SDK request wrapper instead of direct `fetch`, so credentials are omitted and HTTPS/timeouts are enforced:

```js
const result = await api.network.request('https://api.example.com/status', { timeout: 5000 });
```

## Marketplace and recovery

The gateway persists extension data in:

- `extension_marketplace`
- `user_extensions`
- `extension_history`
- `extension_reports`

Users manage extensions in **Settings -> Extensions**. They can install official extensions, update them from marketplace metadata, disable/enable/remove, report, enable Safe Mode and roll back the last extension change. Safe Mode skips all extension activation and protects against broken themes, widgets and plugins without deleting files.

## Official examples

- `core-tools`: commands, buttons and high-level call actions.
- `theme-pack`: theme registration and applying CSS through the SDK.
- `safe-mode-controller`: recovery messaging and extension events.
