'use strict';
// 4399 管理器 · 本地服务（仅监听 127.0.0.1）
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CookieJar } = require('./lib/http');
const api = require('./lib/4399');
const ocr = require('./lib/ocr');
const extract = require('./lib/extract');
const { createVaultCrypto } = require('./lib/vault-crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8790;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
const VAULT_KEY_FILE = path.join(DATA_DIR, 'vault.key');
const MUSIC_CACHE_FILE = path.join(DATA_DIR, 'music-cache.json');
const ERR_LOG_FILE = path.join(DATA_DIR, 'errors.log');
// 宣传片（由 public/promo-studio.html 录制后上传，暂存 data/ 下）
const PROMO_MP4 = path.join(DATA_DIR, 'promo.mp4');
const PROMO_WEBM = path.join(DATA_DIR, 'promo.webm');

// 本地账号库密码的静态加密（密钥仅存本机，不进备份）
const vaultCrypto = createVaultCrypto(VAULT_KEY_FILE);

// ---------------- 异常落盘（排查「界面只显示一句英文报错」的问题） ----------------
// 每次未捕获异常都把完整堆栈写进 data/errors.log，并在控制台打印，方便定位。
function logError(where, e) {
  const at = new Date().toISOString();
  const msg = (e && e.message) || String(e);
  const stack = (e && e.stack) || '(无堆栈)';
  const line = `\n[${at}] ${where} :: ${msg}\n${stack}\n`;
  try { ensureData(); fs.appendFileSync(ERR_LOG_FILE, line, 'utf8'); } catch (x) { }
  try { console.error('[4399管理器·异常]', where, msg, '\n', stack); } catch (x) { }
  return msg;
}

// 把网络层异常翻译成人话（否则界面只会显示 AggregateError / ETIMEDOUT）
function netErrorMessage(e) {
  const m = String((e && (e.message || e.code)) || e || '');
  if (/ETIMEDOUT|AggregateError|timeout|超时/i.test(m)) return '连接 4399 超时（本机网络可能不通或被拦截），请稍后重试';
  if (/ECONNRESET|socket hang up|premature close|EPIPE/i.test(m)) return '与 4399 的连接被中断，请稍后重试';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return '无法解析 4399 域名，请检查网络 / DNS';
  if (/ECONNREFUSED/i.test(m)) return '连接被拒绝，请检查网络或代理设置';
  return m || '网络异常';
}

// ---------------- 本地配置（辅助账号等，仅存本机） ----------------
function loadConfig() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveConfig(cfg) {
  ensureData();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
function getHelper() {
  const cfg = loadConfig();
  return (cfg && cfg.helper) || {};
}

// ---------------- 风控 / 限流状态（本地记录，供「设置 · 调试」展示） ----------------
const riskState = {
  events: [],           // 最近事件：{ at, kind, where, detail }
  captchaCount: 0,
  rateLimitCount: 0,
  blockedCount: 0,      // 4399 静默拒绝登录的次数（HTTP 200 + 登录页原样返回，无任何原因）
  lastCaptchaAt: 0,
  lastRateLimitAt: 0,
  lastBlockedAt: 0,
  lastOkAt: 0,
};
function noteRisk(kind, where, detail) {
  const ev = { at: Date.now(), kind, where: String(where || ''), detail: detail ? String(detail).slice(0, 140) : '' };
  riskState.events.unshift(ev);
  if (riskState.events.length > 40) riskState.events.length = 40;
  if (kind === 'captcha') { riskState.captchaCount++; riskState.lastCaptchaAt = ev.at; }
  else if (kind === 'ratelimit') { riskState.rateLimitCount++; riskState.lastRateLimitAt = ev.at; }
  else if (kind === 'blocked') { riskState.blockedCount++; riskState.lastBlockedAt = ev.at; }
  else if (kind === 'ok') riskState.lastOkAt = ev.at;
}

// ---------------- 本地账号库（从文本提取出来的账号密码，仅存本机） ----------------
// 单条规范化：补齐 note 字段；把历史的 source（恒为「批量导入」）迁移成空备注
function normalizeVaultItem(x) {
  if (!x || typeof x !== 'object') return null;
  const username = String(x.username || '').trim();
  if (!username) return null;
  const legacy = String(x.source || '').trim();
  const it = {
    id: String(x.id || vaultId(username)),
    username,
    password: String(x.password || ''),
    note: typeof x.note === 'string' ? x.note : (legacy && legacy !== '批量导入' ? legacy : ''),
    createdAt: Number(x.createdAt) || 0,
  };
  if (x.updatedAt) it.updatedAt = Number(x.updatedAt) || 0;
  return it;
}
function loadVaultRaw() {
  ensureData();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')); } catch (e) { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeVaultItem).filter(Boolean);
}
// 写入原始条目：password 若已是密文则原样保留，否则加密后再写
function saveVaultRaw(list) {
  ensureData();
  const out = (Array.isArray(list) ? list : []).map((x) => {
    const it = Object.assign({}, x);
    const p = String(it.password || '');
    it.password = vaultCrypto.isEncrypted(p) ? p : vaultCrypto.encrypt(p);
    return it;
  });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(out, null, 2), 'utf8');
}
// 读取：返回明文密码（供界面展示 / 批量登录）；顺手把历史明文迁移成密文
function loadVault() {
  const list = loadVaultRaw();
  let needMigrate = false;
  for (const it of list) if (it.password && !vaultCrypto.isEncrypted(it.password)) { needMigrate = true; break; }
  for (const it of list) it.password = vaultCrypto.decrypt(it.password);
  if (needMigrate) saveVault(list);
  return list;
}
// 写入：传入明文列表，落盘前统一加密
function saveVault(list) {
  saveVaultRaw((Array.isArray(list) ? list : []).map((x) => Object.assign({}, x, {
    password: vaultCrypto.encrypt(x && x.password),
  })));
}
function vaultId(username) {
  return 'v_' + Buffer.from(String(username)).toString('hex').slice(0, 24);
}
// 登录成功时顺手把「用户名 + 密码」存进本地账号库（密码加密后落盘）
function upsertVaultCredential(username, password, note) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u || !p) return { ok: false, skipped: true };
  const list = loadVault();
  const n = String(note == null ? '' : note).trim().slice(0, 60);
  const ex = list.find((x) => x.username === u);
  if (ex) {
    let changed = false;
    if (ex.password !== p) { ex.password = p; changed = true; }
    // 已有备注不覆盖（用户自己写的分组/来源备注要保留），只在原来没有备注时补上
    if (n && !String(ex.note || '').trim()) { ex.note = n; changed = true; }
    if (changed) { ex.updatedAt = Date.now(); saveVault(list); }
    return { ok: true, updated: changed };
  }
  list.push({ id: vaultId(u), username: u, password: p, note: n, createdAt: Date.now() });
  saveVault(list);
  return { ok: true, added: true };
}
function importVault(items, note) {
  const list = loadVault();
  const n = String(note == null ? '' : note).trim().slice(0, 60);
  let added = 0, updated = 0, skipped = 0;
  for (const it of (Array.isArray(items) ? items : [])) {
    const u = String((it && it.user) || '').trim();
    const p = String((it && it.pass) || '');
    if (!u || !p) { skipped++; continue; }
    const ex = list.find((x) => x.username === u);
    if (ex) {
      let changed = false;
      if (ex.password !== p) { ex.password = p; changed = true; }
      if (n && ex.note !== n) { ex.note = n; changed = true; }
      if (changed) { ex.updatedAt = Date.now(); updated++; } else skipped++;
    } else {
      list.push({ id: vaultId(u), username: u, password: p, note: n, createdAt: Date.now() });
      added++;
    }
  }
  saveVault(list);
  return { ok: true, added, updated, skipped, total: list.length };
}
function deleteVaultItem(id) {
  const list = loadVault();
  const kept = list.filter((x) => x.id !== id);
  saveVault(kept);
  return { ok: true, removed: list.length - kept.length, total: kept.length };
}
// 账号库批量操作：删除 / 改备注
function bulkVault(body) {
  const ids = new Set((Array.isArray(body && body.ids) ? body.ids : []).map(String));
  const action = String((body && body.action) || '');
  if (!ids.size) return { ok: false, message: '未选择条目' };
  const list = loadVault();
  if (action === 'delete') {
    const kept = list.filter((x) => !ids.has(String(x.id)));
    saveVault(kept);
    return { ok: true, count: list.length - kept.length, total: kept.length };
  }
  if (action === 'note') {
    const n = String(body && body.note == null ? '' : body.note).trim().slice(0, 60);
    let count = 0;
    for (const x of list) if (ids.has(String(x.id))) { x.note = n; x.updatedAt = Date.now(); count++; }
    saveVault(list);
    return { ok: true, count, total: list.length };
  }
  return { ok: false, message: '未知操作' };
}
function updateVaultItem(id, note) {
  const list = loadVault();
  const x = list.find((v) => v.id === String(id));
  if (!x) return { ok: false, message: '记录不存在' };
  x.note = String(note == null ? '' : note).trim().slice(0, 60);
  x.updatedAt = Date.now();
  saveVault(list);
  return { ok: true, item: x };
}

