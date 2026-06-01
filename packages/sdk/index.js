export class LiquidMessengerSDK {
  constructor(baseUrl, token) { this.baseUrl = baseUrl.replace(/\/$/, ''); this.token = token; }
  async request(path, options = {}) {
    const res = await fetch(`${this.baseUrl}/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`, ...(options.headers || {}) }, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
    if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
    return res.json();
  }
}
