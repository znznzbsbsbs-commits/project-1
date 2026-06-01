function createExtensionNetwork({ timeoutMs = 8000, fetchImpl = fetch } = {}) {
  return async function request(url, options = {}) {
    const target = new URL(url, 'http://localhost');
    if (target.protocol !== 'https:' && target.hostname !== 'localhost') throw new Error('Extension network requests require HTTPS');
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('HTTP method is not allowed');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(Number(options.timeout || timeoutMs), 15000));
    try {
      const response = await fetchImpl(target.href, {
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
  };
}
module.exports = { createExtensionNetwork };