// 解析辅助账号：优先复用「已登录账号」的登录态（无需密码），否则用手动填写的账号密码
function resolveHelper() {
  const h = getHelper();
  if (h.mode === 'account' && h.accountId) {
    const acc = loadAccounts().find((a) => a.id === h.accountId);
    if (!acc) return { ok: false, error: '所选辅助账号已不在列表中，请在设置里重新选择' };
    if (!acc.cookies) return { ok: false, error: '所选辅助账号缺少登录态，请先在管理器里登录它一次' };
    return {
      ok: true, mode: 'account', accountId: h.accountId,
      username: acc.username || acc.nickname || '', jar: CookieJar.fromJSON(acc.cookies),
    };
  }
  if (h.username && h.password) return { ok: true, mode: 'manual', username: h.username, password: h.password };
  return { ok: false, error: '尚未配置辅助账号（设置 → 辅助账号）' };
}

// ---------------- 账号存储 ----------------
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf8');
  if (!fs.existsSync(FOLDERS_FILE)) fs.writeFileSync(FOLDERS_FILE, '[]', 'utf8');
  if (!fs.existsSync(VAULT_FILE)) fs.writeFileSync(VAULT_FILE, '[]', 'utf8');
}
function loadAccounts() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return []; }
}
function saveAccounts(list) {
  ensureData();
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function publicAccount(a) {
  const { cookies, accessToken, ...rest } = a;
  return rest;
}

// ---------------- 分组存储 ----------------
function loadFolders() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8')); } catch (e) { return []; }
}
function saveFolders(list) {
  ensureData();
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function folderDescendants(list, id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const f of list) if ((f.parentId || null) === cur) { out.push(f.id); stack.push(f.id); }
  }
  return out;
}
function createFolder(name, parentId) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return { ok: false, message: '分组名不能为空' };
  const list = loadFolders();
  const pid = parentId || null;
  if (pid && !list.some((f) => f.id === pid)) return { ok: false, message: '父分组不存在' };
  if (list.some((f) => (f.parentId || null) === pid && f.name === n)) return { ok: false, message: '同级已存在同名分组' };
  const folder = { id: 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: n, parentId: pid, createdAt: Date.now() };
  list.push(folder);
  saveFolders(list);
  return { ok: true, folder };
}
function renameFolder(id, name) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return { ok: false, message: '分组名不能为空' };
  const list = loadFolders();
  const f = list.find((x) => x.id === id);
  if (!f) return { ok: false, message: '分组不存在' };
  if (list.some((x) => x.id !== id && (x.parentId || null) === (f.parentId || null) && x.name === n)) {
    return { ok: false, message: '同级已存在同名分组' };
  }
  f.name = n;
  saveFolders(list);
  return { ok: true, folder: f };
}
function moveFolder(id, parentId) {
  const list = loadFolders();
  const f = list.find((x) => x.id === id);
  if (!f) return { ok: false, message: '分组不存在' };
  const pid = parentId || null;
  if (pid === id) return { ok: false, message: '不能移动到自身' };
  if (pid) {
    if (!list.some((x) => x.id === pid)) return { ok: false, message: '目标分组不存在' };
    if (folderDescendants(list, id).includes(pid)) return { ok: false, message: '不能移动到自己的子分组内' };
    if (list.some((x) => x.id !== id && (x.parentId || null) === pid && x.name === f.name)) {
      return { ok: false, message: '目标分组下已存在同名分组' };
    }
  }
  f.parentId = pid;
  saveFolders(list);
  return { ok: true, folder: f };
}
function deleteFolder(id) {
  const list = loadFolders();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, message: '分组不存在' };
  // 删除该分组及其所有子分组；里面的账号移出到「未分组」
  const doomed = new Set([id, ...folderDescendants(list, id)]);
  saveFolders(list.filter((f) => !doomed.has(f.id)));
  const accounts = loadAccounts();
  let changed = false;
  for (const a of accounts) if (a.folderId && doomed.has(a.folderId)) { a.folderId = null; changed = true; }
  if (changed) saveAccounts(accounts);
  return { ok: true, removed: doomed.size };
}

// 备注 / 所属分组
function saveMeta(id, body) {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };
  if (body && body.remark !== undefined) {
    const r = String(body.remark || '').trim();
    acc.remark = r ? r.slice(0, 50) : null;
  }
  if (body && body.folderId !== undefined) acc.folderId = body.folderId || null;
  saveAccounts(accounts);
  return { ok: true, account: publicAccount(acc) };
}

// ---------------- 备份 / 恢复 ----------------
// 备份内容：账号登录态 + 分组 + 配置参数（含辅助账号密码，文件仅保存在本机）
function exportBackup() {
  return {
    app: '4399-manager', version: 3, exportedAt: Date.now(),
    accounts: loadAccounts(), folders: loadFolders(), config: loadConfig(),
    // 账号库密码为密文；密钥 data/vault.key 刻意不进备份
    vault: loadVaultRaw(),
  };
}
function importBackup(body, mode) {
  const inAcc = Array.isArray(body && body.accounts) ? body.accounts : [];
  const inFolders = Array.isArray(body && body.folders) ? body.folders : [];
  const inCfg = (body && body.config && typeof body.config === 'object' && !Array.isArray(body.config)) ? body.config : null;
  const inVault = Array.isArray(body && body.vault) ? body.vault : [];
  if (!inAcc.length && !inFolders.length && !inCfg && !inVault.length) return { ok: false, message: '备份内容为空' };
  if (mode === 'replace') {
    saveAccounts(inAcc);
    saveFolders(inFolders);
    if (inCfg) saveConfig(inCfg);
    if (inVault.length) saveVaultRaw(inVault);
    return { ok: true, mode: 'replace', accounts: inAcc.length, folders: inFolders.length, config: !!inCfg, vault: inVault.length };
  }
  const accounts = loadAccounts();
  let added = 0, updated = 0;
  for (const a of inAcc) {
    if (!a || !a.id) continue;
    const ex = accounts.find((x) => x.id === a.id);
    if (ex) { Object.assign(ex, a); updated++; } else { accounts.push(a); added++; }
  }
  saveAccounts(accounts);
  const folders = loadFolders();
  let fAdded = 0;
  for (const f of inFolders) {
    if (!f || !f.id || folders.some((x) => x.id === f.id)) continue;
    folders.push(f); fAdded++;
  }
  saveFolders(folders);
  // 账号库合并：同 id 覆盖密码 / 备注，其余追加
  let vAdded = 0, vUpdated = 0;
  if (inVault.length) {
    const raw = loadVaultRaw();
    for (const v of inVault) {
      const it = normalizeVaultItem(v);
      if (!it) continue;
      const ex = raw.find((x) => x.id === it.id || x.username === it.username);
      if (ex) { Object.assign(ex, it); vUpdated++; } else { raw.push(it); vAdded++; }
    }
    saveVaultRaw(raw);
  }
  // 配置合并：备份里有的字段覆盖本地，不删除本地其它字段
  if (inCfg) {
    const cfg = loadConfig();
    for (const k of Object.keys(inCfg)) cfg[k] = inCfg[k];
    saveConfig(cfg);
  }
  return { ok: true, mode: 'merge', accounts: added, updated, folders: fAdded, vault: vAdded, vaultUpdated: vUpdated, config: !!inCfg };
}

// ---------------- 宣传片（data/promo.*） ----------------
// 由 public/promo-studio.html 在浏览器里录制，POST 回来落盘；仅本机可读写。
function promoInfo() {
  const cands = [{ file: PROMO_MP4, mime: 'video/mp4' }, { file: PROMO_WEBM, mime: 'video/webm' }];
  for (const c of cands) {
    try {
      const st = fs.statSync(c.file);
      return { ok: true, exists: true, name: path.basename(c.file), mime: c.mime, bytes: st.size, at: st.mtimeMs };
    } catch (e) { /* 试下一个 */ }
  }
  return { ok: true, exists: false, name: null, mime: null, bytes: 0, at: 0 };
}
function savePromo(buf, mime) {
  if (!buf || !buf.length) return { ok: false, message: '没有收到视频数据' };
  const isMp4 = /mp4/i.test(String(mime || ''));
  const target = isMp4 ? PROMO_MP4 : PROMO_WEBM;
  const other = isMp4 ? PROMO_WEBM : PROMO_MP4;
  try { ensureData(); fs.writeFileSync(target, buf); }
  catch (e) { return { ok: false, message: '写入失败：' + ((e && e.message) || e) }; }
  try { if (fs.existsSync(other)) fs.rmSync(other, { force: true }); } catch (e) { }
  return promoInfo();
}
function deletePromo() {
  const removed = [];
  for (const f of [PROMO_MP4, PROMO_WEBM]) {
    try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.basename(f)); } } catch (e) { }
  }
  return { ok: true, removed };
}

