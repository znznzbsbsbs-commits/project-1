const state = { token: localStorage.adminToken || '', user: null };
const $ = selector => document.querySelector(selector);
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function showDashboard() { $('#authCard').classList.add('hidden'); $('#dashboard').classList.remove('hidden'); }
function showAuth() { $('#dashboard').classList.add('hidden'); $('#authCard').classList.remove('hidden'); }
async function loadStats() {
  const stats = await api('/admin/stats');
  $('#stats').innerHTML = Object.entries(stats).map(([key,value]) => `<div class="stat"><b>${Number(value)}</b><span>${escapeHtml(key)}</span></div>`).join('');
}
async function loadReports() {
  const { reports } = await api('/reports');
  $('#reports').innerHTML = reports.map(report => `<div class="item"><div><b>${escapeHtml(report.target_type)}</b><p>${escapeHtml(report.reason)}</p><small>${escapeHtml(report.status)} · ${new Date(report.created_at).toLocaleString()}</small></div><div class="actions"><button class="ok" data-report="${report.id}" data-status="resolved">Resolve</button><button class="danger" data-report="${report.id}" data-status="rejected">Reject</button></div></div>`).join('') || '<p>No reports</p>';
  document.querySelectorAll('[data-report]').forEach(button => button.onclick = async () => { await api(`/reports/${button.dataset.report}`, { method:'PATCH', body:{ status: button.dataset.status } }); await Promise.all([loadStats(), loadReports()]); });
}
async function searchUsers(query) {
  if (query.trim().length < 2) return $('#users').innerHTML = '<p>Введите минимум 2 символа</p>';
  const { users } = await api(`/search/users?q=${encodeURIComponent(query)}&limit=20`);
  $('#users').innerHTML = users.map(user => `<div class="item"><div><b>${escapeHtml(user.displayName)}</b><p>@${escapeHtml(user.username)} · ${escapeHtml(user.status)}</p></div><span>${escapeHtml(user.role)}</span></div>`).join('') || '<p>Не найдено</p>';
}
async function boot() {
  if (!state.token) return showAuth();
  try {
    const { user } = await api('/me');
    if (!['admin','moderator'].includes(user.role)) throw new Error('Недостаточно прав');
    state.user = user;
    $('#adminUser').textContent = `${user.displayName} · ${user.role}`;
    showDashboard();
    await Promise.all([loadStats(), loadReports()]);
  } catch (error) { localStorage.removeItem('adminToken'); state.token = ''; showAuth(); }
}
$('#loginForm').onsubmit = async event => {
  event.preventDefault();
  $('#authError').textContent = '';
  try {
    const data = await api('/auth/login', { method:'POST', body:Object.fromEntries(new FormData(event.target)) });
    if (!['admin','moderator'].includes(data.user.role)) throw new Error('Нужна роль admin или moderator');
    state.token = data.accessToken; localStorage.adminToken = data.accessToken; await boot();
  } catch (error) { $('#authError').textContent = error.message; }
};
$('#logout').onclick = () => { localStorage.removeItem('adminToken'); state.token = ''; showAuth(); };
$('#refresh').onclick = () => Promise.all([loadStats(), loadReports()]);
$('#userSearch').oninput = event => searchUsers(event.target.value);
boot();
