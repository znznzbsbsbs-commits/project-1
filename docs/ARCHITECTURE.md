# Liquid Messenger architecture

This repository implements the requested physical structure as a deployable monorepo. The runnable production path is `apps/web` plus `backend/gateway`, with PostgreSQL migrations in `database/migrations` and Docker/Nginx deployment files.

## Implemented capabilities
- Web landing/auth shell: login, registration, forgot/reset API, PWA manifest and service worker.
- Chat interface copied from the supplied liquid-glass/3D HTML style.
- JWT access and refresh tokens, logout, password hashing, password reset tokens, roles.
- Users, profiles, privacy/settings, contacts, blocking, device sessions and push subscriptions.
- Private chats, groups, channels, membership management, message history, editing, deletion, pinning, reactions, replies/thread fields, saved messages, read/delivery receipts and full-text search.
- WebSocket realtime messages, typing indicators, presence and WebRTC signaling events.
- Voice/video call records, call participants and STUN config returned to the client.
- File uploads with typed attachments and public serving.
- Notifications, reports, moderation/admin stats.
- PostgreSQL schema, Docker Compose, Nginx reverse proxy, health checks and deploy script.

## Run locally
```bash
cp .env.example .env
docker compose up --build
# Optional seed data:
docker compose exec app npm run seed
```
Open http://localhost:8080. Seed users use password `Password123!`.


## Security and performance hardening

- Strict Helmet security headers and CSP, disabled `x-powered-by`, production JWT secret enforcement and restricted CORS.
- Separate auth, HTTP and WebSocket rate limits; WebSocket heartbeat, max payload and membership checks.
- PostgreSQL `LISTEN/NOTIFY` realtime fanout so several Node workers/replicas can deliver chat events without a single in-memory bottleneck.
- Indexed user search (`/api/search/users`) with prefix/trigram indexes, plus debounced/cancellable frontend search.
- Upload MIME allow-list, sanitized filenames and cached immutable static/upload assets.
- Nginx keepalive, least-connection upstream, WebSocket timeouts and static upload caching for 500+ active users.
- Offline and high-ping states show an automatic reconnect surface; full offline mode includes a local mini-game while the real health checks continue independently.


## Real WebRTC calls

- Voice/video calls use browser `getUserMedia`, `RTCPeerConnection`, SDP offer/answer and ICE candidates.
- The existing WebSocket realtime channel carries signaling (`call:ring`, `call:join`, `call:update`, `call:signal`), while media flows peer-to-peer over WebRTC.
- Configure `STUN_URL` and optional `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` for NAT traversal in production.
- The web UI includes the supplied liquid 3D incoming-call screen with accept, reject, mute, camera toggle and screen-share controls.
- Group calls use a real browser mesh: every joined participant creates targeted peer connections to other group members, with participant status stored in PostgreSQL and call-join events broadcast to the room.


## Full settings

- The settings screen follows the supplied liquid-glass settings design and uses inline SVG icons drawn in the client instead of emoji glyphs.
- Profile, bio, privacy, notification, sound, language, theme, compact mode, reduced motion, device registration/removal and logout controls are wired to real API state.


## Connection quality warning

- The web client continuously measures `/api/health` latency with a timeout and shows the supplied liquid-glass loading warning when the server ping is repeatedly high or the connection drops.
- The warning includes a spinner, animated dots and signal bars, and automatically hides after latency returns to normal.


## Implemented application and service folders

- `apps/admin` is a working moderation console served at `/admin`.
- `apps/desktop` contains a full Electron client that reuses the web UI, can start an embedded gateway, supports tray integration, native notifications, unread badges and WebRTC media/screen permissions.
- `apps/mobile` contains a React Native client with login, chat loading, WebSocket updates and message sending.
- Each backend service folder now contains a `service.json` contract describing real routes, data tables, realtime events and security controls.
- `npm run security:audit` checks critical hardening controls and rejects disabled CSP, emoji UI regressions and malformed service contracts.

## Extension platform

Liquid Messenger now has a first-class extension platform shared by Web and Electron:

- `apps/web/public/extensions.js` is the browser Extension Host. It validates manifests, enforces permission-gated SDK APIs, loads same-origin extension modules, owns UI slots, commands, events, storage, themes, notifications and high-level call actions.
- `app/core`, `app/extensions` and `app/sdk` contain reusable source modules for future plugin tooling: event bus, namespaced storage, manifest validation and permission descriptions.
- `apps/web/public/plugins/*` contains official extensions that double as working examples: Core Tools, Theme Pack and Safe Mode Controller.
- `extension_marketplace`, `user_extensions`, `extension_history` and `extension_reports` persist marketplace entries, installs, rollback history and abuse reports.
- `/api/extensions`, `/api/extensions/install/:id`, `/api/extensions/:id/enable`, `/api/extensions/:id/disable`, `/api/extensions/:id`, `/api/extensions/safe-mode`, `/api/extensions/rollback-last` and report/history endpoints power the manager UI.
- Settings -> Extensions is the recovery and marketplace UI. Safe Mode skips plugin activation without deleting installed files; rollback disables the last installed/enabled extension.

Extensions never receive raw Node/Electron access or raw call media. Call permissions expose only high-level actions such as mute, camera toggle, screen share and participant listing.