// ---------------- 数据概览 / 恢复默认配置 / 清除全部数据 ----------------
function dataFileBytes() {
  const files = [DB_FILE, FOLDERS_FILE, VAULT_FILE, VAULT_KEY_FILE, CONFIG_FILE, MUSIC_CACHE_FILE, ERR_LOG_FILE];
  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(f).size; } catch (e) { } }
  return bytes;
}
function dataSummary() {
  const accounts = loadAccounts();
  const folders = loadFolders();
  const vault = loadVault();
  const cfg = loadConfig();
  const music = loadMusicCache();
  let covers = 0, coverBytes = 0;
  try {
    if (fs.existsSync(MUSIC_DIR)) for (const f of fs.readdirSync(MUSIC_DIR)) {
      covers++;
      try { coverBytes += fs.statSync(path.join(MUSIC_DIR, f)).size; } catch (e) { }
    }
  } catch (e) { }
  return {
    ok: true,
    dataDir: DATA_DIR,
    accounts: accounts.length,
    folders: folders.length,
    vault: Array.isArray(vault) ? vault.length : 0,
    helperConfigured: !!(cfg && cfg.helper && (cfg.helper.accountId || cfg.helper.username || cfg.helper.password)),
    configKeys: cfg ? Object.keys(cfg).length : 0,
    musicCached: music ? Object.keys(music).length : 0,
    covers,
    coverBytes,
    bytes: dataFileBytes() + coverBytes,
    promo: (function () { const p = promoInfo(); return p.exists ? { name: p.name, bytes: p.bytes } : null; })(),
  };
}
// 只重置配置参数，不动任何账号数据
function resetConfig() {
  saveConfig({});
  return { ok: true };
}
// 彻底删除本机 data/ 下的全部数据（不留副本）
function wipeAllData(confirmWord) {
  if (String(confirmWord || '').trim() !== '清除') return { ok: false, message: '确认词不正确，请输入「清除」' };
  const removed = [];
  const files = [DB_FILE, FOLDERS_FILE, VAULT_FILE, VAULT_KEY_FILE, CONFIG_FILE, MUSIC_CACHE_FILE, ERR_LOG_FILE, PROMO_MP4, PROMO_WEBM];
  for (const f of files) {
    try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.basename(f)); } } catch (e) { }
  }
  try {
    if (fs.existsSync(MUSIC_DIR)) { fs.rmSync(MUSIC_DIR, { recursive: true, force: true }); removed.push('music-covers/'); }
  } catch (e) { }
  return { ok: true, removed };
}

function decodeDataUrl(s) {
  s = String(s || '');
  const m = s.match(/^data:([^;,]+)?;base64,([\s\S]*)$/);
  if (m) return { contentType: m[1] || null, buffer: Buffer.from(m[2], 'base64') };
  return { contentType: null, buffer: Buffer.from(s, 'base64') };
}

// 待处理登录会话（验证码中断时暂存）
const pending = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > 5 * 60 * 1000) pending.delete(k);
}, 60 * 1000);

// ---------------- 业务 ----------------
const MAX_CAPTCHA_TRIES = 3;
const pendingReg = new Map(); // 待处理注册会话（验证码中断时暂存）
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingReg) if (now - v.createdAt > 5 * 60 * 1000) pendingReg.delete(k);
  // 批量登录时会不断产生「等验证码」的暂存会话，超时清掉避免堆积
  for (const [k, v] of pending) if (v && now - (v.createdAt || 0) > 5 * 60 * 1000) pending.delete(k);
}, 60 * 1000);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- 后台任务（长耗时操作：区服角色查询 / 实名信息查询） ----------------
// 用「任务 + 前端轮询」而不是长连接：好处是前端可以随时取消，任务状态也能跨页面刷新保留。
const jobs = new Map();
const JOB_TTL = 10 * 60 * 1000;
function createJob(kind, total, label) {
  const id = 'j_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = {
    id, kind, label: label || '', total: total || 0, done: 0,
    state: 'running', cancelled: false, items: [], result: null, error: null, errorTimeout: false, createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}
function purgeJobs() {
  const now = Date.now();
  for (const [k, v] of jobs) if (now - v.createdAt > JOB_TTL) jobs.delete(k);
}
function jobView(job) {
  return {
    id: job.id, kind: job.kind, label: job.label, total: job.total, done: job.done,
    state: job.state, items: job.items, result: job.result, error: job.error, errorTimeout: !!job.errorTimeout, at: job.createdAt,
  };
}
setInterval(purgeJobs, 60 * 1000);

// 暂存登录会话，等用户手动输入验证码
function parkCaptcha(sess, captchaId, image, autoTried, autoLog) {
  const token = api.randomState();
  sess.captchaId = captchaId;
  sess.createdAt = Date.now();
  pending.set(token, sess);
  return {
    needCaptcha: true, sessionToken: token, captchaId, captchaImage: image || null,
    autoCaptchaTried: !!autoTried, autoLog: autoLog || [], risk: riskSummary(),
  };
}

// 给前端用的风控摘要
function riskSummary() {
  const now = Date.now();
  return {
    captchaCount: riskState.captchaCount,
    rateLimitCount: riskState.rateLimitCount,
    blockedCount: riskState.blockedCount,
    lastCaptchaAt: riskState.lastCaptchaAt || null,
    lastRateLimitAt: riskState.lastRateLimitAt || null,
    lastBlockedAt: riskState.lastBlockedAt || null,
    lastOkAt: riskState.lastOkAt || null,
    recentRateLimit: riskState.lastRateLimitAt ? (now - riskState.lastRateLimitAt < 10 * 60 * 1000) : false,
    recentCaptcha: riskState.lastCaptchaAt ? (now - riskState.lastCaptchaAt < 10 * 60 * 1000) : false,
    recentBlocked: riskState.lastBlockedAt ? (now - riskState.lastBlockedAt < 10 * 60 * 1000) : false,
  };
}

async function doLogin(body) {
  let sess;
  if (body.sessionToken && pending.has(body.sessionToken)) {
    sess = pending.get(body.sessionToken);
    pending.delete(body.sessionToken);
  } else {
    const jar = new CookieJar();
    const state = api.randomState();
    const { fields } = await api.fetchAuthorizePage(jar, state);
    sess = { jar, state, fields, createdAt: Date.now() };
  }

  const wantAuto = body.autoCaptcha !== false;
  let captcha = body.captcha || null;
  let captchaId = body.captchaId || sess.captchaId || null;
  let lastImage = null;
  let autoTried = false;
  const autoLog = [];   // 自动打码尝试记录，用于前端提示

  for (let attempt = 0; attempt <= MAX_CAPTCHA_TRIES; attempt++) {
    const result = await api.submitLogin(sess.jar, sess.fields, {
      username: body.username,
      password: body.password,
      captcha,
      captchaId,
    });

    if (result.ok) { noteRisk('ok', '登录', body.username); return await finishLogin(sess, result, body); }

    if (result.rateLimited) noteRisk('ratelimit', '登录', result.error || '请稍后再试');
    if (result.blocked) noteRisk('blocked', '登录', body.username);

    if (result.needCaptcha || result.captchaError) {
      noteRisk('captcha', '登录', result.error || '需要验证码');
      if (result.captchaId) { captchaId = result.captchaId; sess.captchaId = result.captchaId; }
      let img = null;
      try { img = await api.fetchCaptchaImage(sess.jar, captchaId); } catch (e) { }
      if (img) lastImage = img;

      if (!wantAuto || !ocr.available()) return parkCaptcha(sess, captchaId, lastImage, autoTried, autoLog);
      if (!img) { captcha = null; continue; }
      let text = null;
      try { text = await ocr.recognizeCaptcha(img); } catch (e) { }
      autoTried = true;
      if (!text) { autoLog.push({ text: null, ok: false }); captcha = null; await sleep(400); continue; }
      autoLog.push({ text, ok: false });
      captcha = text;
      continue;
    }

    return { error: result.error || '登录失败', blocked: !!result.blocked, status: result.status || null, risk: riskSummary() };
  }

  return parkCaptcha(sess, captchaId, lastImage, true, autoLog);
}

