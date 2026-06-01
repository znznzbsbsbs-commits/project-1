# Liquid Messenger Admin

Production moderation console served from `/admin`. It authenticates with the same JWT API, enforces admin/moderator role on the client and backend, displays live platform counters, lists abuse reports, resolves/rejects reports and searches users through `/api/search/users`.

## Files

- `public/index.html` — standalone admin shell.
- `public/app.js` — login, stats, reports and user search flows.
- `public/styles.css` — liquid-glass admin UI.

## Run

Start the backend and open `http://localhost:8080/admin/`.
