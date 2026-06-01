# Liquid Messenger Desktop

Полноценный Electron-клиент Liquid Messenger. Он не переписывает интерфейс заново, а запускает тот же web/PWA интерфейс `apps/web/public`, поэтому регистрация, чат, группы, WebRTC-звонки, настройки, файлы, поиск, предупреждение о пинге и offline mini-game остаются одинаковыми в web и desktop.

## Режимы запуска

### Embedded backend (по умолчанию)

Electron поднимает локальный gateway из `backend/gateway/src/server.js`, ждёт `/api/health` и открывает приложение на `http://127.0.0.1:18080`.

```bash
cd apps/desktop
npm install
npm run start:embedded
```

Нужна рабочая `DATABASE_URL` на PostgreSQL, как и для web/backend версии.

### Remote/hosted backend

Desktop может подключиться к уже развернутому сайту, сохраняя тот же интерфейс и функции:

```bash
cd apps/desktop
LIQUID_MESSENGER_URL=https://messenger.example.com npm start
```

## Desktop-функции

- native window с context isolation, sandbox, отключённым Node.js в renderer и безопасным открытием внешних ссылок;
- tray menu: открыть, перезагрузить интерфейс, сбросить badge, выйти;
- native notifications через preload bridge `window.LiquidDesktop`;
- badge unread-счётчик для входящих сообщений/уведомлений;
- разрешения на микрофон, камеру, уведомления и screen sharing только для origin активного messenger-сервера;
- single-instance lock, чтобы второй запуск фокусировал уже открытое окно;
- embedded gateway lifecycle: процесс backend завершается вместе с desktop-приложением.

## Packaging

```bash
cd apps/desktop
npm install
npm run pack
npm run dist
```

Для production-сборки укажите реальные `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`, `STUN_URL` и TURN-настройки, если пользователи будут звонить через NAT.