// 登录成功：采集信息并保存
async function finishLogin(sess, result, body) {
  const jar = sess.jar;
  const info = await api.getUserInfo(jar, result.uid);
  let profile = null;
  try { profile = await api.getUserProfile(jar); } catch (e) { /* 忽略 */ }
  const uid = info.uid || result.uid || null;
  const accounts = loadAccounts();
  const id = uid ? String(uid) : ('u_' + Date.now());
  let acc = accounts.find((a) => a.id === id);
  let created = false;
  if (!acc) {
    acc = { id, createdAt: Date.now() };
    accounts.push(acc);
    created = true;
  }
  Object.assign(acc, {
    uid: uid ? String(uid) : acc.uid || null,
    username: body.username,
    nickname: (profile && profile.nickname) || info.nickname || acc.nickname || body.username,
    avatar: (profile && profile.avatar) || info.avatar || acc.avatar || null,
    credit: info.credit, grade: info.grade, growth: info.growth,
    followed: info.followed, joinTime: info.joinTime, verified: info.verified,
    cookies: jar.toJSON(),
    accessToken: result.accessToken || null,
    cookieNames: jar.names(),
    lastLogin: Date.now(),
    sessionValid: true,
    sessionCheckedAt: Date.now(),
  });
  mergeProfile(acc, profile);
  saveAccounts(accounts);
  // 顺手把「用户名 + 密码」存进本地账号库（加密后落盘），方便以后批量登录
  let vaultSaved = false;
  try { vaultSaved = !!upsertVaultCredential(body.username, body.password, '登录时保存').ok; } catch (e) { }
  return { ok: true, account: publicAccount(acc), created, vaultSaved };
}

// 把个人资料字段合并进账号记录（仅覆盖有值的字段）
function mergeProfile(acc, profile) {
  if (!profile || !profile.ok) return;
  if (profile.nickname) acc.nickname = profile.nickname;
  if (profile.avatar) acc.avatar = profile.avatar;
  acc.gender = profile.gender != null ? profile.gender : (acc.gender || null);
  acc.birthday = profile.birthday != null ? profile.birthday : (acc.birthday || null);
  acc.region = profile.region != null ? profile.region : (acc.region || null);
  acc.qq = profile.qq != null ? profile.qq : (acc.qq || null);
  acc.email = profile.email != null ? profile.email : (acc.email || null);
  acc.ipLocation = profile.ipLocation != null ? profile.ipLocation : (acc.ipLocation || null);
  if (profile.authStatus) acc.authStatus = profile.authStatus;
}

async function refreshAccount(id) {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };
  const jar = CookieJar.fromJSON(acc.cookies);
  let info;
  try {
    info = await api.getUserInfo(jar, acc.uid);
  } catch (e) {
    logError('refresh ' + id, e);
    const msg = netErrorMessage(e);
    return { ok: false, error: msg, timeout: api.isTimeoutMsg(msg) };
  }
  let profile = null;
  try { profile = await api.getUserProfile(jar); } catch (e) { /* 忽略 */ }
  Object.assign(acc, {
    uid: info.uid || acc.uid,
    nickname: info.nickname || acc.nickname,
    avatar: info.avatar || acc.avatar,
    credit: info.credit, grade: info.grade, growth: info.growth,
    followed: info.followed, joinTime: info.joinTime, verified: info.verified,
    cookies: jar.toJSON(),
    cookieNames: jar.names(),
    lastRefresh: Date.now(),
  });
  mergeProfile(acc, profile);
  const valid = !!(info.uid || info.nickname || (profile && profile.ok));
  acc.sessionValid = valid;
  acc.sessionCheckedAt = Date.now();
  saveAccounts(accounts);
  return { ok: true, account: publicAccount(acc), sessionValid: valid };
}

// 取某账号的 CookieJar
function accountJar(id) {
  const acc = loadAccounts().find((a) => a.id === id);
  if (!acc) return null;
  return { acc, jar: CookieJar.fromJSON(acc.cookies) };
}

async function getHistory(id) {
  const ctx = accountJar(id);
  if (!ctx) return { error: '账号不存在' };
  return api.getGameHistory(ctx.jar);
}

async function getRoleOptions(id, abbr) {
  const ctx = accountJar(id);
  if (!ctx) return { error: '账号不存在' };
  return api.getGameServerOptions(ctx.jar, abbr);
}

// 区服角色查询：后台任务化（真实进度 + 可取消）
function startRolesJob(id, abbr, sids) {
  const ctx = accountJar(id);
  if (!ctx) return { error: '账号不存在' };
  const list = [...new Set((Array.isArray(sids) ? sids : []).map(Number))]
    .filter((s) => Number.isInteger(s) && s > 0).sort((a, b) => a - b);
  if (!list.length) return { error: '请至少选择一个区服' };

  const job = createJob('roles', list.length, '区服角色查询');
  job.items = list.map((sid) => ({ sid, state: 'wait', message: '' }));
  const bySid = new Map(job.items.map((it) => [it.sid, it]));

  (async () => {
    try {
      const r = await api.queryGameRoles(ctx.jar, abbr, list, {
        isCancelled: () => job.cancelled,
        onProgress: (done, total, res) => {
          job.done = done;
          const it = bySid.get(Number(res.sid));
          if (!it) return;
          if (res.roles) { it.state = 'ok'; it.message = res.roles.length + ' 个角色'; }
          else if (res.empty) { it.state = 'empty'; it.message = '该区服无角色'; }
          else if (res.rateLimited) { it.state = 'warn'; it.message = '操作过于频繁'; }
          else {
            it.state = 'err';
            it.timeout = !!(res.failure && res.failure.timeout);
            it.message = it.timeout ? '查询超时' : ((res.failure && res.failure.message) || '查询失败');
          }
        },
      });
      job.result = r;
      job.done = r.done != null ? r.done : job.done;
      job.state = (job.cancelled || r.cancelled) ? 'cancelled' : 'done';
    } catch (e) {
      job.state = 'error';
      logError('roles job ' + id, e);
      job.error = netErrorMessage(e);
      job.errorTimeout = api.isTimeoutMsg(job.error);
    }
  })();

  return { ok: true, jobId: job.id, total: job.items.length };
}

// 账号安全概览（邮箱/QQ/认证/IP 属地等）
async function getSecurity(id) {
  const ctx = accountJar(id);
  if (!ctx) return { error: '账号不存在' };
  return api.getSecurityInfo(ctx.jar);
}

// 拉取「修改资料」表单当前值
async function getProfileForm(id) {
  const ctx = accountJar(id);
  if (!ctx) return { error: '账号不存在' };
  const form = await api.getModifyForm(ctx.jar);
  if (form.ok) form.region = ctx.acc.region || null;
  return form;
}

// 保存「修改资料」并刷新本地资料
async function saveProfile(id, body) {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };
  const jar = CookieJar.fromJSON(acc.cookies);

  // 与参考实现一致：未提供的省 / 市回退为账号现有地区，避免被清空
  const params = Object.assign({}, body || {});
  if (!params.province || !params.city) {
    const parts = String(acc.region || '').split(/[-·\s]+/).filter(Boolean);
    if (!params.province && parts[0]) params.province = parts[0];
    if (!params.city && parts[1]) params.city = parts[1];
  }

  const r = await api.modifyProfile(jar, params);
  if (!r.ok) return r;
  let profile = null;
  try { profile = await api.getUserProfile(jar); } catch (e) { /* 忽略 */ }
  mergeProfile(acc, profile);
  saveAccounts(accounts);
  return { ok: true, message: r.message, account: publicAccount(acc) };
}

// 上传头像（接收 base64），成功后刷新头像地址
async function saveAvatar(id, body) {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };
  const jar = CookieJar.fromJSON(acc.cookies);
  const { buffer, contentType } = decodeDataUrl((body && (body.dataUrl || body.base64)) || '');
  const r = await api.uploadAvatar(jar, buffer, body && body.filename, contentType || (body && body.type));
  if (!r.ok) return r;
  let profile = null;
  try { profile = await api.getUserProfile(jar); } catch (e) { /* 忽略 */ }
  if (profile && profile.avatar) acc.avatar = profile.avatar;
  acc.avatarUpdatedAt = Date.now();
  saveAccounts(accounts);
  return { ok: true, message: r.message, account: publicAccount(acc) };
}

async function signAccount(id, type) {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };
  const jar = CookieJar.fromJSON(acc.cookies);
  let r;
  if (type === 'game') r = await api.gameSignIn(jar);
  else r = await api.groupSignIn(jar);
  // 依据签到结果判断登录态：群组 code 99 / needLogin 视为已失效
  const expired = r && (r.needLogin || (r.data && Number(r.data.code) === 99));
  if (expired) { acc.sessionValid = false; acc.sessionCheckedAt = Date.now(); }
  else if (r && r.ok) { acc.sessionValid = true; acc.sessionCheckedAt = Date.now(); }
  acc.lastSign = acc.lastSign || {};
  acc.lastSign[type || 'group'] = { at: Date.now(), result: r };
  saveAccounts(accounts);
  return r;
}

// 批量操作（移动到分组 / 删除）
function bulkAccounts(body) {
  const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : [];
  if (!ids.length) return { ok: false, message: '未选择账号' };
  const set = new Set(ids);
  const accounts = loadAccounts();
  const action = body && body.action;
  if (action === 'move') {
    const fid = (body && body.folderId) || null;
    if (fid) {
      const folders = loadFolders();
      if (!folders.some((f) => f.id === fid)) return { ok: false, message: '目标分组不存在' };
    }
    let n = 0;
    for (const a of accounts) if (set.has(a.id)) { a.folderId = fid; n++; }
    saveAccounts(accounts);
    return { ok: true, count: n, folderId: fid };
  }
  if (action === 'delete') {
    const kept = accounts.filter((a) => !set.has(a.id));
    const n = accounts.length - kept.length;
    saveAccounts(kept);
    return { ok: true, count: n };
  }
  return { ok: false, message: '未知操作' };
}

