'use strict';
// 极简 HTTP 客户端 + Cookie Jar（零依赖）
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------- Cookie Jar ----------------
function domainMatch(host, domain) {
  host = host.toLowerCase();
  domain = domain.toLowerCase().replace(/^\./, '');
  return host === domain || host.endsWith('.' + domain);
}
function pathMatch(reqPath, cookiePath) {
  if (!cookiePath) return true;
  if (reqPath === cookiePath) return true;
  if (reqPath.startsWith(cookiePath)) {
    return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
  }
  return false;
}
function parseSetCookie(str, host) {
  const parts = str.split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  const c = { name, value, domain: host, path: '/', expires: null, secure: false, httpOnly: false };
  let hasDomain = false;
  for (const p of parts) {
    const idx = p.indexOf('=');
    const k = (idx < 0 ? p : p.slice(0, idx)).trim().toLowerCase();
    const v = idx < 0 ? '' : p.slice(idx + 1).trim();
    if (k === 'domain') { c.domain = v.replace(/^\./, '').toLowerCase(); hasDomain = true; }
    else if (k === 'path') c.path = v || '/';
    else if (k === 'expires') { const t = Date.parse(v); if (!isNaN(t)) c.expires = t; }
    else if (k === 'max-age') { const s = parseInt(v, 10); if (!isNaN(s)) c.expires = Date.now() + s * 1000; }
    else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') c.httpOnly = true;
  }
  c.hostOnly = !hasDomain;
  return c;
}
class CookieJar {
  constructor(cookies) { this.cookies = cookies || {}; }
  _key(c) { return c.domain + '\t' + c.path + '\t' + c.name; }
  setFromResponse(url, setCookie) {
    if (!setCookie) return;
    const host = new URL(url).hostname.toLowerCase();
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const sc of list) {
      const c = parseSetCookie(sc, host);
      if (!c) continue;
      // host-only cookie 只在精确 host 生效
      if (c.hostOnly) c.domain = host;
      const key = this._key(c);
      const expired = c.expires !== null && c.expires <= Date.now();
      if (c.value === '' || expired) delete this.cookies[key];
      else this.cookies[key] = c;
    }
  }
  getCookieHeader(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname || '/';
    const out = [];
    for (const c of Object.values(this.cookies)) {
      if (!domainMatch(host, c.domain)) continue;
      if (!pathMatch(path, c.path)) continue;
      if (c.secure && u.protocol !== 'https:') continue;
      out.push(c.name + '=' + c.value);
    }
    return out.join('; ');
  }
  get(name) {
    for (const c of Object.values(this.cookies)) if (c.name === name) return c.value;
    return null;
  }
  names() { return Object.values(this.cookies).map(c => c.name); }
  toJSON() { return this.cookies; }
  static fromJSON(o) { return new CookieJar(o || {}); }
}

// ---------------- 请求 ----------------
function decodeBody(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br' && zlib.brotliDecompressSync) return zlib.brotliDecompressSync(buf);
  } catch (e) { /* 忽略，返回原始 */ }
  return buf;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 可重试的错误：超时 / 连接被重置 / DNS 抖动等「网络层」瞬时故障。
// 注意：4399 的限流（HTTP 200 + status -3）和风控不会抛错，不会走到这里。
const RETRYABLE_RE = /请求超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|ENOTFOUND|socket hang up|premature close|aborted/i;
function isRetryableError(e) {
  const msg = (e && (e.message || e.code)) || String(e);
  return RETRYABLE_RE.test(String(msg));
}
const RETRY_DELAYS = [600, 1400, 2600, 4200, 6000];

// 单次请求
function requestOnce(urlStr, opts = {}) {
  const { method = 'GET', headers = {}, body = null, jar = null, timeout = 20000 } = opts;
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const h = Object.assign({ 'User-Agent': DEFAULT_UA, 'Accept-Encoding': 'gzip, deflate' }, headers);
    if (jar) { const c = jar.getCookieHeader(urlStr); if (c) h['Cookie'] = c; }
    let payload = body;
    if (payload != null && typeof payload !== 'string' && !Buffer.isBuffer(payload)) payload = String(payload);
    if (payload != null) h['Content-Length'] = Buffer.byteLength(payload);
    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: h,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        buf = decodeBody(buf, res.headers['content-encoding']);
        if (jar) jar.setFromResponse(urlStr, res.headers['set-cookie']);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          location: res.headers.location || null,
          body: buf,
          text: () => buf.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload != null) req.write(payload);
    req.end();
  });
}

// 带自动重试的请求：opts.retries 为额外重试次数（默认 0）。
// 只对「网络层瞬时故障」重试；POST 若调用方不放心可显式传 retries: 0。
function request(urlStr, opts = {}) {
  const retries = Math.max(0, Math.min(5, Number(opts.retries) || 0));
  const attempt = (n) => requestOnce(urlStr, opts).catch((e) => {
    if (n >= retries || !isRetryableError(e)) throw e;
    return sleep(RETRY_DELAYS[Math.min(n, RETRY_DELAYS.length - 1)]).then(() => attempt(n + 1));
  });
  return attempt(0);
}

// 构造 multipart/form-data 请求体（零依赖）
// fields: { name: value }；files: [{ name, filename, contentType, data(Buffer) }]
function buildMultipart(fields = {}, files = []) {
  const boundary = '----4399mgr' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const chunks = [];
  const push = (s) => chunks.push(Buffer.from(s, 'utf8'));
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${k}"\r\n\r\n`);
    push(String(v));
    push('\r\n');
  }
  for (const f of files) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n`);
    push(`Content-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`);
    chunks.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// 跟随重定向（默认不跟随 POST，交由调用方处理；这里仅用于 GET）
// 读取类导航默认自动重试 2 次（超时 / 连接抖动），调用方可传 retries 覆盖。
async function requestFollow(urlStr, opts = {}, jar = null, maxRedirects = 10) {
  // 兼容两种写法：第 3 参数传 jar，或把 jar 放进 opts
  const cookieJar = jar || opts.jar || null;
  if (opts.retries == null) opts = Object.assign({}, opts, { retries: 2 });
  let url = urlStr;
  let res;
  for (let i = 0; i < maxRedirects; i++) {
    res = await request(url, Object.assign({}, opts, { jar: cookieJar }));
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
      url = new URL(res.location, url).toString();
      opts = Object.assign({}, opts, { method: 'GET', body: null });
      continue;
    }
    return res;
  }
  return res;
}

module.exports = { CookieJar, request, requestOnce, requestFollow, buildMultipart, DEFAULT_UA, isRetryableError };