// ---------------- HTTP ----------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
  });
}
// 读取二进制请求体（宣传片上传用）。超限返回 null。
function readBinary(req, max) {
  const cap = max || 80 * 1024 * 1024;
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > cap) { dead = true; try { req.destroy(); } catch (e) { } return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(dead ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// ---------------- 注册账号 ----------------
function regErrorText(r) {
  if (r.rateLimited) return '请求过于频繁，4399 要求稍后再试';
  if (r.errorMsg) return String(r.errorMsg).slice(0, 80);
  const dom = String(r.dom || '').replace(/\s+/g, ' ').trim();
  const m = dom.match(/([\u4e00-\u9fa5][^。！]{0,40}(?:错误|失败|不正确|不匹配|已被|不能|请)[^。！]{0,20})/);
  return m ? m[1].slice(0, 80) : '注册失败，请检查填写信息后重试';
}

function parkReg(sess, sessionId, image, autoTried, autoLog) {
  const token = api.randomState();
  sess.sessionId = sessionId;
  sess.createdAt = Date.now();
  pendingReg.set(token, sess);
  return {
    needCaptcha: true, sessionToken: token, captchaId: sessionId, captchaImage: image || null,
    autoCaptchaTried: !!autoTried, autoLog: autoLog || [], risk: riskSummary(),
  };
}

async function doRegister(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const realname = String(body.realname || '').trim();
  const idcard = String(body.idcard || '').trim();
  const qq = String(body.qq || '').trim();

  if (!/^[0-9a-zA-Z_]{3,20}$/.test(username)) return { error: '用户名需为 3-20 位字母、数字或下划线' };
  if (password.length < 6 || password.length > 20) return { error: '密码需为 6-20 位' };
  if (!realname) return { error: '请填写真实姓名' };
  if (!/^\d{17}[\dXx]$/.test(idcard)) return { error: '身份证号格式不正确' };

  let sess;
  if (body.sessionToken && pendingReg.has(body.sessionToken)) {
    sess = pendingReg.get(body.sessionToken);
    pendingReg.delete(body.sessionToken);
  } else {
    sess = { jar: await api.newRegisterJar(), createdAt: Date.now() };
  }

  const wantAuto = body.autoCaptcha !== false;
  let captcha = body.captcha || null;
  let sessionId = body.captchaId || sess.sessionId || null;
  let lastImage = null;
  let autoTried = false;
  const autoLog = [];

  for (let attempt = 0; attempt <= MAX_CAPTCHA_TRIES; attempt++) {
    const r = await api.submitRegister(sess.jar, { username, password, realname, idcard, qq, captcha, sessionId });
    if (r.success) { noteRisk('ok', '注册', username); return { ok: true, status: 0, message: '注册成功' }; }
    if (r.exists) return { ok: false, status: 1, message: '用户名已存在，请换一个' };
    if (r.idcardLimit) return { ok: false, status: 2, message: '该身份证绑定的账号已超出限制' };
    if (r.rateLimited) noteRisk('ratelimit', '注册', r.errorMsg || '请稍后再试');

    if (r.captchaId) { sessionId = r.captchaId; sess.sessionId = r.captchaId; }
    if (r.needCaptcha || r.captchaError) {
      noteRisk('captcha', '注册', r.errorMsg || '需要验证码');
      let img = null;
      try { img = await api.fetchCaptchaImage(sess.jar, sessionId); } catch (e) { }
      if (img) lastImage = img;
      if (!wantAuto || !ocr.available() || !sessionId) return parkReg(sess, sessionId, lastImage, autoTried, autoLog);
      if (!img) { captcha = null; continue; }
      let text = null;
      try { text = await ocr.recognizeCaptcha(img); } catch (e) { }
      autoTried = true;
      if (!text) { autoLog.push({ text: null, ok: false }); captcha = null; await sleep(400); continue; }
      autoLog.push({ text, ok: false });
      captcha = text;
      continue;
    }
    return { ok: false, status: 3, message: regErrorText(r), risk: riskSummary() };
  }

  return parkReg(sess, sessionId, lastImage, true, autoLog);
}

// ---------------- 辅助账号登录（实名查询用） ----------------
async function helperLogin(jar, helper) {
  let captcha = null;
  let sessionId = null;
  for (let attempt = 0; attempt <= MAX_CAPTCHA_TRIES; attempt++) {
    const r = await api.submitPlainLogin(jar, { username: helper.username, password: helper.password, captcha, sessionId });
    if (r.ok) return { ok: true };
    if (r.pwdError) return { ok: false, message: '辅助账号密码错误' };
    if (r.noUser) return { ok: false, message: '辅助账号不存在' };
    if (r.rateLimited) return { ok: false, message: '请求过于频繁，4399 要求稍后再试' };
    if (r.needCaptcha || r.captchaError) {
      if (r.captchaId) sessionId = r.captchaId;
      if (!sessionId) return { ok: false, message: '未取到验证码会话，请稍后重试' };
      if (!ocr.available()) return { ok: false, message: '辅助账号登录需要验证码，但 OCR 未就绪' };
      let img = null;
      try { img = await api.fetchPlainCaptcha(jar, sessionId); } catch (e) { }
      if (!img) { captcha = null; continue; }
      let text = null;
      try { text = await ocr.recognizeCaptcha(img); } catch (e) { }
      if (!text) { captcha = null; await sleep(400); continue; }
      captcha = text;
      continue;
    }
    return { ok: false, message: '辅助账号登录失败' };
  }
  return { ok: false, message: '辅助账号登录多次失败（验证码未通过）' };
}

// ---------------- 独家：查询实名信息 ----------------
const RN_COOLDOWN = 24 * 60 * 60 * 1000;   // 4399 限制约每天一次，本地缓存 24 小时

// 命中本地缓存 → 直接返回；需要真正查询 → 起一个后台任务（有进度、可取消）
async function doRealname(id, force) {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };

  const cached = acc.realName;
  const nextAt = cached && cached.at ? cached.at + RN_COOLDOWN : 0;
  if (cached && !force && Date.now() < nextAt) {
    return { ok: true, cached: true, realName: cached, nextAt };
  }
  if (!acc.cookies) return { error: '该账号缺少登录态，请重新登录后再试' };

  const helper = resolveHelper();
  if (!helper.ok) return { error: helper.error };

  return startRealnameJob(id, helper, acc);
}

function startRealnameJob(id, helper, acc) {
  const job = createJob('realname', api.RN_STEP_LABELS.length, '实名信息查询');
  job.items = api.RN_STEP_LABELS.map((text, i) => ({ idx: i, text, state: 'wait', message: '' }));

  (async () => {
    try {
      let helperJar, helperName = helper.username, helperUid = null;
      if (helper.mode === 'account') {
        helperJar = helper.jar;                     // 直接复用已登录账号的登录态，无需密码、无需再登录
        helperUid = helper.accountId ? String(helper.accountId) : null;
      } else {
        helperJar = new CookieJar();
        const hl = await helperLogin(helperJar, helper);
        if (!hl.ok) {
          if (/频繁|稍后/.test(hl.message || '')) noteRisk('ratelimit', '辅助账号登录', hl.message);
          job.state = 'error'; job.error = '辅助账号登录失败：' + hl.message;
          job.errorTimeout = api.isTimeoutMsg(hl.message);
          return;
        }
        try { helperUid = api.uidFromJar(helperJar) || null; } catch (e) { helperUid = null; }
      }
      if (!helperName) { job.state = 'error'; job.error = '辅助账号缺少用户名，请在设置里重新配置'; return; }
      if (job.cancelled) { job.state = 'cancelled'; return; }

      const targetJar = CookieJar.fromJSON(acc.cookies);
      const r = await api.getRealNameInfo(targetJar, helperJar, helperName, helperUid, id, true, {
        isCancelled: () => job.cancelled,
        onProgress: (n, total, text) => {
          job.done = n;
          const it = job.items[n - 1];
          if (it) { it.state = 'ok'; it.message = text || ''; }
        },
      });

      if (!r.ok) {
        if (/频繁|稍后|重复/.test(r.message || '')) noteRisk('ratelimit', '实名查询', r.message);
        job.state = 'error'; job.error = r.message;
        job.errorTimeout = api.isTimeoutMsg(r.message);
        const it = job.items.find((x) => x.state === 'wait');
        if (it) { it.state = 'err'; it.message = job.errorTimeout ? '查询超时' : r.message; }
        return;
      }

      // 记住「这次是哪个账号帮忙验证的」：kuid 能在本地账号里匹配到就用本地昵称
      const list = loadAccounts();
      const a2 = list.find((a) => a.id === id) || acc;
      const hAcc = r.kuid ? list.find((a) => String(a.uid) === String(r.kuid)) : null;
      a2.realName = {
        name: r.name || null, idCard: r.idCard || null, phone: r.phone || null,
        at: Date.now(), kuid: r.kuid || null,
        helperName: r.helperName || helperName || null,
        helperNick: hAcc ? (hAcc.nickname || hAcc.username || null) : null,
        released: !!r.released,
        masked: true,
      };
      saveAccounts(list);
      noteRisk('ok', '实名查询', (helper.mode === 'account' ? '复用登录态' : '密码登录') + (r.released ? ' · 已解除占用' : ''));
      for (const it of job.items) if (it.state === 'wait') it.state = 'skip';   // 跳过的步骤（例如命中已有绑定）
      job.result = { ok: true, cached: false, realName: a2.realName, nextAt: a2.realName.at + RN_COOLDOWN };
      job.state = 'done';
    } catch (e) {
      if (e && e.cancelled) { job.state = 'cancelled'; return; }
      job.state = 'error';
      logError('realname job ' + id, e);
      job.error = netErrorMessage(e);
      job.errorTimeout = api.isTimeoutMsg(job.error);
      const it = job.items.find((x) => x.state === 'wait');
      if (it) { it.state = 'err'; it.message = job.errorTimeout ? '查询超时' : job.error; }
    }
  })();

  return { ok: true, jobId: job.id, total: job.items.length };
}

// 手动解除占用（= 监护平台「重新申请」）：查询后已自动解除，这里保留给需要时手动触发
async function doRealnameCancel(id) {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };
  if (!acc.cookies) return { error: '该账号缺少登录态，请重新登录后再试' };

  const targetJar = CookieJar.fromJSON(acc.cookies);
  const auth = await api.jianhuAuth(targetJar);
  if (!auth.ok) return { error: auth.message || '监护平台登录态获取失败' };
  const st = await api.getCheckStatus(targetJar);
  if (!st.kuid) return { error: '当前没有被占用的绑定' };
  const c = await api.cancelRealNameCheck(targetJar, st.kuid);
  if (!c.ok) return { error: '解除占用失败：' + (c.msg || '未知原因') };
  return { ok: true, kuid: st.kuid, wasStatus: st.status };
}

// ---------------- 设置 · 调试工具 ----------------
// 测试 OCR：上传一张验证码图片，返回识别结果与耗时
async function doOcrTest(dataUrl) {
  const { buffer } = decodeDataUrl(dataUrl);
  if (!buffer || !buffer.length) return { ok: false, message: '没有收到图片数据' };
  const status = ocr.status();
  if (!ocr.available()) return { ok: false, message: 'OCR 未就绪：' + (status.error || '未知原因'), status };
  const t0 = Date.now();
  let text = null;
  try { text = await ocr.recognizeCaptcha('data:image/png;base64,' + buffer.toString('base64')); } catch (e) { }
  return { ok: !!text, text: text || null, ms: Date.now() - t0, status: ocr.status() };
}

// 拉取一张真实的 4399 验证码并直接识别（不用本地选图，也不消耗登录尝试）
async function doOcrSample() {
  const status = ocr.status();
  if (!ocr.available()) return { ok: false, message: 'OCR 未就绪：' + (status.error || '未知原因'), status };
  const jar = new CookieJar();
  let img = null;
  // 4399 的验证码接口用任意 captchaId 都会下发一张真实的 60x30 验证码
  try { img = await api.fetchPlainCaptcha(jar, String(Math.floor(Math.random() * 1e9))); } catch (e) { }
  if (!img) return { ok: false, message: '验证码图片下载失败（网络不通或被限流）', status };
  const t0 = Date.now();
  let text = null;
  try { text = await ocr.recognizeCaptcha(img); } catch (e) { }
  return { ok: !!text, text: text || null, ms: Date.now() - t0, image: img, status: ocr.status() };
}

// 主动探测风控：用随机用户名真实请求一次登录接口，看 4399 是否要求验证码 / 限流
async function doRiskProbe() {
  const jar = new CookieJar();
  const state = api.randomState();
  let fields = {};
  try { ({ fields } = await api.fetchAuthorizePage(jar, state)); } catch (e) {
    return { ok: false, message: '无法访问 4399 登录页：' + (e.message || e) };
  }
  const probeUser = 'riskprobe_' + Math.random().toString(36).slice(2, 8);
  let r;
  try {
    r = await api.submitLogin(jar, fields, {
      username: probeUser, password: 'probe_' + Math.random().toString(36).slice(2, 10), captcha: null, captchaId: null,
    });
  } catch (e) {
    return { ok: false, message: '探测请求失败：' + (e.message || e) };
  }
  let verdict, message;
  if (r.needCaptcha || r.captchaError) {
    verdict = 'captcha';
    message = '4399 要求输入验证码 —— 当前 IP 很可能已被风控';
    noteRisk('captcha', '风控探测', probeUser);
  } else if (r.blocked) {
    verdict = 'blocked';
    message = '4399 静默拒绝了登录请求（未返回任何原因）—— 当前 IP 很可能已被风控，稍等几十秒后重试';
    noteRisk('blocked', '风控探测', probeUser);
  } else if (r.rateLimited) {
    verdict = 'ratelimit';
    message = '4399 返回「请稍后再试」—— 当前 IP 正在被限流';
    noteRisk('ratelimit', '风控探测', '请稍后再试');
  } else {
    verdict = 'clear';
    message = '未要求验证码，当前状态正常' + (r.error ? '（' + r.error + '）' : '');
    noteRisk('ok', '风控探测', '正常');
  }
  return { ok: true, verdict, message, detail: { error: r.error || null, status: r.status || null }, risk: riskSummary() };
}

// 从上传的文件 / 粘贴的文本里提取账号密码
function extractFromFiles(files) {
  const out = [];
  for (const f of (Array.isArray(files) ? files : [])) {
    let buf;
    try { buf = Buffer.from(String((f && f.b64) || ''), 'base64'); } catch (e) { continue; }
    if (!buf.length) continue;
    const { enc, text } = extract.readSmartBuffer(buf);
    const pairs = extract.extractPairs(text);
    out.push({ name: (f && f.name) || '(未命名)', enc, count: pairs.length, pairs });
  }
  return { ok: true, files: out };
}
function extractFromText(text) {
  const pairs = extract.extractPairs(String(text || ''));
  return { ok: true, files: [{ name: '粘贴的文本', enc: 'text', count: pairs.length, pairs }] };
}

function openDataDir() {
  try {
    const { spawn } = require('child_process');
    spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, path: DATA_DIR };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

// ---------------- 音乐组件：抓取网易云公开页面的封面/标题（仅用公开页面，不接第三方 API） ----------------
const MUSIC_DIR = path.join(DATA_DIR, 'music-covers');
function loadMusicCache() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(MUSIC_CACHE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveMusicCache(c) {
  ensureData();
  fs.writeFileSync(MUSIC_CACHE_FILE, JSON.stringify(c, null, 2), 'utf8');
}
function httpGetBuffer(url, headers, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve) => {
    if (redirects > 5) return resolve({ status: 0, buf: Buffer.alloc(0), type: '' });
    https.get(url, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Referer': 'https://music.163.com/',
      }, headers || {}),
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(httpGetBuffer(new URL(r.headers.location, url).href, headers, redirects + 1));
      }
      const chunks = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve({ status: r.statusCode, buf: Buffer.concat(chunks), type: r.headers['content-type'] || '' }));
    }).on('error', () => resolve({ status: 0, buf: Buffer.alloc(0), type: '' }));
  });
}
// 网易云 CDN 支持按需缩放：直接取原图会拿到 1925×1925 的 PNG（单张约 6MB）。
// 用 imageView 参数取 300×300 的 JPEG，单张约 12KB，音乐组件里足够清晰。
function slimCoverUrl(url) {
  const u = String(url || '');
  if (!u) return u;
  if (!/music\.126\.net/.test(u)) return u;
  if (/imageView|param=/.test(u)) return u;      // 已经是缩略图地址，别重复拼
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'imageView&thumbnail=300y300&type=jpg';
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}
async function musicMeta(id, type) {
  id = String(id || '').trim();
  if (!/^\d{3,20}$/.test(id)) return { ok: false, message: '歌曲/歌单 id 不合法' };
  const isPlaylist = String(type) === '0';
  const kind = isPlaylist ? 'playlist' : 'song';
  const key = kind + ':' + id;
  const cache = loadMusicCache();
  if (cache[key] && cache[key].title) return Object.assign({ ok: true, cached: true }, cache[key]);

  const pageUrl = 'https://music.163.com/' + kind + '?id=' + id;
  const { status, buf } = await httpGetBuffer(pageUrl);
  if (status !== 200 || !buf.length) return { ok: false, message: '无法访问网易云页面（HTTP ' + status + '）' };
  const html = buf.toString('utf8');
  const pick = (prop) => {
    const m = html.match(new RegExp('<meta[^>]+property="' + prop + '"[^>]+content="([^"]*)"', 'i'))
      || html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+property="' + prop + '"', 'i'));
    return m ? decodeEntities(m[1]) : '';
  };
  let title = pick('og:title').replace(/\s*-\s*网易云音乐\s*$/, '').trim();
  let artist = '';
  if (isPlaylist) {
    title = title.replace(/\s*-\s*歌单\s*$/, '').trim();
  } else {
    const parts = title.split(/\s+-\s+/);
    if (parts.length >= 2) { artist = parts[1]; title = parts[0]; }
    title = title.replace(/\s*-\s*单曲\s*$/, '').trim();
  }
  let cover = pick('og:image');
  if (cover && cover.startsWith('//')) cover = 'https:' + cover;
  if (cover && cover.startsWith('http:')) cover = 'https:' + cover.slice(5);

  const meta = { id, kind, title: title || id, artist, coverUrl: cover || null, at: Date.now() };
  if (meta.coverUrl) {
    // 顺手把封面缓存到本地，避免浏览器直连网易云被防盗链拦截
    try {
      const c = await httpGetBuffer(slimCoverUrl(meta.coverUrl));
      if (c.status === 200 && c.buf.length && /image\//.test(c.type)) {
        fs.mkdirSync(MUSIC_DIR, { recursive: true });
        // 按文件头判断真实格式（网易云有时 content-type 与内容不符）
        let ext = 'jpg';
        if (c.buf.length > 8 && c.buf[0] === 0x89 && c.buf[1] === 0x50) ext = 'png';
        else if (c.buf.length > 12 && c.buf.slice(0, 4).toString('ascii') === 'RIFF' && c.buf.slice(8, 12).toString('ascii') === 'WEBP') ext = 'webp';
        const base = path.join(MUSIC_DIR, key.replace(':', '_'));
        for (const e of ['jpg', 'png', 'webp']) { try { fs.rmSync(base + '.' + e, { force: true }); } catch (e2) { } }
        fs.writeFileSync(base + '.' + ext, c.buf);
        meta.coverLocal = '/api/music/cover?id=' + encodeURIComponent(id) + '&type=' + (isPlaylist ? '0' : '2');
      }
    } catch (e) { /* 忽略 */ }
  }
  cache[key] = meta;
  saveMusicCache(cache);
  return Object.assign({ ok: true, cached: false }, meta);
}
function musicCover(id, type) {
  const isPlaylist = String(type) === '0';
  const key = (isPlaylist ? 'playlist:' : 'song:') + String(id || '');
  const base = path.join(MUSIC_DIR, key.replace(':', '_'));
  for (const ext of ['jpg', 'png', 'webp']) {
    const f = base + '.' + ext;
    if (fs.existsSync(f)) return { ok: true, file: f, type: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) };
  }
  return { ok: false };
}
// 把已缓存的封面按缩略图重下一遍，并清掉旧的大图（历史遗留：单张 6MB 的 PNG）
async function slimMusicCovers() {
  const cache = loadMusicCache();
  const keys = Object.keys(cache);
  let done = 0, skipped = 0, failed = 0, savedBytes = 0, totalBytes = 0, beforeBytes = 0;
  try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch (e) { }
  for (const key of keys) {
    const meta = cache[key] || {};
    const base = path.join(MUSIC_DIR, key.replace(':', '_'));
    let old = 0;
    for (const ext of ['jpg', 'png', 'webp']) { try { old += fs.statSync(base + '.' + ext).size; } catch (e) { } }
    beforeBytes += old;
    if (!meta.coverUrl) { skipped++; totalBytes += old; continue; }
    try {
      const c = await httpGetBuffer(slimCoverUrl(meta.coverUrl));
      if (c.status !== 200 || !c.buf.length || !/image\//.test(c.type)) { failed++; totalBytes += old; continue; }
      for (const ext of ['jpg', 'png', 'webp']) { try { fs.rmSync(base + '.' + ext, { force: true }); } catch (e) { } }
      let ext = 'jpg';
      if (c.buf.length > 8 && c.buf[0] === 0x89 && c.buf[1] === 0x50) ext = 'png';
      else if (c.buf.length > 12 && c.buf.slice(0, 4).toString('ascii') === 'RIFF' && c.buf.slice(8, 12).toString('ascii') === 'WEBP') ext = 'webp';
      fs.writeFileSync(base + '.' + ext, c.buf);
      totalBytes += c.buf.length;
      if (old > c.buf.length) savedBytes += old - c.buf.length;
      // 带 v=2 让浏览器丢弃旧的缓存副本（旧响应是 max-age=86400）
      meta.coverLocal = '/api/music/cover?id=' + encodeURIComponent(meta.id || key.split(':')[1] || '') +
        '&type=' + (key.indexOf('playlist:') === 0 ? '0' : '2') + '&v=2';
      done++;
    } catch (e) { failed++; totalBytes += old; }
  }
  saveMusicCache(cache);
  return { ok: true, done, skipped, failed, beforeBytes, totalBytes, savedBytes };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      // 关于（项目信息 / 作者 / 依赖），供「设置 · 关于」页展示
      if (p === '/api/about' && req.method === 'GET') {
        let author = '—';
        try { author = os.userInfo().username || '—'; } catch (e) { }
        return sendJson(res, 200, {
          name: '4399 账号管理器',
          version: 'v1.0.0',
          host: HOST,
          address: 'http://' + HOST + ':' + PORT,
          author,
          runtime: 'Node ' + process.version + ' · ' + process.platform + ' ' + process.arch,
          dataDir: DATA_DIR,
          deps: '无第三方依赖（仅使用 Node.js 内置模块）',
        });
      }
      // 宣传片：查询 / 上传（浏览器录制后回传） / 删除
      if (p === '/api/promo' && req.method === 'GET') {
        return sendJson(res, 200, promoInfo());
      }
      if (p === '/api/promo' && req.method === 'POST') {
        const buf = await readBinary(req);
        if (!buf) return sendJson(res, 200, { ok: false, message: '视频太大（上限 80MB）或传输中断' });
        const r = savePromo(buf, req.headers['content-type']);
        if (!r.ok) logError('POST /api/promo', r.message || 'save failed');
        return sendJson(res, 200, r);
      }
      if (p === '/api/promo' && req.method === 'DELETE') {
        return sendJson(res, 200, deletePromo());
      }
      // 登录
      if (p === '/api/login' && req.method === 'POST') {
        const b = await readBody(req);
        try { return sendJson(res, 200, await doLogin(b)); }
        catch (e) {
          logError('POST /api/login', e);
          return sendJson(res, 200, { ok: false, error: netErrorMessage(e), network: true });
        }
      }
      // 刷新验证码图片
      if (p === '/api/captcha' && req.method === 'GET') {
        const sess = pending.get(u.searchParams.get('token'));
        if (!sess || !sess.captchaId) return sendJson(res, 404, { error: '验证码会话不存在' });
        const img = await api.fetchCaptchaImage(sess.jar, sess.captchaId);
        return sendJson(res, 200, { captchaImage: img });
      }
      // OCR 状态
      if (p === '/api/ocr/status' && req.method === 'GET') return sendJson(res, 200, ocr.status());
      // 本地配置（辅助账号，仅存本机）
      if (p === '/api/config' && req.method === 'GET') {
        const h = getHelper();
        const r = resolveHelper();
        const helperAcc = (h.mode === 'account' && h.accountId)
          ? loadAccounts().find((a) => a.id === h.accountId) : null;
        return sendJson(res, 200, {
          helper: {
            mode: h.mode || (h.username ? 'manual' : 'account'),
            accountId: h.accountId || null,
            username: h.username || '',
            accountName: helperAcc ? (helperAcc.username || helperAcc.nickname || helperAcc.id) : '',
            hasPassword: !!h.password,
          },
          helperReady: r.ok,
          helperError: r.ok ? null : r.error,
        });
      }
      if (p === '/api/config/helper' && req.method === 'POST') {
        const b = await readBody(req);
        const cfg = loadConfig();
        const prev = cfg.helper || {};
        const mode = b.mode === 'manual' ? 'manual' : 'account';
        const pwd = String(b.password || '');
        cfg.helper = {
          mode,
          accountId: mode === 'account' ? String(b.accountId || '') : null,
          username: String(b.username || '').trim(),
          password: pwd ? pwd : (mode === 'manual' ? String(prev.password || '') : ''),
        };
        saveConfig(cfg);
        const r = resolveHelper();
        return sendJson(res, 200, { ok: true, helperReady: r.ok, helperError: r.ok ? null : r.error });
      }
      // 运行状态（OCR + 风控/限流记录）
      if (p === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, { ocr: ocr.status(), risk: Object.assign(riskSummary(), { events: riskState.events }), time: Date.now() });
      }
      // 调试：测试打码
      if (p === '/api/ocr/test' && req.method === 'POST') return sendJson(res, 200, await doOcrTest((await readBody(req)).image));
      if (p === '/api/ocr/sample' && req.method === 'POST') return sendJson(res, 200, await doOcrSample());
      // 调试：主动探测风控
      if (p === '/api/risk/probe' && req.method === 'POST') return sendJson(res, 200, await doRiskProbe());
      // 调试：打开数据目录
      if (p === '/api/open-data-dir' && req.method === 'POST') return sendJson(res, 200, openDataDir());
      // 本地账号库
      if (p === '/api/vault' && req.method === 'GET') return sendJson(res, 200, { vault: loadVault() });
      if (p === '/api/vault/import' && req.method === 'POST') {
        const b = await readBody(req);
        return sendJson(res, 200, importVault(b.items, b.note));
      }
      if (p === '/api/vault/bulk' && req.method === 'POST') return sendJson(res, 200, bulkVault(await readBody(req)));
      if (p === '/api/vault/update' && req.method === 'POST') {
        const b = await readBody(req);
        return sendJson(res, 200, updateVaultItem(String(b.id || ''), b.note));
      }
      if (p === '/api/vault/delete' && req.method === 'POST') {
        const b = await readBody(req);
        return sendJson(res, 200, deleteVaultItem(String(b.id || '')));
      }
      // 从文本 / 文件批量提取账号密码
      if (p === '/api/import/extract' && req.method === 'POST') {
        const b = await readBody(req);
        if (b && b.text !== undefined) return sendJson(res, 200, extractFromText(b.text));
        return sendJson(res, 200, extractFromFiles(b && b.files));
      }
      // 音乐组件：封面 / 标题
      if (p === '/api/music/meta' && req.method === 'GET') {
        return sendJson(res, 200, await musicMeta(u.searchParams.get('id'), u.searchParams.get('type')));
      }
      if (p === '/api/music/cover' && req.method === 'GET') {
        const c = musicCover(u.searchParams.get('id'), u.searchParams.get('type'));
        if (!c.ok) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no cover'); }
        res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(c.file));
      }
      if (p === '/api/music/covers/slim' && req.method === 'POST') {
        return sendJson(res, 200, await slimMusicCovers());
      }
      // 注册账号
      if (p === '/api/register' && req.method === 'POST') return sendJson(res, 200, await doRegister(await readBody(req)));
      if (p === '/api/register/captcha' && req.method === 'GET') {
        const sess = pendingReg.get(u.searchParams.get('token'));
        if (!sess || !sess.sessionId) return sendJson(res, 404, { error: '注册会话不存在' });
        const img = await api.fetchCaptchaImage(sess.jar, sess.sessionId);
        return sendJson(res, 200, { captchaImage: img });
      }
      // 头像代理（解决 a.img4399.com 防盗链）
      if (p === '/api/avatar' && req.method === 'GET') {
        const uid = (u.searchParams.get('uid') || '').trim();
        if (!/^\d{3,}$/.test(uid)) return sendJson(res, 400, { error: 'uid 不合法' });
        const img = await api.fetchAvatar(uid);
        if (!img || !img.ok) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('avatar not found'); }
        res.writeHead(200, { 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=3600' });
        return res.end(img.body);
      }
      // 账号列表
      if (p === '/api/accounts' && req.method === 'GET') return sendJson(res, 200, { accounts: loadAccounts().map(publicAccount) });
      // 批量操作（移动到分组 / 删除）
      if (p === '/api/accounts/bulk' && req.method === 'POST') return sendJson(res, 200, bulkAccounts(await readBody(req)));

      // 区服查询预设游戏
      if (p === '/api/game-presets' && req.method === 'GET') return sendJson(res, 200, { presets: api.GAME_PRESETS });

      // 分组
      if (p === '/api/folders') {
        if (req.method === 'GET') return sendJson(res, 200, { folders: loadFolders() });
        if (req.method === 'POST') { const b = await readBody(req); return sendJson(res, 200, createFolder(b.name, b.parentId)); }
      }
      const fm = p.match(/^\/api\/folders\/([^/]+)$/);
      if (fm && req.method === 'POST') {
        const fid = decodeURIComponent(fm[1]);
        const b = await readBody(req);
        if (b.action === 'delete') return sendJson(res, 200, deleteFolder(fid));
        if (b.action === 'move') return sendJson(res, 200, moveFolder(fid, b.parentId));
        return sendJson(res, 200, renameFolder(fid, b.name));
      }

      // 备份 / 恢复
      if (p === '/api/backup' && req.method === 'GET') return sendJson(res, 200, exportBackup());
      if (p === '/api/restore' && req.method === 'POST') {
        const b = await readBody(req);
        return sendJson(res, 200, importBackup(b, b.mode));
      }

      // 数据概览 / 恢复默认配置 / 清除全部数据
      if (p === '/api/data/summary' && req.method === 'GET') return sendJson(res, 200, dataSummary());
      if (p === '/api/config/reset' && req.method === 'POST') return sendJson(res, 200, resetConfig());
      if (p === '/api/data/wipe' && req.method === 'POST') {
        const b = await readBody(req);
        return sendJson(res, 200, wipeAllData(b && b.confirm));
      }

      // 后台任务状态 / 取消
      const jm = p.match(/^\/api\/jobs\/([^/]+)(\/cancel)?$/);
      if (jm) {
        purgeJobs();
        const job = jobs.get(decodeURIComponent(jm[1]));
        if (!job) return sendJson(res, 404, { error: '任务不存在或已过期' });
        if (jm[2]) { job.cancelled = true; return sendJson(res, 200, { ok: true, id: job.id }); }
        return sendJson(res, 200, jobView(job));
      }

      // /api/accounts/:id/xxx
      const m = p.match(/^\/api\/accounts\/([^/]+)\/(refresh|sign|delete|history|roles|profile-form|profile|avatar|meta|security|realname|realname-cancel)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const act = m[2];
        if (act === 'refresh') return sendJson(res, 200, await refreshAccount(id));
        if (act === 'sign') { const b = await readBody(req); return sendJson(res, 200, await signAccount(id, b.type)); }
        if (act === 'delete') {
          const list = loadAccounts().filter((a) => a.id !== id);
          saveAccounts(list);
          return sendJson(res, 200, { ok: true });
        }
        if (act === 'history') return sendJson(res, 200, await getHistory(id));
        if (act === 'profile-form') return sendJson(res, 200, await getProfileForm(id));
        if (act === 'profile' && req.method === 'POST') return sendJson(res, 200, await saveProfile(id, await readBody(req)));
        if (act === 'avatar' && req.method === 'POST') return sendJson(res, 200, await saveAvatar(id, await readBody(req)));
        if (act === 'meta' && req.method === 'POST') return sendJson(res, 200, saveMeta(id, await readBody(req)));
        if (act === 'security') return sendJson(res, 200, await getSecurity(id));
        if (act === 'realname') return sendJson(res, 200, await doRealname(id, u.searchParams.get('force') === '1'));
        if (act === 'realname-cancel' && req.method === 'POST') return sendJson(res, 200, await doRealnameCancel(id));
        if (act === 'roles') {
          if (req.method === 'GET') {
            const abbr = u.searchParams.get('abbr') || '';
            return sendJson(res, 200, await getRoleOptions(id, abbr));
          }
          const b = await readBody(req);
          return sendJson(res, 200, startRolesJob(id, b.abbr, b.sids));
        }
      }
      return sendJson(res, 404, { error: '未知接口' });
    }
    // 宣传片文件（data/promo.*）：带 Range 支持，便于 <video> 拖动进度
    if (p === '/media/promo') {
      const info = promoInfo();
      if (!info.exists) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no promo'); }
      const file = path.join(DATA_DIR, info.name);
      const total = info.bytes;
      const range = req.headers.range;
      const head = { 'Content-Type': info.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
        if (!isFinite(start) || start < 0) start = 0;
        if (!isFinite(end) || end >= total) end = total - 1;
        if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end(); }
        res.writeHead(206, Object.assign({ 'Content-Range': 'bytes ' + start + '-' + end + '/' + total, 'Content-Length': end - start + 1 }, head));
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, Object.assign({ 'Content-Length': total }, head));
      return fs.createReadStream(file).pipe(res);
    }
    serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, { error: logError('HTTP ' + req.method + ' ' + req.url, e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('4399 管理器已启动: http://' + HOST + ':' + PORT);
  console.log('（仅本机可访问；账号登录态保存在 data/accounts.json）');
  // 后台预热验证码 OCR 桥（失败不影响手动输入验证码）
  ocr.start().then((ok) => {
    const s = ocr.status();
    if (ok) console.log('验证码 OCR 已就绪');
    else console.warn('验证码 OCR 未就绪：' + (s.error || '未知原因') + '（仍可手动输入验证码）');
  }).catch(() => { });
});

process.on('exit', () => { try { ocr.stop(); } catch (e) { } });
process.on('uncaughtException', (e) => { logError('uncaughtException', e); });
process.on('unhandledRejection', (e) => { logError('unhandledRejection', e); });
