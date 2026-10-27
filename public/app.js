'use strict';

const $ = (s) => document.querySelector(s);

let sessionToken = null;
let captchaId = null;
let allAccounts = [];
let folders = [];
const collapsedFolders = new Set();
let folderMenuEl = null;
let regionCache = null;
let presetCache = null;
let firstRender = true;

/* ---------- 工具 ---------- */
const TOAST_ICONS = { success: 'checkCircle', error: 'xCircle', info: 'info', warn: 'alert' };
function toast(msg, type = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="toast-ico">${icon(TOAST_ICONS[type] || 'info')}</span>`
    + `<span class="toast-msg">${esc(msg)}</span><span class="toast-bar"></span>`;
  box.appendChild(el);
  const dur = type === 'error' ? 4600 : 3200;
  el.querySelector('.toast-bar').style.animationDuration = dur + 'ms';
  requestAnimationFrame(() => el.classList.add('show'));
  let removed = false;
  const remove = () => {
    if (removed) return; removed = true;
    el.classList.remove('show'); el.classList.add('hide');
    setTimeout(() => el.remove(), 260);
  };
  const timer = setTimeout(remove, dur);
  el.addEventListener('click', () => { clearTimeout(timer); remove(); });
}

/* ---------- 悬停提示（data-tip，鼠标停留约 0.45s 后出现在指针旁） ---------- */
let tipEl = null, tipTimer = null, tipTarget = null, tipX = 0, tipY = 0;
function placeTip(x, y) {
  if (!tipEl) return;
  const pad = 14, edge = 8, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let left = x + pad;
  if (left + w > window.innerWidth - edge) left = window.innerWidth - edge - w;
  if (left < edge) left = edge;
  let top = y + pad;
  if (top + h > window.innerHeight - edge) top = y - h - pad;
  if (top < edge) top = edge;
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
}
function hideTip() {
  clearTimeout(tipTimer); tipTimer = null; tipTarget = null;
  if (tipEl) tipEl.classList.remove('show');
}
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (t === tipTarget) return;
  hideTip();
  if (!t) return;
  tipTarget = t;
  tipTimer = setTimeout(() => {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl); }
    tipEl.textContent = t.getAttribute('data-tip');
    placeTip(tipX, tipY);
    tipEl.classList.add('show');
  }, 450);
});
document.addEventListener('mousemove', (e) => {
  tipX = e.clientX; tipY = e.clientY;
  if (tipEl && tipEl.classList.contains('show')) placeTip(tipX, tipY);
});
document.addEventListener('mouseout', (e) => {
  const t = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!t) return;
  if (e.relatedTarget && t.contains(e.relatedTarget)) return;
  hideTip();
});
document.addEventListener('mousedown', hideTip, true);
window.addEventListener('scroll', hideTip, true);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function letterAvatar(name) {
  const ch = (String(name || '?').trim()[0] || '?').toUpperCase();
  const colors = ['#6d8bff', '#43d9c8', '#3fb950', '#a371f7', '#f85149', '#e3b341'];
  let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const bg = colors[h % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" fill="${bg}"/><text x="50%" y="54%" font-size="26" fill="#0a0e13" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-weight="700">${esc(ch)}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDay(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
async function api(url, opts) {
  const r = await fetch(url, opts);
  let j = null;
  try { j = await r.json(); } catch (e) { throw new Error('服务返回异常'); }
  if (!r.ok && j && j.error) throw new Error(j.error);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 主题（三套完整配色，仅深色） ---------- */
const THEMES = [
  { id: '4399', name: '4399', desc: '中性石墨 · 品牌橙', accent: '#ff6a13', accent2: '#4aa8e8', bg: '#131519' },
  { id: 'tohru', name: '龙女仆', desc: '托尔珊瑚粉 · 温馨', accent: '#e8826b', accent2: '#f0b96b', bg: '#14100e' },
  { id: 'starry', name: '星空', desc: '梵高靛蓝 · 星月黄', accent: '#f2c94c', accent2: '#6fa8dc', bg: '#0a1230' },
];
const THEME_HERO = { tohru: '/theme/tohru/kv-tohru.png', starry: '/theme/starry/kv-starry.jpg' };
let accent = '4399';

function applyTheme() {
  const root = document.documentElement;
  root.classList.remove('theme-4399', 'theme-tohru', 'theme-starry');
  root.classList.add('theme-' + accent);
  root.setAttribute('data-accent', accent);
  const hero = document.getElementById('heroArt');
  if (hero) {
    const src = THEME_HERO[accent];
    if (src && hero.getAttribute('src') !== src) hero.setAttribute('src', src);
  }
}
function loadTheme() {
  try {
    const s = JSON.parse(localStorage.getItem('4399.theme') || '{}');
    if (s.accent && THEMES.some((a) => a.id === s.accent)) accent = s.accent;
  } catch (e) { /* 忽略 */ }
  applyTheme();
}
function saveTheme() {
  try { localStorage.setItem('4399.theme', JSON.stringify({ accent })); } catch (e) { /* 忽略 */ }
}
/* 4399 侧栏左下角的豆娃：每次刷新随机挑一张（只在页面加载时掷一次，切换主题不重掷） */
function initDouwa() {
  const n = 4 + Math.floor(Math.random() * 3); // douwa4 / douwa5 / douwa6
  document.documentElement.style.setProperty('--douwa', `url('/theme/4399/douwa${n}.png')`);
}
function themeCardsHtml() {
  return THEMES.map((a) =>
    `<button class="theme-card${accent === a.id ? ' active' : ''}" data-accent-pick="${a.id}">
      <span class="tc-prev" style="--tc-accent:${a.accent};--tc-accent2:${a.accent2};--tc-bg:${a.bg}"></span>
      <span class="tc-txt"><b>${esc(a.name)}</b><em>${esc(a.desc)}</em></span>
      <span class="tc-tick">${icon('check')}</span>
    </button>`).join('');
}
function bindThemePicker(box) {
  box.onclick = (e) => {
    const b = e.target.closest('[data-accent-pick]'); if (!b) return;
    accent = b.getAttribute('data-accent-pick'); saveTheme(); applyTheme();
    box.querySelectorAll('[data-accent-pick]').forEach((x) => x.classList.toggle('active', x === b));
  };
}
function openTheme() {
  openModal('外观设置', `
    <div class="theme-sec">
      <div class="theme-k">主题</div>
      <div class="theme-grid" id="themeList">${themeCardsHtml()}</div>
    </div>
    <p class="hint">三套主题各自一套完整配色（仅深色），设置保存在本机浏览器（localStorage），换设备不会同步。</p>`, 'narrow');
  bindThemePicker($('#themeList'));
}

/* ---------- 筛选 / 排序 ---------- */
const filters = { group: 'all', ip: 'all', sort: 'default' };
function passesFilters(a) {
  if (filters.group === 'none') { if (a.folderId) return false; }
  else if (filters.group !== 'all' && !folderSubtreeIds(filters.group).includes(a.folderId)) return false;
  if (filters.ip !== 'all' && String(a.ipLocation || '') !== filters.ip) return false;
  return true;
}
function sortList(list) {
  const arr = list.slice();
  if (filters.sort === 'login') arr.sort((x, y) => (y.lastLogin || 0) - (x.lastLogin || 0));
  else if (filters.sort === 'name') {
    arr.sort((x, y) => String(x.nickname || x.username || '').localeCompare(String(y.nickname || y.username || ''), 'zh'));
  }
  return arr;
}

/* ---------- 批量选择 ---------- */
let selectedIds = new Set();
let lastFiltered = [];
function updateBulkBar() {
  const bar = $('#bulkBar');
  const n = selectedIds.size;
  if (bar) bar.hidden = n === 0;
  const cnt = $('#bulkCount');
  if (cnt) cnt.textContent = n;
  const sa = $('#selectAll');
  if (sa) {
    const ids = lastFiltered.map((a) => a.id);
    const allChecked = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    sa.checked = allChecked;
    sa.indeterminate = !allChecked && ids.some((id) => selectedIds.has(id));
  }
}

/* ---------- 批量任务进度 UI ---------- */
// 账号在界面上的显示名（昵称优先，其次用户名，最后内部 id）
function accLabel(id) {
  const a = allAccounts.find((x) => x.id === id) || {};
  return a.nickname || a.username || id;
}
function taskUI(container, ids, label, opts = {}) {
  smoothModal(() => {
    container.innerHTML = `
    <div class="sign-progress">
      <div class="rp-label" id="tkLabel">${esc(label)} 0 / ${ids.length}</div>
      <div class="rp-track"><div class="rp-fill" id="tkFill" style="width:0%"></div></div>
    </div>
    <div class="sign-results">${ids.map((id) => {
      const a = allAccounts.find((x) => x.id === id) || {};
      return `<div class="sign-row" data-sr="${esc(id)}"><span class="sr-name">${esc(a.nickname || a.username || id)}</span><span class="sr-state wait">等待</span><span class="sr-msg"></span></div>`;
    }).join('')}</div>
    ${opts.cancel ? '<div class="form-actions"><button class="btn ghost" id="tkCancel">取消</button></div>' : ''}`;
  });
  const state = { aborted: false };
  const cancelBtn = container.querySelector('#tkCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    state.aborted = true;
    cancelBtn.disabled = true; cancelBtn.textContent = '正在取消…';
  });
  return {
    set(id, cls, txt, msg) {
      const row = container.querySelector(`[data-sr="${CSS.escape(id)}"]`);
      if (!row) return;
      const st = row.querySelector('.sr-state');
      st.className = 'sr-state ' + cls; st.textContent = txt;
      if (msg != null) row.querySelector('.sr-msg').textContent = msg;
    },
    progress(done, total, lb) {
      const f = container.querySelector('#tkFill');
      const l = container.querySelector('#tkLabel');
      if (f) f.style.width = Math.round(done / total * 100) + '%';
      if (l) l.textContent = `${lb} ${done} / ${total}`;
    },
    finish(lb) { const l = container.querySelector('#tkLabel'); if (l) l.textContent = lb; },
    // 在进度列表下方追加一条说明（用于点名超时 / 失败的账号）
    note(html) {
      const old = container.querySelector('#tkNote');
      if (old) old.remove();
      if (!html) return;
      const d = document.createElement('div');
      d.id = 'tkNote'; d.className = 'roles-summary timeout';
      d.style.marginTop = '10px';
      d.innerHTML = html;
      container.appendChild(d);
    },
    abortRest(txt) {
      container.querySelectorAll('.sign-row').forEach((row) => {
        const st = row.querySelector('.sr-state');
        if (st && st.classList.contains('wait')) { st.className = 'sr-state wait'; st.textContent = txt || '已取消'; }
      });
    },
    get aborted() { return state.aborted; },
  };
}

/* ---------- 后台任务：启动 → 轮询进度 → 取消 ---------- */
// start() 返回 { jobId } 时进入轮询；返回其它内容（例如实名命中本地缓存）则原样返回
async function runJob(start, opts = {}) {
  let first;
  try { first = await start(); }
  catch (e) { return { state: 'error', error: e.message }; }
  if (!first || !first.jobId) return first;

  const jobId = first.jobId;
  const btn = opts.cancelBtn || null;
  if (btn) {
    btn.hidden = false; btn.disabled = false; btn.textContent = opts.cancelText || '取消';
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '正在取消…';
      try { await api('/api/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' }); } catch (e) { }
    };
  }
  let misses = 0;
  try {
    for (let i = 0; i < 1200; i++) {
      await sleep(320);
      let j = null;
      try { j = await api('/api/jobs/' + encodeURIComponent(jobId)); misses = 0; }
      catch (e) { if (++misses > 8) return { state: 'error', error: '任务状态读取失败：' + e.message }; continue; }
      if (typeof opts.onProgress === 'function') opts.onProgress(j);
      if (j.state && j.state !== 'running') return j;
    }
    return { state: 'error', error: '任务超时' };
  } finally {
    if (btn) { btn.hidden = true; btn.onclick = null; }
  }
}

/* ---------- 批量签到 ---------- */
async function runSignBatch(ids, opts, container) {
  const total = ids.length;
  const ui = taskUI(container, ids, '签到中…', { cancel: true });
  let okN = 0, failN = 0, done = 0;
  for (const id of ids) {
    if (ui.aborted) break;
    ui.set(id, 'run', '签到中…', '');
    const parts = [];
    let accOk = true;
    if (opts.group) {
      try {
        const r = await api('/api/accounts/' + encodeURIComponent(id) + '/sign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'group' }),
        });
        if (r.ok) parts.push(r.already ? '群组今日已签' : '群组签到成功'); else { parts.push('群组签到失败'); accOk = false; }
      } catch (e) { parts.push('群组异常'); accOk = false; }
    }
    if (opts.game) {
      try {
        const r = await api('/api/accounts/' + encodeURIComponent(id) + '/sign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'game' }),
        });
        if (r.ok) parts.push(r.already ? '独家今日已签' : '独家签到成功'); else { parts.push('独家签到失败'); accOk = false; }
      } catch (e) { parts.push('独家异常'); accOk = false; }
    }
    if (accOk) { okN++; ui.set(id, 'ok', '完成', parts.join(' · ')); }
    else { failN++; ui.set(id, 'err', '失败', parts.join(' · ')); }
    done++;
    ui.progress(done, total, '签到中…');
    if (done < total) await sleep(650);
  }
  if (ui.aborted) {
    ui.abortRest('已取消');
    ui.finish(`已取消：已完成 ${done} / ${total}`);
    toast(`已取消：完成 ${done} 个，成功 ${okN}${failN ? ' · 失败 ' + failN : ''}`, 'info');
  } else {
    ui.finish(`签到完成：成功 ${okN} · 失败 ${failN}`);
    toast(`签到完成：成功 ${okN}${failN ? ' · 失败 ' + failN : ''}`, failN ? 'warn' : 'success');
  }
  loadAccounts();
}

function openSignRunner(ids, preset) {
  const hasGroup = preset ? preset.group !== false : true;
  const hasGame = preset ? preset.game !== false : true;
  const body = openModal('批量签到', `
    <div class="sign-opts">
      <label class="chk"><input type="checkbox" id="soGroup"${hasGroup ? ' checked' : ''}> 群组签到</label>
      <label class="chk"><input type="checkbox" id="soGame"${hasGame ? ' checked' : ''}> 独家游戏签到</label>
      <span class="muted">共 ${ids.length} 个账号，账号之间会自动间隔，请勿关闭窗口。</span>
    </div>
    <div class="form-actions"><button class="btn primary" id="soStart">开始签到</button></div>
    <div id="soResult"></div>`);
  $('#soStart').addEventListener('click', async (e) => {
    const group = $('#soGroup').checked, game = $('#soGame').checked;
    if (!group && !game) { toast('请至少选择一种签到', 'error'); return; }
    e.target.disabled = true; e.target.textContent = '签到中…';
    await runSignBatch(ids, { group, game }, $('#soResult'));
    e.target.disabled = false; e.target.textContent = '再签一次';
  });
}

/* ---------- 批量刷新（并发 3，可取消；整波都失败时自动降为串行） ---------- */
async function bulkRefreshSelected() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const body = openModal('批量刷新', '<div class="muted">准备中…</div>');
  const ui = taskUI(body, ids, '刷新中…', { cancel: true });
  let done = 0, okN = 0, expired = 0, fail = 0;
  const toNames = [], failNames = [];
  let active = 3, i = 0;
  while (i < ids.length) {
    if (ui.aborted) break;
    const wave = ids.slice(i, i + active);
    i += wave.length;
    const results = await Promise.all(wave.map(async (id) => {
      ui.set(id, 'run', '刷新中…', '');
      try { return { id, r: await api('/api/accounts/' + encodeURIComponent(id) + '/refresh', { method: 'POST' }) }; }
      catch (e) { return { id, err: e }; }
    }));
    let waveFail = 0;
    for (const it of results) {
      done++;
      const r = it.r || {};
      if (it.err) {
        fail++; waveFail++;
        if (/超时/.test(it.err.message || '')) { toNames.push(accLabel(it.id)); ui.set(it.id, 'err', '超时', it.err.message); }
        else { failNames.push(accLabel(it.id)); ui.set(it.id, 'err', '失败', it.err.message); }
      } else if (r.error) {
        fail++; waveFail++;
        if (r.timeout) { toNames.push(accLabel(it.id)); ui.set(it.id, 'err', '超时', r.error); }
        else { failNames.push(accLabel(it.id)); ui.set(it.id, 'err', '失败', r.error); }
      } else if (r.sessionValid === false) { expired++; ui.set(it.id, 'err', '登录失效', '需重新登录'); }
      else { okN++; ui.set(it.id, 'ok', '完成', ''); }
    }
    ui.progress(done, ids.length, active > 1 ? `刷新中（并发 ${active}）` : '刷新中…');
    if (waveFail >= wave.length && active > 1) active = 1;   // 整波都失败 → 降为串行，别继续撞风控
    if (active <= 1 && i < ids.length && !ui.aborted) await sleep(400);
  }
  const lines = [];
  if (toNames.length) lines.push(`${icon('alert')} 超时账号（已自动重试仍失败）：<b>${esc(toNames.join('、'))}</b>`);
  if (failNames.length) lines.push(`${icon('alert')} 失败账号：<b>${esc(failNames.join('、'))}</b>`);
  ui.note(lines.join('<br>'));
  if (ui.aborted) {
    ui.abortRest('已取消');
    ui.finish(`已取消：已完成 ${done} / ${ids.length}`);
    toast(`已取消：完成 ${done} 个，成功 ${okN}`, 'info');
  } else {
    ui.finish(`完成：成功 ${okN} · 登录失效 ${expired} · 失败 ${fail}`);
    toast(`刷新完成：成功 ${okN}${expired ? ' · 失效 ' + expired : ''}${fail ? ' · 失败 ' + fail : ''}`, (expired || fail) ? 'warn' : 'success');
  }
  loadAccounts();
}

/* ---------- 批量移动 / 删除 ---------- */
function bulkMoveSelected() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const opts = [{ value: '', label: '未分组' }].concat(
    folders.map((f) => ({ value: f.id, label: folderPath(f.id) })));
  openModal('移动到分组', `
    <p class="muted">将选中的 ${ids.length} 个账号移动到：</p>
    <div class="row"><label>分组</label>${customSelect('bulkFolder', opts, '', '未分组')}</div>
    <div class="form-actions"><button class="btn primary" id="bulkMoveDo">移动</button></div>`, 'narrow');
  $('#bulkMoveDo').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '移动中…';
    try {
      const r = await api('/api/accounts/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'move', ids, folderId: $('#bulkFolder').value || null }),
      });
      if (!r.ok) { toast(r.message || '移动失败', 'error'); return; }
      toast(`已移动 ${r.count} 个账号`, 'success');
      selectedIds.clear(); closeModal(); loadAccounts();
    } catch (err) { toast('移动失败：' + err.message, 'error'); }
    finally { e.target.disabled = false; e.target.textContent = '移动'; }
  });
}
async function bulkDeleteSelected() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 个账号的本地登录态？\n（不会影响 4399 账号本身）`)) return;
  try {
    const r = await api('/api/accounts/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', ids }),
    });
    if (!r.ok) { toast(r.message || '删除失败', 'error'); return; }
    toast(`已删除 ${r.count} 个账号`, 'success');
    selectedIds.clear(); loadAccounts();
  } catch (err) { toast('删除失败：' + err.message, 'error'); }
}

/* ---------- 图标（线性矢量图标，全站替代 Emoji / 符号） ---------- */
const ICONS = {
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  diamond: '<path d="M6 3h12l4 6-10 12L2 9z"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.77 5.82 22 7 14.14l-5-4.87 6.91-1.01z"/>',
  idcard: '<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8.5" cy="11" r="2.4"/><path d="M5 17c.7-1.8 2-2.7 3.5-2.7s2.8.9 3.5 2.7"/><path d="M15 9.5h4M15 13h4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  checkCircle: '<path d="M21.8 10A10 10 0 1 1 17 3.3"/><path d="m9 11 3 3L22 4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".7" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r=".7" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r=".7" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r=".7" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.83-.44-1.12-.29-.29-.44-.65-.44-1.13A1.64 1.64 0 0 1 14.44 16.4h1.99c3.05 0 5.56-2.5 5.56-5.55C22 6.01 17.46 2 12 2z"/>',
  dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowUpRight: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  skipBack: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  skipForward: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  note: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  rotateCcw: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  move: '<path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 15l3-3-3-3"/><path d="M2 12h20M12 2v20"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.8"/><path d="M6.6 6.6A17 17 0 0 0 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4.4-1"/><path d="M3 3l18 18"/><path d="M9.5 9.6a3 3 0 0 0 4.3 4.2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>',
};
function icon(name, cls) {
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
// 把 HTML 里 <span class="ico-slot" data-ico="grid"></span> 的占位换成矢量图标
function hydrateIcons(root) {
  (root || document).querySelectorAll('.ico-slot[data-ico]').forEach((el) => {
    el.innerHTML = icon(el.getAttribute('data-ico'));
    el.classList.remove('ico-slot');
    el.classList.add('ico-box');
  });
}
hydrateIcons(); // app.js 在 </body> 前加载，此时静态 DOM 已就绪

/* ---------- 自定义下拉（替代原生 <select>，彻底避免弹层白边） ---------- */
function customSelect(id, options, value, placeholder) {
  const opts = (options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const cur = opts.find((o) => String(o.value) === String(value));
  return `<div class="csel" data-csel>
    <input type="hidden" id="${id}" value="${esc(value == null ? '' : value)}">
    <button type="button" class="csel-btn" aria-haspopup="listbox" aria-expanded="false">
      <span class="csel-val${cur ? '' : ' is-ph'}">${esc(cur ? cur.label : (placeholder || '请选择'))}</span>
      <span class="csel-chev">${icon('chevronDown')}</span>
    </button>
    <div class="csel-pop" role="listbox" hidden>
      ${opts.length
        ? opts.map((o) => `<button type="button" class="csel-opt${String(o.value) === String(value) ? ' sel' : ''}" role="option" data-value="${esc(o.value)}"><span class="csel-opt-t">${esc(o.label)}</span><span class="csel-opt-c">${icon('check')}</span></button>`).join('')
        : `<div class="csel-empty">${esc(placeholder || '暂无可选项')}</div>`}
    </div>
  </div>`;
}
/* 弹层「挂到 body + fixed 定位」：
   弹窗上有 backdrop-filter（会为 fixed 后代建立包含块），滚动容器上又有 overflow: auto，
   两者都会裁切 / 错位弹层。把弹层临时移到 body 下即可彻底规避。 */
function placeCselPop(btn, pop) {
  const r = btn.getBoundingClientRect();
  const gap = 6, margin = 10, maxH = 236;
  const below = window.innerHeight - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const up = below < Math.min(maxH, 170) && above > below;   // 下方空间不够就向上弹
  pop.style.position = 'fixed';
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.width = Math.round(r.width) + 'px';
  pop.style.right = 'auto';
  pop.style.maxHeight = Math.round(Math.min(maxH, Math.max(110, up ? above : below))) + 'px';
  if (up) { pop.style.top = 'auto'; pop.style.bottom = Math.round(window.innerHeight - r.top + gap) + 'px'; }
  else { pop.style.top = Math.round(r.bottom + gap) + 'px'; pop.style.bottom = 'auto'; }
}
function resetCselPop(box, pop) {
  if (!pop) return;
  pop.hidden = true;
  pop.classList.remove('floating');
  pop.style.cssText = '';
  if (pop.parentElement !== box) box.appendChild(pop);   // 放回原来的位置
}
/* 就地重建某个自定义下拉（选项会变的场景，例如「省份 → 城市」联动） */
function rebuildCustomSelect(id, options, value, placeholder) {
  const input = $('#' + id);
  if (!input) return;
  const box = input.closest('.csel');
  if (!box) return;
  const parent = box.parentElement;
  closeCustomSelects();   // 先把可能挂在 body 上的弹层收回来，免得留下孤儿节点
  box.outerHTML = customSelect(id, options, value, placeholder);
  initCustomSelects(parent);
}
function closeCustomSelects() {
  document.querySelectorAll('.csel.open').forEach((o) => {
    o.classList.remove('open');
    resetCselPop(o, o._cselPop || o.querySelector('.csel-pop'));
    const b = o.querySelector('.csel-btn');
    if (b) b.setAttribute('aria-expanded', 'false');
  });
}
function initCustomSelects(root) {
  (root || document).querySelectorAll('.csel[data-csel]').forEach((box) => {
    if (box.dataset.bound) return;
    box.dataset.bound = '1';
    const btn = box.querySelector('.csel-btn');
    const pop = box.querySelector('.csel-pop');
    const input = box.querySelector('input[type=hidden]');
    const valEl = box.querySelector('.csel-val');
    box._cselPop = pop;
    const close = () => {
      box.classList.remove('open');
      resetCselPop(box, pop);
      btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      closeCustomSelects();
      document.body.appendChild(pop);      // 脱离所有 overflow / transform / backdrop-filter 祖先
      pop.classList.add('floating');
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      box.classList.add('open');
      placeCselPop(btn, pop);
      const sel = pop.querySelector('.csel-opt.sel') || pop.querySelector('.csel-opt');
      if (sel) pop.scrollTop = Math.max(0, sel.offsetTop - (pop.clientHeight - sel.offsetHeight) / 2);
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (pop.hidden) open(); else close(); });
    pop.addEventListener('click', (e) => {
      const o = e.target.closest('.csel-opt');
      if (!o) return;
      e.stopPropagation();
      input.value = o.dataset.value;
      valEl.textContent = o.querySelector('.csel-opt-t').textContent;
      valEl.classList.remove('is-ph');
      pop.querySelectorAll('.csel-opt').forEach((x) => x.classList.toggle('sel', x === o));
      close();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); btn.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (pop.hidden) { open(); return; }
        const items = [...pop.querySelectorAll('.csel-opt')];
        if (!items.length) return;
        const idx = items.findIndex((x) => x.classList.contains('sel'));
        const next = e.key === 'ArrowDown'
          ? Math.min(items.length - 1, idx + 1)
          : Math.max(0, idx < 0 ? 0 : idx - 1);
        items.forEach((x, i) => x.classList.toggle('sel', i === next));
        pop.scrollTop = Math.max(0, items[next].offsetTop - (pop.clientHeight - items[next].offsetHeight) / 2);
      } else if (e.key === 'Enter' && !pop.hidden) {
        e.preventDefault();
        const o = pop.querySelector('.csel-opt.sel');
        if (o) o.click();
      }
    });
  });
}
document.addEventListener('click', closeCustomSelects);
// 弹层是 fixed 定位，不跟随滚动；一旦滚动 / 改尺寸就关掉，避免错位
window.addEventListener('scroll', (e) => {
  const t = e.target;
  if (t && t.nodeType === 1 && t.classList && t.classList.contains('csel-pop')) return;  // 弹层自身滚动不算
  closeCustomSelects();
}, true);
window.addEventListener('resize', closeCustomSelects);

/* ---------- 登录 ---------- */
/* 密码框右侧的「显示 / 隐藏」小眼睛 */
const PW_EYES = [['pwEye', 'password'], ['regPwEye', 'regPwd']];
function paintPwEye(btnId, inputId) {
  const btn = $('#' + btnId), inp = $('#' + inputId);
  if (!btn || !inp) return;
  const hidden = inp.type === 'password';
  btn.innerHTML = icon(hidden ? 'eye' : 'eyeOff');
  btn.setAttribute('aria-label', hidden ? '显示密码' : '隐藏密码');
}
function resetPwEyes() {
  for (const [b, i] of PW_EYES) {
    const inp = $('#' + i);
    if (inp) inp.type = 'password';
    paintPwEye(b, i);
  }
}
for (const [b, i] of PW_EYES) {
  const btn = $('#' + b), inp = $('#' + i);
  if (!btn || !inp) continue;
  btn.addEventListener('click', () => {
    inp.type = inp.type === 'password' ? 'text' : 'password';
    paintPwEye(b, i);
    inp.focus();
  });
  paintPwEye(b, i);
}

function openLogin() {
  // 避免与通用弹窗（如批量签到）叠加
  if ($('#modal') && !$('#modal').hidden) closeModal();
  $('#loginModal').hidden = false;
  setTimeout(() => $('#username').focus(), 30);
}
function closeLogin() {
  $('#loginModal').hidden = true;
  resetLogin();
}
function resetLogin() {
  sessionToken = null; captchaId = null;
  $('#password').value = '';
  $('#captcha').value = '';
  $('#captchaRow').hidden = true;
  const oh = $('#ocrHint'); if (oh) oh.hidden = true;
  $('#cancelLoginBtn').hidden = true;
  resetPwEyes();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (!username || !password) { toast('请输入用户名和密码', 'error'); return; }

  const body = { username, password, autoCaptcha: $('#autoCaptcha') ? $('#autoCaptcha').checked : true };
  if (sessionToken) {
    body.sessionToken = sessionToken;
    body.captcha = $('#captcha').value.trim();
    body.captchaId = captchaId;
    if (!body.captcha) { toast('请输入验证码', 'error'); return; }
  }

  const btn = $('#loginBtn');
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const r = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.needCaptcha) {
      sessionToken = r.sessionToken; captchaId = r.captchaId;
      $('#captchaRow').hidden = false;
      $('#cancelLoginBtn').hidden = false;
      if (r.captchaImage) $('#captchaImg').src = r.captchaImage;
      const hint = $('#ocrHint');
      const tried = (Array.isArray(r.autoLog) ? r.autoLog : []).filter((x) => x && x.text).map((x) => x.text);
      if (r.autoCaptchaTried) {
        hint.innerHTML = `${icon('alert')} 4399 要求验证码（可能已触发风控）` +
          (tried.length ? `；已自动识别 ${tried.length} 次：<b class="mono">${esc(tried.join(' / '))}</b>，均未通过，请手动输入` : '；自动识别未通过，请手动输入');
        hint.hidden = false;
        toast('4399 要求验证码，自动识别未通过，请手动输入', 'info');
      } else {
        hint.innerHTML = `${icon('alert')} 4399 要求验证码（可能已触发风控，或本机登录较频繁），请输入图中验证码`;
        hint.hidden = false;
        toast('4399 要求输入验证码', 'info');
      }
      $('#captcha').focus();
    } else if (r.ok) {
      const acc = r.account;
      const isNew = !!r.created;
      toast((isNew ? '登录成功：' : '登录态已刷新：') + (acc.nickname || acc.username), 'success');
      if (r.vaultSaved) toast('账号与密码已加密保存到本地账号库', 'info');
      closeLogin();
      $('#username').value = '';
      await loadAccounts();
      const pend = takePendingFolder(acc.username);
      if (pend !== undefined) {
        // 注册时已经选过分组 → 直接归入，不再打扰
        try {
          if (pend) await applyFolderToAccount(acc.id, pend);
          await loadAccounts();
          toast(pend ? '已按注册时选择归入分组' : '已添加（未分组）', 'success');
        } catch (err) { toast('归类失败：' + err.message, 'error'); }
      } else if (isNew) {
        pickFolder({
          title: '加入分组',
          message: `账号「${acc.nickname || acc.username}」已添加，要放进哪个分组？`,
          confirmText: '加入分组',
          onPick: async (fid) => {
            if (fid) { await applyFolderToAccount(acc.id, fid); toast('已归入分组', 'success'); }
            await loadAccounts();
          },
        });
      }
    } else {
      const msg = r.error || '登录失败';
      if (r.blocked) toast(msg, 'error');
      else if (r.rateLimited || (r.risk && r.risk.recentRateLimit)) toast(msg + '（疑似被 4399 限流，建议稍后再试）', 'error');
      else toast(msg, 'error');
    }
  } catch (err) {
    toast('请求失败：' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
});

$('#cancelLoginBtn').addEventListener('click', resetLogin);
$('#addAccountBtn') && $('#addAccountBtn').addEventListener('click', openLogin);
$('#loginClose').addEventListener('click', closeLogin);
$('#navAdd').addEventListener('click', openLogin);
$('#loginModal').addEventListener('click', (e) => { if (e.target.id === 'loginModal') closeLogin(); });

$('#captchaImg').addEventListener('click', async () => {
  if (!sessionToken) return;
  try {
    const r = await api('/api/captcha?token=' + encodeURIComponent(sessionToken));
    if (r.captchaImage) $('#captchaImg').src = r.captchaImage;
  } catch (e) { toast('刷新验证码失败：' + e.message, 'error'); }
});

/* ---------- 统计 ---------- */
function countUp(el, target, dur = 650) {
  const start = performance.now();
  function step(now) {
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * e).toLocaleString();
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = target.toLocaleString();
  }
  requestAnimationFrame(step);
}
function renderStats(list) {
  const total = list.length;
  const ungrouped = list.filter((a) => !a.folderId).length;
  const valid = list.filter((a) => a.sessionValid !== false).length;
  const expired = list.filter((a) => a.sessionValid === false).length;
  const cards = [
    { icon: 'users', label: '账号总数', value: total, sub: '本地保存', tone: '', tip: '本机保存的账号数量' },
    { icon: 'folder', label: '未分组', value: ungrouped, sub: total ? ungrouped + ' 个待归类' : '—', tone: 'tone-teal', tip: '还没有归入任何分组的账号数量，可在「分组」页整理' },
    { icon: 'checkCircle', label: '登录态有效', value: valid, sub: total ? Math.round(valid / total * 100) + '% 可用' : '—', tone: 'tone-green', tip: '本地登录态仍然有效、可直接使用的账号数' },
    { icon: 'alert', label: '登录态过期', value: expired, sub: expired ? '需重新登录' : '全部正常', tone: 'tone-amber', tip: '本地登录态已失效、需要重新登录的账号数' },
  ];
  $('#statsRow').innerHTML = cards.map((c) => `
    <div class="stat-card ${c.tone}" data-tip="${esc(c.tip)}">
      <div class="stat-ico">${icon(c.icon)}</div>
      <div class="stat-label">${esc(c.label)}</div>
      <div class="stat-value" data-num="${Number(c.value) || 0}">${esc(c.value)}</div>
      <div class="stat-sub">${esc(c.sub)}</div>
    </div>`).join('');
  $('#statsRow').querySelectorAll('.stat-value[data-num]').forEach((el) => countUp(el, Number(el.getAttribute('data-num'))));
}

/* ---------- 账号列表 ---------- */
function folderChildren(id) { return folders.filter((f) => (f.parentId || null) === (id || null)); }
function folderSubtreeIds(id) {
  const out = [id];
  for (const f of folders) if ((f.parentId || null) === id) out.push(...folderSubtreeIds(f.id));
  return out;
}
function folderPath(id) {
  const parts = [];
  let cur = folders.find((f) => f.id === id);
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.name);
    cur = cur.parentId ? folders.find((f) => f.id === cur.parentId) : null;
  }
  return parts.join(' / ');
}
function folderName(id) {
  const f = folders.find((x) => x.id === id);
  return f ? f.name : null;
}
function renderAccounts(list) {
  const box = $('#accounts');
  const q = ($('#searchBox').value || '').trim().toLowerCase();
  let filtered = list.filter(passesFilters);
  if (q) {
    filtered = filtered.filter((a) => [a.nickname, a.username, a.uid, a.remark]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  filtered = sortList(filtered);
  lastFiltered = filtered;

  $('#accCount').textContent = list.length;
  renderStats(list);
  $('#emptyState').style.display = filtered.length ? 'none' : 'block';
  updateBulkBar();

  const animate = firstRender;
  box.innerHTML = filtered.map((a, i) => {
    const fallback = letterAvatar(a.nickname || a.username);
    const av = a.uid ? `/api/avatar?uid=${encodeURIComponent(a.uid)}${a.avatarUpdatedAt ? '&t=' + a.avatarUpdatedAt : ''}` : fallback;
    const tags = [];
    if (a.authStatus) tags.push(`<span class="tag ${a.authStatus === '已身份认证' ? 'ok' : ''}"${a.authStatus === '已身份认证' ? ' data-tip="已完成 4399 实名认证"' : ''}>${esc(a.authStatus)}</span>`);
    if (a.gender) tags.push(`<span class="tag">${esc(a.gender)}</span>`);
    if (a.region) tags.push(`<span class="tag" data-tip="4399 资料中的所在地">${esc(a.region)}</span>`);
    if (a.qq) tags.push(`<span class="tag" data-tip="4399 资料中的 QQ 号">QQ ${esc(a.qq)}</span>`);
    if (a.folderId && folderName(a.folderId)) tags.push(`<span class="tag" data-tip="所属本地分组">${icon('folder')} ${esc(folderPath(a.folderId))}</span>`);

    const metrics = [
      ['积分', a.credit ?? '—'],
      ['等级', a.grade ?? '—'],
      ['成长', a.growth ?? '—'],
      ['IP 属地', a.ipLocation || '—'],
    ];

    // 词条全部显示（自动换行），不再用 +N 收起
    let tagsHtml = tags.join('') || '<span class="tag">暂无资料</span>';

    const checked = selectedIds.has(a.id) ? ' checked' : '';
    return `
      <div class="acc-card${animate ? ' enter' : ''}${checked ? ' selected' : ''}" data-id="${esc(a.id)}" style="--i:${i}">
        <div class="acc-top">
          <label class="acc-check" data-tip="选中后可批量操作"><input type="checkbox" data-check="${esc(a.id)}"${checked}></label>
          <div class="acc-avatar"><img src="${esc(av)}" data-fallback="${esc(fallback)}" onerror="this.onerror=null;this.src=this.dataset.fallback" alt=""></div>
          <div class="acc-id">
            <div class="acc-name">${esc(a.nickname || a.username || '未知')}</div>
            <div class="acc-sub"><span>@${esc(a.username || '—')}</span><span class="dot">·</span><span>UID ${esc(a.uid || '—')}</span></div>
          </div>
          <button class="icon-btn" data-act="security" data-tip="账号安全概览（邮箱 / QQ / 身份认证 / IP 属地）" aria-label="账号安全概览">${icon('shield')}</button>
          <button class="icon-btn" data-act="realname" data-tip="查询该账号的实名信息（需先配置辅助账号）" aria-label="实名信息">${icon('idcard')}</button>
        </div>
        ${a.sessionValid === false ? `<div class="acc-alert"><span class="acc-alert-txt">${icon('alert')} 登录态已过期，建议重新登录</span></div>` : ''}
        <div class="acc-tags">${tagsHtml}</div>
        <div class="acc-metrics">${metrics.map(([k, v]) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
        ${a.remark ? `<div class="acc-remark" data-tip="本地备注（仅存本机）">${icon('note')} ${esc(a.remark)}</div>` : ''}
        <div class="acc-actions">
          <button class="btn act refresh" data-act="refresh" data-tip="重新拉取该账号的最新资料（昵称 / 积分 / 等级等）">刷新</button>
          <button class="btn act relogin" data-act="relogin" data-tip="用该账号的用户名重新登录，刷新本地登录态（不会保存密码）">重新登录</button>
          <button class="btn act sign" data-act="sign-group" data-tip="4399 个人中心（群组）每日签到，每天一次">群组签到</button>
          <button class="btn act sign" data-act="sign-game" data-tip="4399「独家游戏」每日签到，每天一次，可领游戏奖励">独家签到</button>
          <button class="btn act query" data-act="history" data-tip="查看该账号最近玩过的游戏">游玩历史</button>
          <button class="btn act query" data-act="roles" data-tip="查询指定游戏的区服角色（每个区服约 3 秒）">区服角色</button>
          <button class="btn act manage" data-act="edit" data-tip="修改昵称 / 性别 / 生日 / 地区 / 头像">编辑资料</button>
          <button class="btn act manage" data-act="meta" data-tip="设置本地备注和分组（仅存本机）">备注分组</button>
          <button class="btn act danger" data-act="delete" data-tip="删除本地登录态（不会影响 4399 账号本身）">删除</button>
        </div>
        <div class="acc-meta">上次登录 ${fmtTime(a.lastLogin)}${a.lastRefresh ? ' · 刷新 ' + fmtTime(a.lastRefresh) : ''}</div>
      </div>`;
  }).join('');
  firstRender = false;
  // 同步到 NTQQ 风格桌面壳的会话列表（shell.js 未加载时静默跳过）
  if (window.NTQQ_SHELL) window.NTQQ_SHELL.sync(list, filtered);
}

/* ---------- 分组（支持嵌套子分组） ---------- */
function renderFolders() {
  renderGroupTree();
  gdRenderBody();
}

async function loadFolders() {
  try {
    const r = await api('/api/folders');
    folders = r.folders || [];
  } catch (e) { folders = []; }
  renderFolders();
  renderFilterSelects();
}

async function newFolder(parentId) {
  const f = parentId ? folders.find((x) => x.id === parentId) : null;
  const name = prompt(f ? `在「${f.name}」下新建子分组，名称：` : '新分组名称：');
  if (name == null) return;
  const n = name.trim();
  if (!n) return;
  try {
    const r = await api('/api/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: n, parentId: parentId || null }),
    });
    if (!r.ok) { toast(r.message || '创建失败', 'error'); return; }
    if (parentId) collapsedFolders.delete(parentId);
    toast('分组已创建', 'success');
    await loadFolders();
  } catch (e) { toast('创建失败：' + e.message, 'error'); }
}

/* ---------- 通用：给账号选分组（添加 / 注册后归类） ---------- */
function applyFolderToAccount(accountId, folderId) {
  return api('/api/accounts/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'move', ids: [accountId], folderId: folderId || null }),
  });
}
// 注册时先记住分组，等这个账号真正登录添加时再自动归入
function getPendingFolders() {
  try {
    const m = JSON.parse(localStorage.getItem('4399.pendingFolder') || '{}');
    return (m && typeof m === 'object') ? m : {};
  } catch (e) { return {}; }
}
function setPendingFolder(username, folderId) {
  try {
    const m = getPendingFolders(); m[username] = folderId || null;
    localStorage.setItem('4399.pendingFolder', JSON.stringify(m));
  } catch (e) { }
}
function takePendingFolder(username) {
  const m = getPendingFolders();
  if (!Object.prototype.hasOwnProperty.call(m, username)) return undefined;
  const v = m[username];
  delete m[username];
  try { localStorage.setItem('4399.pendingFolder', JSON.stringify(m)); } catch (e) { }
  return v;
}
// 弹出「选择分组」小窗：可选已有分组，也可当场新建
async function pickFolder({ title, message, onPick, confirmText, skipText }) {
  const opts = [{ value: '', label: '未分组' }].concat(
    folders.map((f) => ({ value: f.id, label: folderPath(f.id) })));
  openModal(title, `
    <p class="muted">${esc(message)}</p>
    <div class="row"><label>分组</label>${customSelect('fpSel', opts, '', '未分组')}</div>
    <div class="row"><label>新建分组</label>
      <div class="fp-new">
        <input type="text" id="fpNewName" placeholder="输入名称后点「新建」" maxlength="20" autocomplete="off">
        <button class="btn tiny" id="fpNewBtn">新建</button>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="fpOk">${esc(confirmText || '确定')}</button>
      <button class="btn ghost" id="fpSkip">${esc(skipText || '暂不分组')}</button>
    </div>`, 'narrow');
  const okBtn = $('#fpOk'), skipBtn = $('#fpSkip');
  const run = async (fid, btn) => {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '处理中…';
    try { await onPick(fid); closeModal(); }
    catch (err) { toast('操作失败：' + err.message, 'error'); btn.disabled = false; btn.textContent = label; }
  };
  okBtn.onclick = () => run($('#fpSel').value || null, okBtn);
  skipBtn.onclick = () => run(null, skipBtn);
  $('#fpNewBtn').onclick = async () => {
    const name = $('#fpNewName').value.trim();
    if (!name) { toast('请输入新分组名称', 'error'); return; }
    try {
      const r = await api('/api/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId: null }),
      });
      if (!r.ok) { toast(r.message || '创建失败', 'error'); return; }
      await loadFolders();
      // 重建下拉（含刚建好的分组）并直接选中它
      rebuildCustomSelect('fpSel', [{ value: '', label: '未分组' }].concat(
        folders.map((f) => ({ value: f.id, label: folderPath(f.id) }))), r.folder.id, '未分组');
      $('#fpNewName').value = '';
      toast('分组「' + name + '」已创建', 'success');
    } catch (e) { toast('创建失败：' + e.message, 'error'); }
  };
}

function closeFolderMenu() {
  if (folderMenuEl) { folderMenuEl.remove(); folderMenuEl = null; }
  document.removeEventListener('mousedown', folderMenuOutside, true);
}
function folderMenuOutside(e) { if (folderMenuEl && !folderMenuEl.contains(e.target)) closeFolderMenu(); }
function openFolderMenu(id, anchor) {
  closeFolderMenu();
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const menu = document.createElement('div');
  menu.className = 'folder-menu';
  menu.innerHTML = `
    <button data-m="rename">重命名</button>
    <button data-m="child">新建子分组</button>
    <button data-m="move">移动到…</button>
    <button data-m="delete" class="danger">删除</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 170) + 'px';
  menu.style.left = Math.min(r.left, window.innerWidth - 150) + 'px';
  folderMenuEl = menu;
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const act = b.getAttribute('data-m');
    closeFolderMenu();
    if (act === 'rename') renameFolderPrompt(id);
    else if (act === 'child') newFolder(id);
    else if (act === 'move') moveFolderPrompt(id);
    else if (act === 'delete') deleteFolderConfirm(id);
  });
  setTimeout(() => document.addEventListener('mousedown', folderMenuOutside, true), 0);
}

async function renameFolderPrompt(id) {
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const name = prompt('新的分组名称：', f.name);
  if (name == null) return;
  const n = name.trim();
  if (!n || n === f.name) return;
  try {
    const r = await api('/api/folders/' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }),
    });
    if (!r.ok) { toast(r.message || '重命名失败', 'error'); return; }
    toast('分组已重命名', 'success');
    await loadFolders();
  } catch (e) { toast('操作失败：' + e.message, 'error'); }
}

function moveFolderPrompt(id) {
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const banned = new Set(folderSubtreeIds(id));
  const opts = [{ value: '', label: '（顶层）' }].concat(
    folders.filter((x) => !banned.has(x.id))
      .map((x) => ({ value: x.id, label: folderPath(x.id) })));
  openModal('移动分组', `
    <div class="row"><label>移动到</label>${customSelect('moveTarget', opts, f.parentId || '', '（顶层）')}</div>
    <div class="form-actions"><button class="btn primary" id="moveDo">移动</button></div>`);
  $('#moveDo').addEventListener('click', async () => {
    const r = await api('/api/folders/' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'move', parentId: $('#moveTarget').value || null }),
    });
    if (!r.ok) { toast(r.message || '移动失败', 'error'); return; }
    toast('已移动', 'success');
    closeModal();
    await loadFolders();
  });
}

async function deleteFolderConfirm(id) {
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const subs = folderSubtreeIds(id).length - 1;
  const msg = subs
    ? `确定删除分组「${f.name}」及其 ${subs} 个子分组？\n里面的账号会移到「未分组」，不会被删除。`
    : `确定删除分组「${f.name}」？（账号会移到「未分组」，不会被删除）`;
  if (!confirm(msg)) return;
  try {
    const r = await api('/api/folders/' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete' }),
    });
    if (!r.ok) { toast(r.message || '删除失败', 'error'); return; }
    toast('分组已删除', 'success');
    await loadFolders();
    loadAccounts();
  } catch (e) { toast('操作失败：' + e.message, 'error'); }
}

/* ================= 分组页（独立页面 · 云盘式） ================= */
let gdFolder = 'all';          // 'all' | 'none' | <folderId>
let gdView = 'grid';           // grid | list
let gdQuery = '';
const gdSelected = new Set();
let gdDragId = null;

function folderCount(id) {
  const ids = folderSubtreeIds(id);
  return allAccounts.filter((a) => a.folderId && ids.includes(a.folderId)).length;
}
function gdAccounts() {
  let list = allAccounts.filter((a) => {
    if (gdFolder === 'all') return true;
    if (gdFolder === 'none') return !a.folderId;
    return !!a.folderId && folderSubtreeIds(gdFolder).includes(a.folderId);
  });
  const q = (gdQuery || '').trim().toLowerCase();
  if (q) list = list.filter((a) => [a.nickname, a.username, a.uid, a.remark]
    .some((v) => String(v || '').toLowerCase().includes(q)));
  return sortList(list);
}
function gdAvatarSrc(a) {
  return a.uid
    ? `/api/avatar?uid=${encodeURIComponent(a.uid)}${a.avatarUpdatedAt ? '&t=' + a.avatarUpdatedAt : ''}`
    : letterAvatar(a.nickname || a.username);
}
function gdTagHtml(a) {
  const t = [];
  if (a.authStatus) t.push(`<span class="tag ${a.authStatus === '已身份认证' ? 'ok' : ''}">${esc(a.authStatus)}</span>`);
  return t.join('');
}

function renderGroupTree() {
  const box = $('#gdTree');
  if (!box) return;
  // 分组被删除后自动回到「全部账号」
  if (gdFolder !== 'all' && gdFolder !== 'none' && !folders.some((f) => f.id === gdFolder)) gdFolder = 'all';

  const rows = [];
  rows.push(`<button class="gd-node${gdFolder === 'all' ? ' active' : ''}" data-gdfolder="all">
    <span class="gd-node-caret leaf">·</span>${icon('grid')}<span class="gd-node-name" style="--depth:0">全部账号</span><span class="gd-node-count">${allAccounts.length}</span></button>`);

  const walk = (parentId, depth) => {
    for (const f of folderChildren(parentId)) {
      const kids = folderChildren(f.id);
      const collapsed = collapsedFolders.has(f.id);
      rows.push(`<button class="gd-node${gdFolder === f.id ? ' active' : ''}" data-gdfolder="${esc(f.id)}">
        <span class="gd-node-caret${kids.length ? '' : ' leaf'}" data-gdcaret="${esc(f.id)}">${kids.length ? (collapsed ? icon('chevronRight') : icon('chevronDown')) : '·'}</span>
        ${icon('folder')}<span class="gd-node-name" style="--depth:${depth}">${esc(f.name)}</span>
        <span class="gd-node-count">${folderCount(f.id)}</span>
        <span class="gd-node-menu" data-gdmanage="${esc(f.id)}" data-tip="重命名 / 新建子分组 / 移动 / 删除">${icon('chevronDown')}</span></button>`);
      if (!collapsed) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);

  const ungrouped = allAccounts.filter((a) => !a.folderId).length;
  rows.push(`<button class="gd-node${gdFolder === 'none' ? ' active' : ''}" data-gdfolder="none">
    <span class="gd-node-caret leaf">·</span>${icon('note')}<span class="gd-node-name" style="--depth:0">未分组</span><span class="gd-node-count">${ungrouped}</span></button>`);
  box.innerHTML = rows.join('');

  box.querySelectorAll('[data-gdfolder]').forEach((b) => {
    b.addEventListener('click', (e) => {
      if (e.target.closest('[data-gdcaret]') || e.target.closest('[data-gdmanage]')) return;
      gdFolder = b.getAttribute('data-gdfolder');
      gdSelected.clear();
      renderGroupTree();
      gdRenderBody();
    });
    // 拖拽落点：拖到分组上即可移动（「全部账号」不接受放置）
    const fid = b.getAttribute('data-gdfolder');
    if (fid === 'all') return;
    b.addEventListener('dragover', (e) => { if (gdDragId) { e.preventDefault(); b.classList.add('drop-on'); } });
    b.addEventListener('dragleave', () => b.classList.remove('drop-on'));
    b.addEventListener('drop', async (e) => {
      e.preventDefault();
      b.classList.remove('drop-on');
      if (!gdDragId) return;
      const ids = gdSelected.size > 1 && gdSelected.has(gdDragId) ? [...gdSelected] : [gdDragId];
      await gdMoveAccounts(ids, fid === 'none' ? null : fid);
    });
  });
  box.querySelectorAll('[data-gdcaret]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = el.getAttribute('data-gdcaret');
      if (collapsedFolders.has(id)) collapsedFolders.delete(id); else collapsedFolders.add(id);
      renderGroupTree();
    });
  });
  box.querySelectorAll('[data-gdmanage]').forEach((el) => {
    el.addEventListener('click', (ev) => { ev.stopPropagation(); openFolderMenu(el.getAttribute('data-gdmanage'), el); });
  });
}

function renderGroupCrumb() {
  const el = $('#gdCrumb');
  if (!el) return;
  const parts = [{ id: 'all', name: '全部账号' }];
  if (gdFolder === 'none') parts.push({ id: 'none', name: '未分组' });
  else if (gdFolder !== 'all') {
    const chain = [];
    let cur = folders.find((f) => f.id === gdFolder);
    while (cur) { chain.unshift(cur); cur = cur.parentId ? folders.find((f) => f.id === cur.parentId) : null; }
    chain.forEach((f) => parts.push({ id: f.id, name: f.name }));
  }
  el.innerHTML = parts.map((p, i) => {
    const last = i === parts.length - 1;
    return `<button data-gdcrumb="${esc(p.id)}" class="${last ? 'cur' : ''}">${esc(p.name)}</button>`
      + (last ? '' : `<span class="sep">${icon('chevronRight')}</span>`);
  }).join('');
  el.querySelectorAll('[data-gdcrumb]').forEach((b) => b.addEventListener('click', () => {
    gdFolder = b.getAttribute('data-gdcrumb');
    gdSelected.clear();
    renderGroupTree();
    gdRenderBody();
  }));
}

function updateGdBulk() {
  const bar = $('#gdBulk');
  if (bar) bar.hidden = gdSelected.size === 0;
  const c = $('#gdCount');
  if (c) c.textContent = gdSelected.size;
  const sa = $('#gdSelectAll');
  if (sa) {
    const list = gdAccounts();
    sa.textContent = (list.length && list.every((a) => gdSelected.has(a.id))) ? '取消全选' : '全选';
  }
}

function gdToggleSelectAll() {
  const list = gdAccounts();
  if (!list.length) return;
  const allSel = list.every((a) => gdSelected.has(a.id));
  if (allSel) list.forEach((a) => gdSelected.delete(a.id));
  else list.forEach((a) => gdSelected.add(a.id));
  gdRenderBody();
}

function gdRenderBody() {
  renderGroupCrumb();
  const box = $('#gdBody');
  if (!box) return;
  const search = $('#gdSearch');
  if (search && search.value !== gdQuery) search.value = gdQuery;
  const list = gdAccounts();
  updateGdBulk();

  if (!list.length) {
    box.innerHTML = `<div class="gd-empty">${icon('folder')}${gdQuery ? '没有匹配的账号' : '这个分组里还没有账号'}</div>`;
    return;
  }

  if (gdView === 'list') {
    box.innerHTML = `<div class="gd-list">${list.map((a) => {
      const sel = gdSelected.has(a.id) ? ' sel' : '';
      return `<div class="gd-row${sel}" data-gdacc="${esc(a.id)}" draggable="true" title="单击选中 · 拖到左侧分组即可移动">
        <div class="gd-av"><img src="${gdAvatarSrc(a)}" alt="" loading="lazy"></div>
        <span class="gd-nick">${esc(a.nickname || a.username || a.id)}</span>
        <span class="gd-uid">${a.uid ? 'UID ' + esc(a.uid) : esc(a.username || '')}</span>
        <span class="gd-row-folder">${a.folderId ? icon('folder') + esc(folderPath(a.folderId)) : '未分组'}</span>
        <span class="gd-check">${icon('check')}</span>
      </div>`;
    }).join('')}</div>`;
  } else {
    box.innerHTML = `<div class="gd-grid">${list.map((a, i) => {
      const sel = gdSelected.has(a.id) ? ' sel' : '';
      return `<div class="gd-card${sel}" data-gdacc="${esc(a.id)}" draggable="true" style="--i:${Math.min(i, 18)}" title="单击选中 · 拖到左侧分组即可移动">
        <span class="gd-check">${icon('check')}</span>
        <div class="gd-card-top">
          <div class="gd-av"><img src="${gdAvatarSrc(a)}" alt="" loading="lazy"></div>
          <div class="gd-meta">
            <div class="gd-nick">${esc(a.nickname || a.username || a.id)}</div>
            <div class="gd-uid">${a.uid ? 'UID ' + esc(a.uid) : esc(a.username || '')}</div>
          </div>
        </div>
        <div class="gd-tags">${gdTagHtml(a) || '<span class="tag">本地账号</span>'}</div>
      </div>`;
    }).join('')}</div>`;
  }

  box.querySelectorAll('[data-gdacc]').forEach((card) => {
    const id = card.getAttribute('data-gdacc');
    card.addEventListener('click', () => {
      if (gdSelected.has(id)) gdSelected.delete(id); else gdSelected.add(id);
      card.classList.toggle('sel', gdSelected.has(id));
      updateGdBulk();
    });
    card.addEventListener('dragstart', (e) => {
      gdDragId = id;
      card.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch (x) { } }
    });
    card.addEventListener('dragend', () => {
      gdDragId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.gd-node.drop-on').forEach((n) => n.classList.remove('drop-on'));
    });
  });
}

async function gdMoveAccounts(ids, folderId) {
  if (!ids || !ids.length) return;
  try {
    const r = await api('/api/accounts/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'move', ids, folderId: folderId || null }),
    });
    if (!r.ok) { toast(r.message || '移动失败', 'error'); return; }
    toast(`已移动 ${r.count} 个账号`, 'success');
    gdSelected.clear();
    await loadAccounts();
  } catch (e) { toast('移动失败：' + e.message, 'error'); }
}

function gdMoveDialog() {
  const ids = [...gdSelected];
  if (!ids.length) return;
  const opts = [{ value: '', label: '未分组' }].concat(
    folders.map((f) => ({ value: f.id, label: folderPath(f.id) })));
  openModal('移动到分组', `
    <p class="muted">将选中的 ${ids.length} 个账号移动到：</p>
    <div class="row"><label>分组</label>${customSelect('gdMoveSel', opts, '', '未分组')}</div>
    <div class="form-actions"><button class="btn primary" id="gdMoveDo">移动</button></div>`, 'narrow');
  $('#gdMoveDo').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '移动中…';
    await gdMoveAccounts(ids, $('#gdMoveSel').value || null);
    closeModal();
  });
}

/* ---------- 页面切换 + 侧栏滑动指示条 ---------- */
function renderNavIndicator() {
  const ind = $('#navInd');
  const nav = $('#sideNav');
  if (!ind || !nav) return;
  // 窄屏时导航变成横向换行排布，滑动条无法可靠定位，交给 .active 样式表达
  if (getComputedStyle(nav).flexDirection === 'row') { ind.classList.remove('on'); return; }
  const act = nav.querySelector('.nav-item.active');
  if (!act) { ind.classList.remove('on'); return; }
  const nr = nav.getBoundingClientRect(), ar = act.getBoundingClientRect();
  if (!nr.height || !ar.height) { ind.classList.remove('on'); return; }
  ind.style.height = ar.height + 'px';
  ind.style.transform = `translateY(${ar.top - nr.top}px)`;
  ind.classList.add('on');
}

const PAGE_META = {
  accounts: { nav: 'navAccounts', title: '账号总览', sub: '集中管理你的 4399 账号信息、签到与游戏角色' },
  groups: { nav: 'navGroups', title: '分组', sub: '按分组浏览账号 · 拖拽即可整理归类' },
  vault: { nav: 'navVault', title: '本地账号库', sub: '批量导入的账号密码 · 支持批量登录 / 改备注 / 复制 / 导出' },
};

function switchPage(name) {
  if (!PAGE_META[name]) name = 'accounts';
  $('#pageAccounts').hidden = name !== 'accounts';
  $('#pageGroups').hidden = name !== 'groups';
  $('#pageVault').hidden = name !== 'vault';
  for (const k of Object.keys(PAGE_META)) {
    const el = $('#' + PAGE_META[k].nav);
    if (el) el.classList.toggle('active', k === name);
  }
  $('#pageTitle').textContent = PAGE_META[name].title;
  $('#pageSub').textContent = PAGE_META[name].sub;
  renderNavIndicator();
  if (name === 'groups') { renderGroupTree(); gdRenderBody(); }
  if (name === 'vault') renderVault();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- 地区 / 预设数据 ---------- */
async function loadRegions() {
  if (regionCache) return regionCache;
  try { regionCache = await api('/regions.json'); } catch (e) { regionCache = {}; }
  return regionCache;
}
async function loadPresets() {
  if (presetCache) return presetCache;
  try { const r = await api('/api/game-presets'); presetCache = r.presets || []; } catch (e) { presetCache = []; }
  return presetCache;
}

function skeletonCards(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += '<div class="skel-card"><div class="acc-top"><div class="skel-av"></div>'
      + '<div style="flex:1;display:flex;flex-direction:column;gap:8px">'
      + '<div class="skel-line" style="height:14px;width:58%"></div>'
      + '<div class="skel-line" style="height:11px;width:36%"></div></div></div>'
      + '<div class="skel-line" style="height:12px;width:100%"></div>'
      + '<div class="skel-line" style="height:12px;width:74%"></div></div>';
  }
  return out;
}

async function loadAccounts() {
  const box = $('#accounts');
  if (box && !allAccounts.length) box.innerHTML = skeletonCards(6);
  try {
    const r = await api('/api/accounts');
    allAccounts = r.accounts || [];
    renderFolders();
    renderFilterSelects();
    renderAccounts(allAccounts);
  } catch (e) {
    toast('加载账号失败：' + e.message, 'error');
  }
}

function signMessage(r) {
  if (r.message) return r.message;
  if (!r.ok) return r.error || '签到失败';
  const d = r.data || {};
  return d.msg || d.message || '签到成功';
}

/* ---------- 模态框 ---------- */
let modalCloseTimer = null;
function openModal(title, html, cls) {
  if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; }
  closeCustomSelects();
  const m = $('#modal');
  m.classList.remove('closing');
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html || '';
  m.querySelector('.modal-box').className = 'modal-box' + (cls ? ' ' + cls : '');
  m.hidden = false;
  initCustomSelects($('#modalBody'));
  return $('#modalBody');
}
function closeModal() {
  const m = $('#modal');
  if (!m || m.hidden) return;
  closeCustomSelects();
  if (modalCloseTimer) clearTimeout(modalCloseTimer);
  const box = m.querySelector('.modal-box');
  if (box && box.classList.contains('resizing')) {   // 高度过渡中不叠加退出动画
    m.hidden = true; $('#modalBody').innerHTML = '';
    return;
  }
  m.classList.add('closing');
  modalCloseTimer = setTimeout(() => {
    modalCloseTimer = null;
    m.classList.remove('closing');
    m.hidden = true;
    $('#modalBody').innerHTML = '';
  }, 180);
}

/* 平滑改变弹窗高度：消除「加载中 → 完整内容」时的闪烁与跳变 */
function smoothModal(fn) {
  const box = document.querySelector('#modal .modal-box');
  if (!box || $('#modal').hidden) { fn(); return; }
  // 取消上一次未完成的过渡清理，避免连续切换时互相打断
  if (box._smTimer) { clearTimeout(box._smTimer); box._smTimer = null; }
  if (box._smDone) { box.removeEventListener('transitionend', box._smDone); box._smDone = null; }
  const from = box.offsetHeight;
  box.style.height = from + 'px';
  fn();
  box.style.height = 'auto';
  const to = box.offsetHeight;          // 量出内容自然高度
  box.style.height = from + 'px';       // 先锁回起始高度（尚未绘制）
  void box.offsetHeight;                // 强制回流
  box.classList.add('resizing');
  box.style.height = to + 'px';         // 平滑过渡到目标高度
  const done = () => {
    box.style.height = '';
    box.classList.remove('resizing');
    box.removeEventListener('transitionend', done);
    box._smDone = null; box._smTimer = null;
  };
  box._smDone = done;
  box.addEventListener('transitionend', done);
  box._smTimer = setTimeout(done, 450); // 兜底清理
}
function swapModalBody(html) {
  const body = $('#modalBody');
  if (!body) return body;
  closeCustomSelects();
  smoothModal(() => {
    body.innerHTML = html || '';
    body.classList.remove('swap-in');
    void body.offsetHeight;
    body.classList.add('swap-in');
  });
  initCustomSelects(body);
  return body;
}
/* 设置页内容切换：连同弹窗高度一起平滑过渡，消除切换标签时的跳变 */
function swapSettingsBody(body, html) {
  closeCustomSelects();
  smoothModal(() => {
    body.innerHTML = html;
    body.classList.remove('swap-in');
    void body.offsetHeight;
    body.classList.add('swap-in');
  });
  initCustomSelects(body);
}
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); if (!$('#loginModal').hidden) closeLogin(); }
});

/* ---------- 游玩历史 ---------- */
async function openHistory(id) {
  const body = openModal('游玩历史', '<div class="muted">加载中…</div>');
  try {
    const r = await api('/api/accounts/' + encodeURIComponent(id) + '/history');
    if (!r.ok) { swapModalBody(`<div class="muted">${esc(r.message || '获取失败')}</div>`); return; }
    if (!r.games || !r.games.length) { swapModalBody('<div class="muted">该账号暂无游玩记录</div>'); return; }
    swapModalBody(`<div class="muted">共 ${r.games.length} 个游戏</div><div class="game-list">` +
      r.games.map((g) => {
        const sub = [g.category, (g.stars != null ? g.stars + ' 星' : null), (g.tags || []).slice(0, 3).join(' / ')]
          .filter(Boolean).map(esc).join(' · ');
        const title = g.url
          ? `<a href="${esc(g.url)}" target="_blank" rel="noreferrer">${esc(g.name)}</a>`
          : esc(g.name);
        return `<div class="game-item">
          ${g.pic ? `<img class="game-pic" src="${esc(g.pic)}" alt="" onerror="this.style.display='none'">` : ''}
          <div class="game-body"><div class="game-title">${title}</div>${sub ? `<div class="game-sub">${sub}</div>` : ''}</div>
        </div>`;
      }).join('') + '</div>');
  } catch (err) {
    swapModalBody(`<div class="muted">加载失败：${esc(err.message)}</div>`);
  }
}

/* ---------- 区服角色查询（左右分栏） ---------- */
async function openRoles(id) {
  const presets = await loadPresets();
  const chips = presets.map((p) => `<button class="game-chip" data-abbr="${esc(p.abbr)}">${esc(p.name)}<span class="chip-abbr">${esc(p.abbr)}</span></button>`).join('')
    + '<button class="game-chip custom" data-abbr="">自定义…</button>';

  openModal('区服角色查询', `
    <div class="roles-wrap">
      <div class="roles-left">
        <div class="roles-games" id="rolesGames">${chips}</div>
        <div class="roles-custom" id="rolesCustom" hidden>
          <input id="rolesAbbr" type="text" placeholder="输入游戏缩写，如 ssjj" autocomplete="off">
          <button class="btn" id="rolesCustomGo">加载</button>
        </div>
        <div class="roles-filter" id="rolesFilterWrap" hidden>
          <input id="rolesFilter" type="text" placeholder="筛选区服名称…" autocomplete="off">
        </div>
        <div class="roles-srv" id="rolesSrv"><div class="muted">先选择上面的游戏。</div></div>
        <div class="roles-bar" id="rolesBar" hidden>
          <button class="btn tiny" id="rolesAll">全选</button>
          <button class="btn tiny" id="rolesInv">反选</button>
          <button class="btn tiny" id="rolesClear">清空</button>
          <span class="muted" id="rolesSel">已选 0</span>
        </div>
        <button class="btn primary roles-query" id="rolesQuery" disabled>查询选中区服</button>
      </div>
      <div class="roles-right" id="rolesRight">
        <div class="roles-empty">左侧选择游戏 ${icon('arrowRight')} 勾选区服 ${icon('arrowRight')} 查询角色</div>
      </div>
    </div>`, 'wide');

  let abbr = '';
  let servers = [];

  const sel = () => [...$('#rolesSrv').querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.value));
  const updateSel = () => {
    const n = sel().length;
    $('#rolesSel').textContent = '已选 ' + n;
    $('#rolesQuery').disabled = n === 0;
    $('#rolesQuery').textContent = n ? `查询选中区服（${n}）` : '查询选中区服';
  };
  const renderServers = () => {
    const q = ($('#rolesFilter').value || '').trim().toLowerCase();
    const list = q ? servers.filter((s) => s.name.toLowerCase().includes(q) || String(s.sid) === q) : servers;
    $('#rolesSrv').innerHTML = list.length
      ? list.map((s) => `<label class="srv"><input type="checkbox" value="${s.sid}"> <span>${esc(s.name)}</span></label>`).join('')
      : '<div class="muted">没有匹配的区服</div>';
    $('#rolesSrv').querySelectorAll('input').forEach((c) => c.addEventListener('change', updateSel));
    updateSel();
  };
  const loadServers = async (a) => {
    abbr = a;
    smoothModal(() => { $('#rolesSrv').innerHTML = '<div class="muted">加载区服中…</div>'; });
    try {
      const r = await api('/api/accounts/' + encodeURIComponent(id) + '/roles?abbr=' + encodeURIComponent(a));
      if (!r.ok) {
        smoothModal(() => { $('#rolesSrv').innerHTML = `<div class="muted">${esc(r.message || '加载失败')}</div>`; });
        return;
      }
      servers = r.servers || [];
      // 显示筛选栏 / 操作条并渲染区服列表，整体放在一次过渡里，避免高度跳变
      smoothModal(() => {
        $('#rolesFilterWrap').hidden = false;
        $('#rolesBar').hidden = false;
        $('#rolesFilter').value = '';
        renderServers();
      });
    } catch (e) {
      smoothModal(() => { $('#rolesSrv').innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`; });
    }
  };

  $('#rolesGames').addEventListener('click', (e) => {
    const chip = e.target.closest('.game-chip');
    if (!chip) return;
    $('#rolesGames').querySelectorAll('.game-chip').forEach((c) => c.classList.toggle('active', c === chip));
    const a = chip.getAttribute('data-abbr');
    if (a) { $('#rolesCustom').hidden = true; loadServers(a); }
    else { $('#rolesCustom').hidden = false; $('#rolesAbbr').focus(); }
  });
  $('#rolesCustomGo').addEventListener('click', () => {
    const a = $('#rolesAbbr').value.trim();
    if (!a) { toast('请输入游戏缩写', 'error'); return; }
    loadServers(a);
  });
  $('#rolesAbbr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#rolesCustomGo').click(); });
  $('#rolesFilter').addEventListener('input', renderServers);
  $('#rolesAll').addEventListener('click', () => { $('#rolesSrv').querySelectorAll('input').forEach((c) => { c.checked = true; }); updateSel(); });
  $('#rolesInv').addEventListener('click', () => { $('#rolesSrv').querySelectorAll('input').forEach((c) => { c.checked = !c.checked; }); updateSel(); });
  $('#rolesClear').addEventListener('click', () => { $('#rolesSrv').querySelectorAll('input').forEach((c) => { c.checked = false; }); updateSel(); });

  $('#rolesQuery').addEventListener('click', async () => {
    const sids = sel();
    if (!sids.length) { toast('请至少选择一个区服', 'error'); return; }
    const right = $('#rolesRight');
    const setRight = (html) => smoothModal(() => { right.innerHTML = html; });
    const total = sids.length;
    setRight(`<div class="roles-progress"><div class="rp-label" id="rqLabel">准备中… 0 / ${total}</div>`
      + `<div class="rp-track"><div class="rp-fill" id="rqFill" style="width:0%"></div></div>`
      + '<div class="form-actions"><button class="btn ghost tiny" id="rqCancel" hidden>取消查询</button></div></div>'
      + `<div class="sign-results">${sids.map((sid) => `<div class="sign-row" data-rs="${sid}"><span class="sr-name">区服 ${sid}</span><span class="sr-state wait">等待</span><span class="sr-msg"></span></div>`).join('')}</div>`);
    const setStep = (sid, cls, txt, msg) => {
      const row = right.querySelector(`[data-rs="${CSS.escape(String(sid))}"]`);
      if (!row) return;
      const st = row.querySelector('.sr-state');
      st.className = 'sr-state ' + cls; st.textContent = txt;
      if (msg != null) row.querySelector('.sr-msg').textContent = msg;
    };
    const j = await runJob(
      () => api('/api/accounts/' + encodeURIComponent(id) + '/roles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ abbr, sids }),
      }),
      {
        cancelBtn: right.querySelector('#rqCancel'),
        cancelText: '取消查询',
        onProgress: (job) => {
          const fill = right.querySelector('#rqFill'), lab = right.querySelector('#rqLabel');
          if (fill) fill.style.width = Math.round((job.done || 0) / (job.total || total) * 100) + '%';
          if (lab) lab.textContent = `查询中… ${job.done || 0} / ${job.total || total}`;
          (job.items || []).forEach((it) => {
            if (it.state === 'ok') setStep(it.sid, 'ok', '有角色', it.message);
            else if (it.state === 'empty') setStep(it.sid, 'wait', '无角色', '');
            else if (it.state === 'warn') setStep(it.sid, 'warn', '限流', it.message);
            else if (it.state === 'err') setStep(it.sid, 'err', it.timeout ? '超时' : '失败', it.message);
          });
        },
      });

    if (!j) { setRight('<div class="muted">查询失败</div>'); return; }
    if (j.error) { setRight(`<div class="muted">${esc(j.errorTimeout ? '查询超时（已自动重试仍失败，请稍后再试）' : j.error)}</div>`); return; }
    const q = j.result || {};
    const roles = q.roles || [];
    const cards = roles.map((role) => {
      const name = role.roleName || role.name || '未知角色';
      const lvl = role.level || role.roleLevel;
      const srv = role.servName || ('区服 ' + role.sid);
      const ban = Number(role.isBan) ? '<span class="tag ban">已封禁</span>' : '';
      const link = role.gameLink ? `<a class="role-go" href="${esc(role.gameLink)}" target="_blank" rel="noreferrer">进入游戏 ${icon('arrowUpRight')}</a>` : '';
      return `<div class="role-card">
            <div class="role-lv"><span>${esc(lvl == null ? '—' : lvl)}</span><small>级</small></div>
            <div class="role-main">
              <div class="role-name">${esc(name)} ${ban}</div>
              <div class="role-srv">${esc(srv)}</div>
            </div>
            ${link}
          </div>`;
    }).join('');
    const extra = [];
    if (q.emptyServerIds && q.emptyServerIds.length) extra.push(q.emptyServerIds.length + ' 个区服无角色');
    const fails = q.failures || [];
    const toSids = fails.filter((f) => f && f.timeout).map((f) => f.sid);
    const otherFail = fails.length - toSids.length;
    if (otherFail > 0) extra.push(otherFail + ' 个区服失败');
    if (j.state === 'cancelled') extra.push('已取消，仅显示已完成的部分');
    const toLine = toSids.length
      ? `<div class="roles-summary timeout">${icon('alert')} 超时区服（已自动重试仍失败）：<b>${toSids.join('、')}</b></div>`
      : '';
    setRight(`<div class="roles-summary">找到 <b>${roles.length}</b> 个角色${extra.length ? ' · ' + esc(extra.join(' · ')) : ''}</div>`
      + toLine
      + `<div class="role-list">${cards || '<div class="muted">所选区服均无角色</div>'}</div>`);
  });
}

/* ---------- 账号安全概览 ---------- */
async function openSecurity(id) {
  const acc = allAccounts.find((a) => a.id === id) || {};
  const body = openModal('账号安全概览', '<div class="muted">加载中…</div>', 'narrow');
  try {
    const r = await api('/api/accounts/' + encodeURIComponent(id) + '/security');
    if (r.error) { swapModalBody(`<div class="muted">${esc(r.error)}</div>`); return; }
    if (!r.ok) { swapModalBody(`<div class="muted">${esc(r.message || '获取失败，请稍后重试')}</div>`); return; }

    const row = (k, valHtml, tip) => `<div class="sec-row"${tip ? ` data-tip="${esc(tip)}"` : ''}>
      <span class="sec-k">${esc(k)}</span><span class="sec-v">${valHtml}</span></div>`;

    const email = r.email
      ? `<code>${esc(r.email)}</code> <span class="tag ${r.emailBound ? 'ok' : ''}">${r.emailBound ? '已绑定' : '未绑定'}</span>`
      : '<span class="muted">未绑定 / 未公开</span>';
    const qq = r.qq
      ? `<code>${esc(r.qq)}</code> <span class="tag ${r.qqBound ? 'ok' : ''}">${r.qqBound ? '已绑定' : '未绑定'}</span>`
      : '<span class="muted">未绑定 / 未公开</span>';
    const auth = r.authStatus
      ? `<span class="tag ${r.authStatus === '已身份认证' ? 'ok' : ''}">${esc(r.authStatus)}</span>`
      : '<span class="muted">—</span>';

    const av = acc.uid ? `/api/avatar?uid=${encodeURIComponent(acc.uid)}${acc.avatarUpdatedAt ? '&t=' + acc.avatarUpdatedAt : ''}` : letterAvatar(acc.nickname || acc.username);
    swapModalBody(`
      <div class="sec-head">
        <div class="sec-avatar"><img src="${esc(av)}" onerror="this.style.display='none'" alt=""></div>
        <div>
          <div class="sec-nick">${esc(r.nickname || acc.nickname || '未知')}</div>
          <div class="muted">用户名 ${esc(r.username || acc.username || '—')} · UID ${esc(acc.uid || '—')}</div>
        </div>
      </div>
      <div class="sec-list">
        ${row('绑定邮箱', email, '4399 资料中的邮箱（出于隐私仅显示掩码）')}
        ${row('绑定 QQ', qq, '4399 资料中的 QQ（出于隐私仅显示掩码）')}
        ${row('身份认证', auth, '是否已完成 4399 实名认证')}
        ${row('IP 属地', r.ipLocation ? esc(r.ipLocation) : '<span class="muted">—</span>')}
        ${row('所在地', r.region ? esc(r.region) : '<span class="muted">—</span>')}
        ${row('性别', r.gender ? esc(r.gender) : '<span class="muted">—</span>')}
        ${row('生日', r.birthday ? esc(r.birthday) : '<span class="muted">—</span>')}
      </div>
      <p class="hint">密保 / 手机绑定等敏感信息 4399 未在可访问页面上公开，如需管理请到
        <a href="https://u.4399.com/anquan/pwd/?_a=safeList&from=u" target="_blank" rel="noreferrer">4399 安全中心</a>。</p>`);
  } catch (e) {
    swapModalBody(`<div class="muted">加载失败：${esc(e.message)}</div>`);
  }
}

/* ---------- 快捷入口 ---------- */
const QUICK_LINKS = [
  { title: '账号安全', tone: 'teal', links: [
    ['安全中心', 'https://u.4399.com/anquan/pwd/?_a=safeList&from=u'],
    ['修改密码', 'https://u.4399.com/profile/password.html'],
    ['密码保护', 'https://u.4399.com/profile/security.html'],
    ['身份认证', 'https://u.4399.com/profile/realname.html'],
    ['找回密码', 'https://u.4399.com/account/forget?from=u'],
    ['账号申诉', 'https://u.4399.com/account/appeal'],
  ] },
  { title: '客服与监护', tone: 'violet', links: [
    ['客服中心', 'https://u.4399.com/kefu/ssjj'],
    ['家长监护', 'https://u.4399.com/jianhu/apply'],
    ['帮助中心', 'https://my.4399.com/help/'],
    ['实名验证', 'https://ptlogin.4399.com/ptlogin/realNameVerify.do'],
  ] },
  { title: '充值 · 福利', tone: 'amber', links: [
    ['充值中心', 'https://cz.4399.com/'],
    ['积分商城', 'https://my.4399.com/jifen/'],
    ['礼包中心', 'https://my.4399.com/libao/'],
    ['我的收藏盒', 'https://my.4399.com/shoucang/'],
  ] },
  { title: '社区 · 游戏', tone: 'blue', links: [
    ['4399 游戏吧', 'https://my.4399.com/'],
    ['手游论坛', 'https://bbs.4399.cn/'],
    ['4399 游戏盒', 'https://h.4399.com/'],
    ['PC 游戏', 'https://www.4399.com/pcgame/'],
    ['网页游戏', 'https://web.4399.com/'],
    ['手机游戏', 'https://www.4399.cn/'],
  ] },
];
function openLinks() {
  const groups = QUICK_LINKS.map((g) => `
    <div class="links-group">
      <div class="links-title tone-${g.tone}">${esc(g.title)}</div>
      <div class="links-grid">
        ${g.links.map(([name, url]) => `<a class="link-card" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(name)}<span class="link-go">${icon('arrowUpRight')}</span></a>`).join('')}
      </div>
    </div>`).join('');
  openModal('快捷入口', `
    <p class="muted">整理自「4399 网址合集」，点击会在浏览器新标签页打开官方页面（涉及密码 / 支付等操作时请自行确认）。</p>
    ${groups}`, 'wide');
}

/* ---------- 编辑资料 / 头像 ---------- */
async function openEditProfile(id) {
  const body = openModal('编辑资料', '<div class="muted">加载中…</div>');
  const acc = allAccounts.find((a) => a.id === id) || {};
  let form;
  try { form = await api('/api/accounts/' + encodeURIComponent(id) + '/profile-form'); }
  catch (e) { swapModalBody(`<div class="muted">加载失败：${esc(e.message)}</div>`); return; }
  if (form.error) { swapModalBody(`<div class="muted">${esc(form.error)}</div>`); return; }
  if (!form.ok) { swapModalBody(`<div class="muted">${esc(form.message || '无法加载修改页')}</div>`); return; }

  const regions = await loadRegions();
  const provinces = Object.keys(regions);

  // 解析现有地区，例如「江西-南昌」/「江西」
  let curProv = '', curCity = '';
  const region = form.region || acc.region || '';
  if (region) {
    const parts = region.split(/[-·\s]+/).filter(Boolean);
    const norm = (s) => s.replace(/(省|市|自治区|特别行政区|壮族|回族|维吾尔|自治州|地区)/g, '');
    if (provinces.includes(parts[0])) { curProv = parts[0]; curCity = parts[1] || ''; }
    else {
      const hit = provinces.find((p) => norm(p) === norm(parts[0]) || p.includes(parts[0]) || parts[0].includes(p));
      if (hit) { curProv = hit; curCity = parts[1] || ''; }
    }
  }

  const provOpts = [{ value: '', label: '请选择' }].concat(provinces.map((p) => ({ value: p, label: p })));
  const cityOpts = [{ value: '', label: '请选择' }].concat(
    (curProv && regions[curProv] ? regions[curProv] : []).map((c) => ({ value: c, label: c })));

  const avFallback = letterAvatar(acc.nickname || acc.username);
  const av = acc.uid ? `/api/avatar?uid=${encodeURIComponent(acc.uid)}${acc.avatarUpdatedAt ? '&t=' + acc.avatarUpdatedAt : ''}` : avFallback;

  swapModalBody(`
    <div class="row"><label>昵称</label><input id="pfNick" type="text" maxlength="20" value="${esc(form.nickname || acc.nickname || '')}"></div>
    <div class="row"><label>性别</label>
      ${customSelect('pfSex', [{ value: '1', label: '男' }, { value: '2', label: '女' }], form.sex === '2' ? '2' : '1')}</div>
    <div class="row"><label>生日</label><input id="pfBirthday" type="date" value="${esc(form.birthday || '')}"></div>
    <div class="row"><label>省份</label>${customSelect('pfProvince', provOpts, curProv, '请选择')}</div>
    <div class="row"><label>城市</label>${customSelect('pfCity', cityOpts, curCity, '请选择')}</div>
    <div class="form-actions"><button class="btn primary" id="pfSave">保存资料</button></div>
    <p class="hint">只修改 4399 资料页支持的字段（昵称 / 性别 / 生日 / 地区）；QQ、邮箱不在此表单内。</p>
    <hr class="sep">
    <div class="row"><label>头像</label>
      <div class="avatar-edit">
        <img id="pfAvatar" src="${esc(av)}" data-fallback="${esc(avFallback)}" onerror="this.onerror=null;this.src=this.dataset.fallback" alt="">
        <div class="avatar-edit-actions">
          <input type="file" id="pfAvatarFile" accept="image/*" hidden>
          <button class="btn" id="pfAvatarPick">选择图片</button>
          <button class="btn primary" id="pfAvatarSave" disabled>上传头像</button>
        </div>
      </div>
    </div>
    <div class="cropper" id="pfCropper" hidden>
      <canvas id="pfCanvas" width="240" height="240"></canvas>
      <div class="crop-tools">
        <span class="crop-zoom-label">缩放</span>
        <input type="range" id="pfZoom" min="100" max="400" value="100">
        <button class="btn tiny" id="pfRotate" type="button">旋转 90°</button>
        <button class="btn tiny" id="pfReset" type="button">重置</button>
      </div>
      <div class="crop-hint">拖动图片调整位置，滑块 / 滚轮缩放</div>
    </div>
    <p class="hint">支持任意比例的图片，会自动裁成 1:1 正方形后再上传（大小不超过 8MB）。</p>`);

  $('#pfProvince').addEventListener('change', (e) => {
    const list = regions[e.target.value] || [];
    rebuildCustomSelect('pfCity', [{ value: '', label: '请选择' }].concat(list.map((c) => ({ value: c, label: c }))), '', '请选择');
  });

  $('#pfSave').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await api('/api/accounts/' + encodeURIComponent(id) + '/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: $('#pfNick').value.trim(),
          sex: $('#pfSex').value,
          birthday: $('#pfBirthday').value,
          province: $('#pfProvince').value,
          city: $('#pfCity').value,
        }),
      });
      toast(r.message || (r.ok ? '资料已保存' : '保存失败'), r.ok ? 'success' : 'error');
      if (r.ok) { closeModal(); loadAccounts(); }
    } catch (err) { toast('保存失败：' + err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '保存资料'; }
  });

  /* ---- 头像裁切（纯 canvas，无外部依赖；任意比例 → 1:1） ---- */
  const CV = 240;   // 预览画布尺寸
  const OUT = 300;  // 导出尺寸
  let crop = null;  // { img, base, scale, ox, oy, rot }
  const cvs = () => $('#pfCanvas');
  function coverScale(img, rot, box) {
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    const rw = img.width * c + img.height * s;
    const rh = img.width * s + img.height * c;
    return Math.max(box / rw, box / rh);
  }
  function clampOffset() {
    if (!crop) return;
    const c = Math.abs(Math.cos(crop.rot)), s = Math.abs(Math.sin(crop.rot));
    const rw = (crop.img.width * c + crop.img.height * s) * crop.scale;
    const rh = (crop.img.width * s + crop.img.height * c) * crop.scale;
    const mx = Math.max(0, (rw - CV) / 2), my = Math.max(0, (rh - CV) / 2);
    crop.ox = Math.min(mx, Math.max(-mx, crop.ox));
    crop.oy = Math.min(my, Math.max(-my, crop.oy));
  }
  function drawCrop() {
    const cv = cvs();
    if (!crop || !cv) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, CV, CV);
    ctx.save();
    ctx.translate(CV / 2 + crop.ox, CV / 2 + crop.oy);
    ctx.rotate(crop.rot);
    ctx.scale(crop.scale, crop.scale);
    ctx.drawImage(crop.img, -crop.img.width / 2, -crop.img.height / 2);
    ctx.restore();
  }
  function exportCrop() {
    const k = OUT / CV;
    const out = document.createElement('canvas');
    out.width = OUT; out.height = OUT;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUT, OUT);
    ctx.save();
    ctx.translate(OUT / 2 + crop.ox * k, OUT / 2 + crop.oy * k);
    ctx.rotate(crop.rot);
    ctx.scale(crop.scale * k, crop.scale * k);
    ctx.drawImage(crop.img, -crop.img.width / 2, -crop.img.height / 2);
    ctx.restore();
    return out.toDataURL('image/jpeg', 0.92);
  }
  function setZoom(v) {
    if (!crop) return;
    crop.scale = crop.base * (v / 100);
    clampOffset(); drawCrop();
  }
  function resetCrop() {
    if (!crop) return;
    crop.rot = 0;
    crop.base = coverScale(crop.img, 0, CV);
    crop.ox = 0; crop.oy = 0;
    $('#pfZoom').value = '100';
    setZoom(100);
  }

  let dragging = null;
  const cvEl = cvs();
  cvEl.addEventListener('mousedown', (e) => { if (!crop) return; dragging = { x: e.clientX, y: e.clientY }; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging || !crop || !document.body.contains(cvEl)) return;
    crop.ox += e.clientX - dragging.x;
    crop.oy += e.clientY - dragging.y;
    dragging = { x: e.clientX, y: e.clientY };
    clampOffset(); drawCrop();
  });
  window.addEventListener('mouseup', () => { dragging = null; });
  cvEl.addEventListener('wheel', (e) => {
    if (!crop) return;
    e.preventDefault();
    const el = $('#pfZoom');
    const v = Math.min(400, Math.max(100, Number(el.value) + (e.deltaY < 0 ? 8 : -8)));
    el.value = String(v); setZoom(v);
  }, { passive: false });
  cvEl.addEventListener('touchstart', (e) => { if (!crop || e.touches.length !== 1) return; dragging = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  cvEl.addEventListener('touchmove', (e) => {
    if (!dragging || !crop || e.touches.length !== 1) return;
    crop.ox += e.touches[0].clientX - dragging.x;
    crop.oy += e.touches[0].clientY - dragging.y;
    dragging = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    clampOffset(); drawCrop(); e.preventDefault();
  }, { passive: false });
  cvEl.addEventListener('touchend', () => { dragging = null; });

  $('#pfZoom').addEventListener('input', (e) => setZoom(Number(e.target.value)));
  $('#pfRotate').addEventListener('click', () => {
    if (!crop) return;
    crop.rot = (crop.rot + Math.PI / 2) % (Math.PI * 2);
    crop.base = coverScale(crop.img, crop.rot, CV);
    crop.ox = 0; crop.oy = 0;
    $('#pfZoom').value = '100';
    setZoom(100);
  });
  $('#pfReset').addEventListener('click', resetCrop);

  $('#pfAvatarPick').addEventListener('click', () => $('#pfAvatarFile').click());
  $('#pfAvatarFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('图片过大（上限约 8MB）', 'error'); e.target.value = ''; return; }
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        crop = { img, base: coverScale(img, 0, CV), scale: 1, ox: 0, oy: 0, rot: 0 };
        $('#pfCropper').hidden = false;
        $('#pfZoom').value = '100';
        setZoom(100);
        $('#pfAvatarSave').disabled = false;
      };
      img.onerror = () => toast('图片读取失败', 'error');
      img.src = fr.result;
    };
    fr.readAsDataURL(f);
    e.target.value = '';
  });

  $('#pfAvatarSave').addEventListener('click', async (e) => {
    if (!crop) { toast('请先选择图片', 'error'); return; }
    const btn = e.target;
    btn.disabled = true; btn.textContent = '上传中…';
    try {
      const dataUrl = exportCrop();
      const r = await api('/api/accounts/' + encodeURIComponent(id) + '/avatar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, filename: 'avatar.jpg', type: 'image/jpeg' }),
      });
      toast(r.message || (r.ok ? '头像已更新' : '上传失败'), r.ok ? 'success' : 'error');
      if (r.ok) { closeModal(); loadAccounts(); }
    } catch (err) { toast('上传失败：' + err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '上传头像'; }
  });
}

/* ---------- 备注 / 分组 ---------- */
function openMeta(id) {
  const acc = allAccounts.find((a) => a.id === id) || {};
  const opts = [{ value: '', label: '未分组' }].concat(
    folders.map((f) => ({ value: f.id, label: folderPath(f.id) })));
  openModal('备注 / 分组', `
    <div class="row"><label>备注</label><input id="metaRemark" type="text" maxlength="50" placeholder="例如：大号 / 小号" value="${esc(acc.remark || '')}"></div>
    <div class="row"><label>分组</label>${customSelect('metaFolder', opts, acc.folderId || '', '未分组')}</div>
    <div class="form-actions"><button class="btn primary" id="metaSave">保存</button></div>`);
  $('#metaSave').addEventListener('click', async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await api('/api/accounts/' + encodeURIComponent(id) + '/meta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remark: $('#metaRemark').value.trim(), folderId: $('#metaFolder').value }),
      });
      toast(r.ok ? '已保存' : (r.error || '保存失败'), r.ok ? 'success' : 'error');
      if (r.ok) { closeModal(); loadAccounts(); }
    } catch (err) { toast('保存失败：' + err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '保存'; }
  });
}

/* ---------- 备份 / 恢复 ---------- */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
async function backupExport() {
  const r = await api('/api/backup');
  const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `4399-backup-${ts}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
function pickBackupFile() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.onchange = () => resolve((inp.files && inp.files[0]) || null);
    inp.click();
  });
}
async function backupImport() {
  const f = await pickBackupFile();
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); }
  catch (e) { toast('文件不是有效的 JSON', 'error'); return; }
  const replace = confirm('「确定」= 覆盖（清空现有后写入备份）\n「取消」= 合并（保留现有，追加 / 更新）');
  const r = await api('/api/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ mode: replace ? 'replace' : 'merge' }, data)),
  });
  if (!r.ok) { toast(r.message || '导入失败', 'error'); return; }
  toast(`导入完成：账号 ${r.accounts}${r.updated != null ? ' / 更新 ' + r.updated : ''}，分组 ${r.folders}`, 'success');
  await loadFolders();
  loadAccounts();
}

/* ---------- 清除全部数据：二次确认弹窗（独立浮层，不覆盖设置弹窗） ---------- */
function openWipeDialog(s, onDone) {
  const ov = document.createElement('div');
  ov.className = 'wipe-ov';
  ov.innerHTML = `
    <div class="wipe-box">
      <div class="wipe-title">${icon('alert')} 清除全部数据</div>
      <p class="muted">将<strong class="err">永久删除</strong>本机 data/ 下的全部数据，且<strong class="err">不可恢复</strong>：</p>
      <ul class="wipe-list">
        <li>账号登录态 <b>${s.accounts || 0}</b> 条</li>
        <li>分组 <b>${s.folders || 0}</b> 个</li>
        <li>本地账号库 <b>${s.vault || 0}</b> 条</li>
        <li>配置参数 ${s.configKeys ? '<b>' + s.configKeys + '</b> 项' + (s.helperConfigured ? '（含辅助账号）' : '') : '（无）'}</li>
        <li>音乐缓存 <b>${s.musicCached || 0}</b> 条、封面 <b>${s.covers || 0}</b> 个</li>
        <li>浏览器本地设置（主题、音乐偏好、启动动画）</li>
      </ul>
      <p class="hint tiny">如果这些数据还可能用到，请先导出备份。</p>
      <div class="form-actions">
        <button class="btn" id="wipeExport">${icon('download')} 导出备份</button>
      </div>
      <div class="row"><label for="wipeWord">输入「清除」以继续</label><input id="wipeWord" type="text" placeholder="清除" autocomplete="off"></div>
      <div class="form-actions">
        <button class="btn danger" id="wipeGo" disabled>${icon('trash')} 确认清除</button>
        <button class="btn ghost" id="wipeCancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const w = ov.querySelector('#wipeWord');
  const go = ov.querySelector('#wipeGo');
  w.oninput = () => { go.disabled = w.value.trim() !== '清除'; };
  ov.querySelector('#wipeCancel').onclick = close;
  ov.querySelector('#wipeExport').onclick = async () => {
    try { await backupExport(); toast('备份已导出', 'success'); }
    catch (e) { toast('导出失败：' + e.message, 'error'); }
  };
  go.onclick = async () => {
    if (w.value.trim() !== '清除') return;
    // 第二道确认
    if (!confirm('最后确认：真的要永久删除全部数据吗？此操作不可恢复。')) return;
    go.disabled = true;
    try {
      const r = await api('/api/data/wipe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: '清除' }),
      });
      if (!r.ok) { toast(r.message || '清除失败', 'error'); go.disabled = false; return; }
      ['4399.theme', '4399.musicAuto', '4399.musicPinned', '4399.splash'].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { } });
      close();
      toast('已清除全部数据，正在重新加载…', 'success');
      if (onDone) onDone();
      setTimeout(() => location.reload(), 900);
    } catch (e) { toast('清除失败：' + e.message, 'error'); go.disabled = false; }
  };
  w.focus();
}

/* ---------- 设置 · 数据 ---------- */
async function renderSettingsData(body) {
  body.innerHTML = '<div class="muted">加载中…</div>';
  let s = {};
  try { s = await api('/api/data/summary'); } catch (e) { }
  if (settingsTab !== 'data') return;   // 已经切走了，别覆盖
  swapSettingsBody(body, `
    <div class="set-sec">
      <div class="set-title">备份 / 恢复</div>
      <p class="hint tiny">备份包含全部账号登录态（cookie）、分组、配置参数（含辅助账号密码）以及本地账号库（密码为密文）。<strong class="warn">备份不含 <code>data/vault.key</code></strong>：换机恢复后，本地账号库里原有的密码将无法解密（重新登录一次即可重新写入）。文件只保存在你本地，请妥善保管。</p>
      <div class="form-actions">
        <button class="btn primary" id="dataExport">${icon('download')} 导出备份</button>
        <button class="btn" id="dataImport">${icon('upload')} 导入备份</button>
      </div>
      <p class="hint tiny">导入时可选「合并」（保留现有，追加 / 更新同 ID 账号）或「覆盖」（清空后写入备份内容）。</p>
    </div>

    <div class="set-sec">
      <div class="set-title">恢复默认配置</div>
      <p class="hint tiny">只重置配置参数（辅助账号、音乐组件设置等），<b>不会动任何账号数据</b>。</p>
      <div class="form-actions"><button class="btn" id="cfgReset">${icon('refresh')} 恢复默认配置</button></div>
    </div>

    <div class="set-sec">
      <div class="set-title">音乐封面瘦身</div>
      <p class="hint tiny">把已缓存的专辑封面重新取成 300×300 JPEG（单张约 12KB，原图可能是 6MB 的 PNG）。当前 ${s.covers || 0} 个封面，占 ${fmtBytes(s.coverBytes || 0)}。</p>
      <div class="form-actions"><button class="btn" id="coverSlim">${icon('refresh')} 压缩音乐封面</button></div>
    </div>

    <div class="set-sec danger-sec">
      <div class="set-title">清除全部数据</div>
      <p class="hint tiny">永久删除本机 data/ 下的全部数据，并清除浏览器本地设置。此操作不可恢复。</p>
      <div class="dbg-row"><span>账号</span><b>${s.accounts || 0} 条</b></div>
      <div class="dbg-row"><span>分组</span><b>${s.folders || 0} 个</b></div>
      <div class="dbg-row"><span>本地账号库</span><b>${s.vault || 0} 条</b></div>
      <div class="dbg-row"><span>配置参数</span><b>${s.configKeys ? s.configKeys + ' 项' + (s.helperConfigured ? '（含辅助账号）' : '') : '无'}</b></div>
      <div class="dbg-row"><span>音乐缓存</span><b>${s.musicCached || 0} 条 / 封面 ${s.covers || 0} 个</b></div>
      <div class="dbg-row"><span>宣传片</span><b>${s.promo ? esc(s.promo.name) + ' · ' + fmtBytes(s.promo.bytes) : '无'}</b></div>
      <div class="dbg-row"><span>占用空间</span><b>${fmtBytes((s.bytes || 0) + (s.promo ? s.promo.bytes : 0))}</b></div>
      <div class="form-actions">
        <button class="btn" id="dataExport2">${icon('download')} 导出备份</button>
        <button class="btn danger" id="dataWipe">${icon('trash')} 清除全部数据</button>
      </div>
    </div>

    <div class="set-sec">
      <div class="set-title">数据目录</div>
      <div class="dbg-row"><span>路径</span><code class="mono">${esc(s.dataDir || 'data/')}</code></div>
      <div class="form-actions"><button class="btn ghost tiny" id="openDataBtn">${icon('folder')} 打开数据目录</button></div>
    </div>`);

  const doExport = async () => {
    try { await backupExport(); toast('备份已导出', 'success'); }
    catch (e) { toast('导出失败：' + e.message, 'error'); }
  };
  $('#dataExport').onclick = doExport;
  $('#dataExport2').onclick = doExport;
  $('#dataImport').onclick = async () => {
    try { await backupImport(); } catch (e) { toast('导入失败：' + e.message, 'error'); }
  };
  $('#cfgReset').onclick = async () => {
    if (!confirm('恢复默认配置？\n将清空辅助账号、音乐组件等配置参数（不影响任何账号数据）。')) return;
    try {
      const r = await api('/api/config/reset', { method: 'POST' });
      if (!r.ok) { toast(r.message || '重置失败', 'error'); return; }
      toast('配置已恢复默认', 'success');
      refreshHelperState();
      renderSettingsData(body);
    } catch (e) { toast('重置失败：' + e.message, 'error'); }
  };
  const slimBtn = $('#coverSlim');
  if (slimBtn) slimBtn.onclick = async () => {
    slimBtn.disabled = true;
    slimBtn.textContent = '处理中…';
    try {
      const r = await api('/api/music/covers/slim', { method: 'POST' });
      if (!r.ok) { toast(r.message || '压缩失败', 'error'); return; }
      if (!r.done) { toast(r.failed ? '压缩失败：网易云封面取不到' : '没有可压缩的封面', 'error'); return; }
      toast('已压缩 ' + r.done + ' 张封面，释放 ' + fmtBytes(r.savedBytes) + (r.failed ? '（' + r.failed + ' 张失败）' : ''), 'success');
      renderSettingsData(body);
    } catch (e) { toast('压缩失败：' + e.message, 'error'); }
    finally { slimBtn.disabled = false; slimBtn.textContent = '压缩音乐封面'; }
  };
  $('#dataWipe').onclick = () => openWipeDialog(s);
  $('#openDataBtn').onclick = async () => {
    try {
      const r = await api('/api/open-data-dir', { method: 'POST' });
      toast(r.ok ? '已打开：' + r.path : (r.message || '打开失败'), r.ok ? 'success' : 'error');
    } catch (e) { toast('打开失败：' + e.message, 'error'); }
  };
}

/* ---------- 卡片操作 ---------- */
$('#accounts').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.acc-card');
  const id = card.getAttribute('data-id');
  const act = btn.getAttribute('data-act');

  if (act === 'delete') {
    if (!confirm('确定删除该账号的本地登录态？')) return;
    try { await api('/api/accounts/' + encodeURIComponent(id) + '/delete', { method: 'POST' }); toast('已删除', 'success'); loadAccounts(); }
    catch (err) { toast('删除失败：' + err.message, 'error'); }
    return;
  }
  if (act === 'relogin') {
    const acc = allAccounts.find((x) => x.id === id);
    $('#username').value = (acc && acc.username) || '';
    $('#password').value = '';
    openLogin();
    toast('请输入密码重新登录（密码不会保存）', 'info');
    return;
  }
  if (act === 'history') { openHistory(id); return; }
  if (act === 'roles') { openRoles(id); return; }
  if (act === 'edit') { openEditProfile(id); return; }
  if (act === 'meta') { openMeta(id); return; }
  if (act === 'security') { openSecurity(id); return; }
  if (act === 'realname') { openRealname(id); return; }

  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '处理中…';
  try {
    if (act === 'refresh') {
      const r = await api('/api/accounts/' + encodeURIComponent(id) + '/refresh', { method: 'POST' });
      toast(r.sessionValid ? '信息已更新' : '登录态可能已失效，请重新登录', r.sessionValid ? 'success' : 'error');
      loadAccounts();
    } else if (act === 'sign-group' || act === 'sign-game') {
      const type = act === 'sign-group' ? 'group' : 'game';
      const r = await api('/api/accounts/' + encodeURIComponent(id) + '/sign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }),
      });
      toast(signMessage(r), r.ok ? 'success' : 'error');
      loadAccounts();
    }
  } catch (err) {
    toast('操作失败：' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
});

/* ---------- 全部刷新 ---------- */
async function refreshAll() {
  const btns = [$('#refreshAllBtn')];
  btns.forEach((b) => { if (b) { b.disabled = true; } });
  const label = $('#refreshAllBtn').textContent;
  $('#refreshAllBtn').textContent = '刷新中…';
  try {
    let expired = 0;
    for (const a of allAccounts) {
      try {
        const r = await api('/api/accounts/' + encodeURIComponent(a.id) + '/refresh', { method: 'POST' });
        if (r.sessionValid === false) expired++;
      } catch (e) { /* 跳过 */ }
    }
    toast(expired ? `已全部刷新 · ${expired} 个登录态失效` : '已全部刷新', expired ? 'warn' : 'success');
    loadAccounts();
  } catch (e) {
    toast('刷新失败：' + e.message, 'error');
  } finally {
    btns.forEach((b) => { if (b) { b.disabled = false; } });
    $('#refreshAllBtn').textContent = label;
  }
}
$('#refreshAllBtn').addEventListener('click', refreshAll);
$('#navAccounts').addEventListener('click', () => {
  switchPage('accounts');
  renderFolders();
  renderAccounts(allAccounts);
});
$('#navGroups').addEventListener('click', () => switchPage('groups'));
$('#navVault') && $('#navVault').addEventListener('click', () => switchPage('vault'));
$('#navLinks').addEventListener('click', openLinks);
$('#navSettings').addEventListener('click', () => openSettings());
$('#vaultImportBtn') && $('#vaultImportBtn').addEventListener('click', openImport);

/* ---------- 分组页事件 ---------- */
function gdNewFolderHere() {
  newFolder(gdFolder === 'all' || gdFolder === 'none' ? null : gdFolder);
}
$('#gdNewFolder') && $('#gdNewFolder').addEventListener('click', gdNewFolderHere);
$('#gdNewFolder2') && $('#gdNewFolder2').addEventListener('click', gdNewFolderHere);
$('#gdSearch') && $('#gdSearch').addEventListener('input', (e) => { gdQuery = e.target.value; gdRenderBody(); });
$('#gdView') && $('#gdView').querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  gdView = b.getAttribute('data-view');
  $('#gdView').querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === b));
  try { localStorage.setItem('4399.gdView', gdView); } catch (e) { }
  gdRenderBody();
}));
$('#gdMove') && $('#gdMove').addEventListener('click', gdMoveDialog);
$('#gdRemove') && $('#gdRemove').addEventListener('click', () => gdMoveAccounts([...gdSelected], null));
$('#gdDelete') && $('#gdDelete').addEventListener('click', async () => {
  const ids = [...gdSelected];
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 个账号的本地登录态？\n（不会影响 4399 账号本身）`)) return;
  try {
    const r = await api('/api/accounts/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', ids }),
    });
    if (!r.ok) { toast(r.message || '删除失败', 'error'); return; }
    toast(`已删除 ${r.count} 个账号`, 'success');
    gdSelected.clear();
    loadAccounts();
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
});
$('#gdSelectAll') && $('#gdSelectAll').addEventListener('click', gdToggleSelectAll);
window.addEventListener('resize', () => renderNavIndicator());

$('#searchBox').addEventListener('input', () => renderAccounts(allAccounts));

/* ---------- 筛选 / 排序 / 批量选择 事件 ---------- */
/* ---------- 筛选 / 排序：自定义下拉（避免原生 select 的白边弹层） ---------- */
const FLT_SORT_OPTS = [
  { value: 'default', label: '默认' },
  { value: 'login', label: '上次登录 近到远' },
  { value: 'name', label: '昵称 A 到 Z' },
];
/* 分组筛选：全部分组 / 未分组 / 每个分组（选中父分组时子分组一并命中，与「分组」页一致） */
function fltGroupOpts() {
  return [{ value: 'all', label: '全部分组' }, { value: 'none', label: '未分组' }]
    .concat(folders.map((f) => ({ value: f.id, label: folderPath(f.id) })));
}
/* IP 属地筛选：只列出当前账号里真实出现过的属地，避免一堆空选项 */
function fltIpOpts() {
  const set = [...new Set(allAccounts.map((a) => String(a.ipLocation || '').trim()).filter(Boolean))].sort();
  return [{ value: 'all', label: '全部属地' }].concat(set.map((v) => ({ value: v, label: v })));
}
/* 分组 / IP 属地 / 排序三个下拉：选项会随数据变化，需要就地重建 */
function renderFilterSelects() {
  const gBox = $('#fltGroupBox');
  if (!gBox) return;
  if (!gBox.querySelector('.csel')) {              // 首次：直接写入静态占位
    gBox.innerHTML = customSelect('fltGroup', fltGroupOpts(), filters.group, '全部分组');
    $('#fltIpBox').innerHTML = customSelect('fltIp', fltIpOpts(), filters.ip, '全部属地');
    $('#fltSortBox').innerHTML = customSelect('fltSort', FLT_SORT_OPTS, filters.sort, '默认');
    initCustomSelects(gBox); initCustomSelects($('#fltIpBox')); initCustomSelects($('#fltSortBox'));
    return;
  }
  // 选中的分组被删了 / 属地已不存在 → 回落到「全部」
  if (filters.group !== 'all' && filters.group !== 'none' && !folders.some((f) => f.id === filters.group)) filters.group = 'all';
  if (filters.ip !== 'all' && !fltIpOpts().some((o) => o.value === filters.ip)) filters.ip = 'all';
  rebuildCustomSelect('fltGroup', fltGroupOpts(), filters.group, '全部分组');
  rebuildCustomSelect('fltIp', fltIpOpts(), filters.ip, '全部属地');
  rebuildCustomSelect('fltSort', FLT_SORT_OPTS, filters.sort, '默认');
}
renderFilterSelects();

// 事件委托：下拉会被就地重建，直接绑在 input 上会随重建失效
$('.filter-bar').addEventListener('change', (e) => {
  const id = e.target && e.target.id;
  if (id === 'fltGroup') filters.group = e.target.value;
  else if (id === 'fltIp') filters.ip = e.target.value;
  else if (id === 'fltSort') filters.sort = e.target.value;
  else return;
  renderAccounts(allAccounts);
});
$('#fltReset').addEventListener('click', () => {
  filters.group = 'all'; filters.ip = 'all'; filters.sort = 'default';
  renderFilterSelects();
  renderAccounts(allAccounts);
});
$('#selectAll').addEventListener('change', (e) => {
  const ids = lastFiltered.map((a) => a.id);
  if (e.target.checked) ids.forEach((id) => selectedIds.add(id));
  else ids.forEach((id) => selectedIds.delete(id));
  renderAccounts(allAccounts);
});
$('#accounts').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-check]');
  if (!cb) return;
  const id = cb.getAttribute('data-check');
  if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
  const card = cb.closest('.acc-card');
  if (card) card.classList.toggle('selected', cb.checked);
  updateBulkBar();
});
$('#bulkMove').addEventListener('click', bulkMoveSelected);
$('#bulkRefresh').addEventListener('click', bulkRefreshSelected);
$('#bulkDelete').addEventListener('click', bulkDeleteSelected);

/* ---------- 外观 ---------- */
$('#themeBtn').addEventListener('click', openTheme);

/* ---------- 注册账号 ---------- */
let regToken = null, regCaptchaId = null;

function openRegister() {
  if ($('#modal') && !$('#modal').hidden) closeModal();
  if ($('#loginModal') && !$('#loginModal').hidden) closeLogin();
  $('#regModal').hidden = false;
  setTimeout(() => $('#regUser').focus(), 30);
}
function closeRegister() { $('#regModal').hidden = true; resetRegister(); }
function resetRegister() {
  regToken = null; regCaptchaId = null;
  $('#regCaptcha').value = '';
  $('#regCaptchaRow').hidden = true;
  $('#regCancelBtn').hidden = true;
  $('#regHint').hidden = true;
  resetPwEyes();
}
function regHint(html) {
  const el = $('#regHint');
  el.innerHTML = html || '';
  el.hidden = !html;
}

$('#navRegister').addEventListener('click', openRegister);
$('#regClose').addEventListener('click', closeRegister);

$('#regCaptchaImg').addEventListener('click', async () => {
  if (!regToken) return;
  try {
    const r = await api('/api/register/captcha?token=' + encodeURIComponent(regToken));
    if (r.captchaImage) $('#regCaptchaImg').src = r.captchaImage;
  } catch (e) { }
});

$('#regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    username: $('#regUser').value.trim(),
    password: $('#regPwd').value,
    realname: $('#regName').value.trim(),
    idcard: $('#regId').value.trim(),
    qq: $('#regQq').value.trim(),
    autoCaptcha: true,
  };
  if (regToken) {
    body.sessionToken = regToken;
    body.captcha = $('#regCaptcha').value.trim();
    body.captchaId = regCaptchaId;
    if (!body.captcha) { toast('请输入验证码', 'error'); return; }
  }
  const btn = $('#regBtn');
  btn.disabled = true; btn.textContent = '注册中…';
  try {
    const r = await api('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) {
      toast('注册成功！可用该账号登录', 'success');
      $('#regPwd').value = ''; $('#regId').value = '';
      const uname = body.username;
      closeRegister();
      $('#username').value = uname; $('#password').value = '';
      pickFolder({
        title: '注册成功 · 选择分组',
        message: `账号「${uname}」注册成功。先选一个分组，稍后用这个账号登录添加时会自动归入；也可以选「暂不分组」。`,
        confirmText: '记住分组并去登录',
        onPick: async (fid) => {
          setPendingFolder(uname, fid);
          openLogin();
        },
      });
      return;
    }
    if (r.needCaptcha) {
      regToken = r.sessionToken; regCaptchaId = r.captchaId;
      $('#regCaptchaRow').hidden = false;
      $('#regCancelBtn').hidden = false;
      if (r.captchaImage) $('#regCaptchaImg').src = r.captchaImage;
      const tried = (Array.isArray(r.autoLog) ? r.autoLog : []).filter((x) => x && x.text).map((x) => x.text);
      regHint(r.autoCaptchaTried
        ? (`${icon('alert')} 4399 要求验证码（可能已触发风控）` + (tried.length ? `；已自动识别 ${tried.length} 次：${esc(tried.join(' / '))}，均未通过，请手动输入` : '；自动识别未通过，请手动输入'))
        : `${icon('alert')} 4399 要求验证码（可能已触发风控），请输入图中验证码`);
      setTimeout(() => $('#regCaptcha').focus(), 30);
      toast('4399 要求验证码', 'info');
      return;
    }
    toast(r.error || r.message || '注册失败', 'error');
  } catch (err) {
    toast('注册失败：' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '注 册';
  }
});
$('#regCancelBtn').addEventListener('click', () => { resetRegister(); toast('已取消本次验证码，可修改信息后重新提交', 'info'); });

/* ---------- 实名信息查询（独家） ---------- */
let rnAccountId = null;
let rnCooling = false;   // 24 小时内已查过 → 按钮不可用

const RN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
function rnCard(rn, cooling) {
  const nextAt = rn.at ? rn.at + RN_COOLDOWN_MS : 0;
  const bound = rn.helperNick
    ? `${esc(rn.helperNick)}${rn.helperName && rn.helperName !== rn.helperNick ? `（${esc(rn.helperName)}）` : ''}`
    : (rn.helperName ? esc(rn.helperName) : (rn.kuid ? `UID ${esc(rn.kuid)}` : '—'));
  return `<div class="rn-card">
    <div class="rn-row"><span class="rn-k">姓名</span><span class="rn-v">${esc(rn.name || '—')}</span></div>
    <div class="rn-row"><span class="rn-k">身份证</span><span class="rn-v mono">${esc(rn.idCard || '—')}</span></div>
    <div class="rn-row"><span class="rn-k">手机</span><span class="rn-v mono">${esc(rn.phone || '—')}</span></div>
    <div class="rn-row"><span class="rn-k">验证账号</span><span class="rn-v">${bound}</span></div>
    <div class="rn-time">获取于 ${fmtTime(rn.at)}${cooling ? `　·　本地缓存有效，${fmtTime(nextAt)} 后可再查` : ''}</div>
    <div class="rn-note">4399 只返回<strong>脱敏数据</strong>（姓名 / 证件号 / 手机都带 <code>*</code>），这是接口本身的限制，不是查询失败。${rn.released ? '查询后已<strong>自动解除占用</strong>，该账号可继续绑定其它辅助账号。' : ''}</div>
  </div>`;
}
async function refreshHelperState() {
  const el = $('#rnHelperState');
  if (!el) return;
  try {
    const cfg = await api('/api/config');
    const h = cfg.helper || {};
    if (cfg.helperReady) {
      el.innerHTML = h.mode === 'account'
        ? `${icon('checkCircle')} 复用已登录账号 <b>${esc(h.accountName || h.accountId || '')}</b> 的登录态（无需密码）`
        : `${icon('checkCircle')} 手动账号 <b>${esc(h.username)}</b>${h.hasPassword ? '（密码已存本机）' : '（缺少密码）'}`;
      $('#rnQueryBtn').disabled = rnCooling;
    } else {
      el.innerHTML = `${icon('alert')} ${esc(cfg.helperError || '尚未配置辅助账号')}`;
      $('#rnQueryBtn').disabled = true;
    }
  } catch (e) { el.textContent = '无法读取设置：' + e.message; }
}
async function openRealname(id) {
  rnAccountId = id;
  const acc = allAccounts.find((a) => a.id === id);
  const nm = (acc && (acc.nickname || acc.username)) || id;
  const rn = acc && acc.realName;
  rnCooling = !!(rn && rn.at && Date.now() < rn.at + RN_COOLDOWN_MS);
  $('#rnResult').innerHTML = rn
    ? rnCard(rn, rnCooling)
    : `<div class="rn-empty">账号：<b>${esc(nm)}</b>　点下方按钮开始查询</div>`;
  const qb = $('#rnQueryBtn');
  qb.textContent = rnCooling ? '今日已查询' : '查询实名信息';
  qb.disabled = rnCooling;
  $('#rnModal').hidden = false;
  refreshHelperState();
}
function closeRealname() { $('#rnModal').hidden = true; rnAccountId = null; rnCooling = false; }
$('#rnClose').addEventListener('click', closeRealname);
$('#rnGotoSettings').addEventListener('click', () => { closeRealname(); openSettings('helper'); });

async function rnQuery() {
  if (!rnAccountId || rnCooling) return;
  const id = rnAccountId;
  const btn = $('#rnQueryBtn');
  btn.disabled = true; btn.textContent = '查询中…';
  $('#rnResult').innerHTML = `<div class="rn-loading">正在读取 4399 监护平台的实名绑定…
      <div class="rp-track" style="margin-top:10px"><div class="rp-fill" id="rnFill" style="width:0%"></div></div>
      <div class="rp-label" id="rnStep" style="margin-top:8px">准备中…</div>
      <div class="form-actions"><button class="btn ghost tiny" id="rnCancel" hidden>取消查询</button></div>
    </div>`;

  const j = await runJob(
    () => api('/api/accounts/' + encodeURIComponent(id) + '/realname', { method: 'POST' }),
    {
      cancelBtn: $('#rnCancel'),
      cancelText: '取消查询',
      onProgress: (job) => {
        const fill = $('#rnFill'), lab = $('#rnStep');
        if (fill) fill.style.width = Math.round((job.done || 0) / (job.total || 6) * 100) + '%';
        if (lab) {
          const cur = (job.items || [])[Math.max(0, (job.done || 1) - 1)];
          lab.textContent = (cur && (cur.message || cur.text)) || '处理中…';
        }
      },
    });

  const r = j || {};
  const payload = (r.state === 'done' && r.result) ? r.result : (r.realName ? r : null);
  if (payload && payload.realName) {
    rnCooling = true;
    $('#rnResult').innerHTML = rnCard(payload.realName, true);
    toast(payload.cached ? '读取本地缓存（24 小时内已查过）' : '实名信息已获取', payload.cached ? 'info' : 'success');
    loadAccounts();
  } else if (r.state === 'cancelled') {
    $('#rnResult').innerHTML = '<div class="rn-error">已取消本次查询</div>';
    toast('已取消查询', 'info');
  } else {
    const msg = r.errorTimeout ? '查询超时（已自动重试仍失败，请稍后再试）' : (r.error || r.message || '未获取到实名信息');
    $('#rnResult').innerHTML = `<div class="rn-error">${esc(msg)}</div>`;
    toast(msg, 'error');
  }
  btn.disabled = rnCooling;
  btn.textContent = rnCooling ? '今日已查询' : '查询实名信息';
  if (!rnCooling) refreshHelperState();
}
$('#rnQueryBtn').addEventListener('click', () => rnQuery());

/* ---------- 设置（弹窗：外观 / 音乐组件 / 辅助账号 / 调试） ---------- */
const SETTINGS_TABS = [
  { id: 'appearance', name: '外观' },
  { id: 'music', name: '音乐组件' },
  { id: 'helper', name: '辅助账号' },
  { id: 'data', name: '数据' },
  { id: 'debug', name: '调试' },
  { id: 'about', name: '关于' },
];
let settingsTab = 'appearance';

function openSettings(tab) {
  if (tab) settingsTab = tab;
  openModal('设置', '<div class="set-tabs" id="setTabs"></div><div class="set-body" id="setBody"></div>', 'wide');
  renderSettings();
}
function renderSettings() {
  const tabs = $('#setTabs');
  if (!tabs) return;
  tabs.innerHTML = SETTINGS_TABS.map((t) =>
    `<button class="set-tab${settingsTab === t.id ? ' active' : ''}" data-tab="${t.id}">${esc(t.name)}</button>`).join('');
  tabs.onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    settingsTab = b.getAttribute('data-tab');
    smoothModal(renderSettings);   // 切换标签时高度平滑过渡
  };
  const body = $('#setBody');
  if (settingsTab === 'appearance') renderSettingsAppearance(body);
  else if (settingsTab === 'music') renderSettingsMusic(body);
  else if (settingsTab === 'helper') renderSettingsHelper(body);
  else if (settingsTab === 'data') renderSettingsData(body);
  else if (settingsTab === 'about') renderSettingsAbout(body);
  else renderSettingsDebug(body);
  if (body) {
    body.classList.remove('swap-in');
    void body.offsetWidth;
    body.classList.add('swap-in');
  }
}
async function renderSettingsAbout(body) {
  body.innerHTML = '<div class="about-wrap"><div class="muted">加载中…</div></div>';
  let info = null;
  try { info = await api('/api/about'); } catch (e) { }
  if (settingsTab !== 'about') return;   // 已经切走了，别覆盖
  if (!info) { body.innerHTML = '<div class="about-wrap"><div class="muted">无法读取「关于」信息</div></div>'; return; }
  const rows = [
    ['名称', info.name],
    ['版本', info.version],
    ['运行地址', info.address],
    ['作者', info.author + '（当前计算机用户）'],
    ['运行环境', info.runtime],
    ['数据目录', info.dataDir],
    ['依赖', info.deps],
  ];
  swapSettingsBody(body, `
    <div class="about-wrap">
      <div class="about-hero">
        <span class="about-logo">4399</span>
        <div class="about-hero-txt">
          <strong>${esc(info.name)}</strong>
          <span>${esc(info.version)} · 仅监听本机 ${esc(info.host)}</span>
        </div>
      </div>
      <div class="about-rows">
        ${rows.map(([k, v]) => `<div class="about-row"><span class="about-k">${esc(k)}</span><span class="about-v">${esc(v)}</span></div>`).join('')}
      </div>
      <div class="about-rows" style="margin-top:12px">
        <div class="about-row"><span class="about-k">宣传片</span><span class="about-v" id="aboutPromoCell"><span class="muted">读取中…</span></span></div>
      </div>
      <p class="about-note">仅用于管理<strong>你自己的</strong> 4399 账号。登录态保存在本地，不会上传到任何服务器。</p>
      <p class="about-note">第三方本地工具 · 与 4399 官方无关 · 请遵守平台服务条款。</p>
    </div>`);
  loadPromoCell();
}
// 「设置 · 关于」里的宣传片入口：读取 data/promo.* 的状态
async function loadPromoCell() {
  let j = null;
  try { j = await api('/api/promo'); } catch (e) { }
  if (settingsTab !== 'about') return;
  const cell = $('#aboutPromoCell');
  if (!cell) return;
  if (!j || !j.exists) {
    cell.innerHTML = '<span class="muted">data/ 下还没有宣传片</span> ' +
      '<a class="btn ghost tiny" href="/promo-studio.html" target="_blank" rel="noopener">去录制</a>';
    return;
  }
  cell.innerHTML =
    '<button class="btn ghost tiny" id="aboutPromoPlay">播放</button> ' +
    '<a class="btn ghost tiny" href="/promo-studio.html" target="_blank" rel="noopener">重新录制</a> ' +
    '<span class="muted" style="margin-left:6px">' + esc(j.name) + ' · ' + (j.bytes / 1048576).toFixed(1) + ' MB</span>';
  const play = $('#aboutPromoPlay');
  if (play) play.addEventListener('click', openPromoPlayer);
}
// 播放宣传片（关闭弹窗即停止，不会后台继续放）
function openPromoPlayer() {
  const body = openModal('宣传片', `
    <div class="promo-wrap">
      <video id="promoVideo" src="/media/promo" controls autoplay loop playsinline></video>
      <p class="promo-tip">由浏览器录制生成，暂存在 <code>data/</code> 下。仅本机可访问。</p>
    </div>`, 'wide');
  const v = $('#promoVideo');
  if (v) v.addEventListener('error', () => {
    if (body) body.innerHTML = '<div class="promo-wrap"><p class="muted">视频读取失败，可能已被删除。请重新录制。</p></div>';
  });
}
function getSplashMode() {
  try { return (JSON.parse(localStorage.getItem('4399.splash') || '{}').mode) || 'session'; } catch (e) { return 'session'; }
}
function setSplashMode(m) {
  try { localStorage.setItem('4399.splash', JSON.stringify({ mode: m })); } catch (e) { }
}
// 预览启动动画（不改变当前会话已播放的标记）
function splashSet(pct, status) {
  const el = $('#splash');
  if (!el) return;
  const fill = el.querySelector('.sp-fill');
  const p = el.querySelector('.sp-pct');
  const st = el.querySelector('.sp-status');
  if (fill) fill.style.width = pct + '%';
  if (p) p.textContent = pct + '%';
  if (st && status) st.textContent = status;
}
function playSplashPreview() {
  const el = $('#splash');
  if (!el) return;
  document.documentElement.classList.remove('no-splash');
  el.classList.remove('done');
  const fill = el.querySelector('.sp-fill');
  if (fill) { fill.style.transition = 'none'; fill.style.width = '0%'; void fill.offsetWidth; fill.style.transition = ''; }
  splashSet(0, '正在初始化…');
  const steps = [[26, '正在加载配置…', 220], [62, '正在读取账号数据…', 560], [88, '正在渲染界面…', 940], [100, '就绪', 1280]];
  steps.forEach((s) => setTimeout(() => splashSet(s[0], s[1]), s[2]));
  setTimeout(() => el.classList.add('done'), 2000);
}
function renderSettingsAppearance(body) {
  const sp = getSplashMode();
  body.innerHTML = `
    <div class="theme-sec"><div class="theme-k">主题</div><div class="theme-grid" id="setThemes">${themeCardsHtml()}</div></div>
    <div class="theme-sec"><div class="theme-k">启动动画</div>
      <div class="seg-group" id="setSplash">
        <button class="seg${sp === 'session' ? ' active' : ''}" data-splash="session">每个会话一次</button>
        <button class="seg${sp === 'always' ? ' active' : ''}" data-splash="always">每次打开</button>
        <button class="seg${sp === 'off' ? ' active' : ''}" data-splash="off">关闭</button>
      </div>
      <button class="btn ghost tiny" id="splashPreview">${icon('play')} 预览</button>
    </div>
    <p class="hint">三套主题各自一套完整配色（仅深色），设置保存在本机浏览器（localStorage）。</p>`;
  bindThemePicker($('#setThemes'));
  $('#setSplash').onclick = (e) => {
    const b = e.target.closest('[data-splash]'); if (!b) return;
    setSplashMode(b.getAttribute('data-splash'));
    $('#setSplash').querySelectorAll('[data-splash]').forEach((x) => x.classList.toggle('active', x === b));
    toast('启动动画：' + b.textContent, 'success');
  };
  $('#splashPreview').onclick = playSplashPreview;
}
function renderSettingsMusic(body) {
  let auto = false;
  try { auto = localStorage.getItem('4399.musicAuto') === '1'; } catch (e) { }
  body.innerHTML = `
    <div class="theme-sec">
      <label class="flt-check"><input type="checkbox" id="setMusicAuto" ${auto ? 'checked' : ''}> 打开页面自动播放</label>
      <p class="hint tiny">浏览器可能拦截自动播放，此时点一下播放器上的 ${icon('play')} 即可。</p>
    </div>
    <div class="theme-sec">
      <div class="theme-k">默认歌单</div>
      <p class="hint tiny">共 ${MW_SONGS.length} 首，默认第一首为「can't say(不说)」，其余随机；可在左下角悬浮播放器里粘贴网易云歌曲 / 歌单链接。</p>
    </div>`;
  $('#setMusicAuto').onchange = (e) => {
    try { localStorage.setItem('4399.musicAuto', e.target.checked ? '1' : '0'); } catch (e2) { }
    toast(e.target.checked ? '已开启自动播放' : '已关闭自动播放', 'success');
  };
}
async function renderSettingsHelper(body) {
  body.innerHTML = '<div class="muted">加载中…</div>';
  let cfg = {};
  try { cfg = await api('/api/config'); } catch (e) { }
  if (settingsTab !== 'helper') return;   // 已经切走了，别覆盖
  const h = cfg.helper || {};
  const mode = h.mode || 'account';
  const opts = allAccounts.map((a) => {
    const un = a.username || a.id;
    const nn = a.nickname && a.nickname !== un ? `（${a.nickname}）` : '';
    return { value: a.id, label: `${un}${nn}` };
  });
  const showAccount = mode !== 'manual';
  swapSettingsBody(body, `
    <div class="set-sec">
      <div class="set-k">辅助账号用于「实名信息查询」：4399 会向它发一条验证消息，由它确认归属。</div>
      <label class="set-radio"><input type="radio" name="helperMode" value="account" ${mode === 'account' ? 'checked' : ''}> 复用已登录账号的登录态（推荐，不需要密码）</label>
      <div class="set-indent" id="helperAccountBox" style="${showAccount ? '' : 'display:none'}">
        ${customSelect('helperAccount', opts, h.accountId || '', '（还没有已登录账号）')}
      </div>
      <label class="set-radio"><input type="radio" name="helperMode" value="manual" ${mode === 'manual' ? 'checked' : ''}> 手动填写账号 + 密码</label>
      <div class="set-indent" id="helperManualBox" style="${showAccount ? 'display:none' : ''}">
        <div class="row"><label for="helperUser">账号</label><input id="helperUser" type="text" value="${esc(h.username || '')}" placeholder="4399 用户名" autocomplete="off"></div>
        <div class="row"><label for="helperPwd">密码</label><input id="helperPwd" type="password" placeholder="${h.hasPassword ? '已保存（留空则不修改）' : '仅保存在本机'}" autocomplete="off"></div>
      </div>
      <div class="form-actions keep-left">
        <button class="btn primary" id="helperSave">保存</button>
        <span class="hint tiny" id="helperState">${cfg.helperReady ? icon('checkCircle') + ' 已就绪' : icon('alert') + ' ' + esc(cfg.helperError || '尚未配置')}</span>
      </div>
    </div>`);
  initCustomSelects(body);
  const sync = () => {
    const m = body.querySelector('input[name="helperMode"]:checked').value;
    $('#helperAccountBox').style.display = m === 'account' ? '' : 'none';
    $('#helperManualBox').style.display = m === 'manual' ? '' : 'none';
  };
  body.querySelectorAll('input[name="helperMode"]').forEach((r) => r.addEventListener('change', sync));
  sync();
  $('#helperSave').onclick = async () => {
    const m = body.querySelector('input[name="helperMode"]:checked').value;
    const payload = m === 'account'
      ? { mode: 'account', accountId: $('#helperAccount').value }
      : { mode: 'manual', username: $('#helperUser').value.trim(), password: $('#helperPwd').value };
    if (m === 'account' && !payload.accountId) { toast('请选择一个已登录账号', 'error'); return; }
    if (m === 'manual' && !payload.username) { toast('请输入辅助账号用户名', 'error'); return; }
    try {
      const r = await api('/api/config/helper', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      $('#helperPwd').value = '';
      $('#helperState').innerHTML = r.helperReady ? icon('checkCircle') + ' 已就绪' : icon('alert') + ' ' + esc(r.helperError || '配置不完整');
      toast(r.helperReady ? '辅助账号已保存' : '已保存，但还不可用', r.helperReady ? 'success' : 'info');
      refreshHelperState();
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  };
}
async function renderSettingsDebug(body) {
  body.innerHTML = '<div class="muted">加载中…</div>';
  let st = {};
  try { st = await api('/api/status'); } catch (e) { }
  if (settingsTab !== 'debug') return;   // 已经切走了，别覆盖
  const o = st.ocr || {};
  const rk = st.risk || {};
  const evs = (rk.events || []).slice(0, 12);
  swapSettingsBody(body, `
    <div class="set-sec">
      <div class="set-title">验证码自动识别（OCR）</div>
      <div class="dbg-row"><span>状态</span><b>${o.ready ? icon('checkCircle') + ' 已就绪' : icon('alert') + ' 未就绪'}</b></div>
      ${o.dll ? `<div class="dbg-row"><span>DLL</span><code class="mono">${esc(o.dll)}</code></div>` : ''}
      ${o.error ? `<div class="dbg-row"><span>错误</span><span class="err">${esc(o.error)}</span></div>` : ''}
      <div class="dbg-test">
        <button class="btn ghost tiny" id="ocrSampleBtn" data-tip="从 4399 验证码接口取一张真实验证码并直接识别（不会消耗登录尝试）">拉取验证码并识别</button>
        <span class="hint tiny" id="ocrTestOut"></span>
      </div>
      <div class="dbg-test" id="ocrPreviewWrap" hidden>
        <img id="ocrPreview" alt="验证码" style="height:42px;border-radius:7px;border:1px solid var(--border)">
      </div>
    </div>
    <div class="set-sec">
      <div class="set-title">风控 / 限流</div>
      <div class="dbg-row"><span>要求验证码次数</span><b>${rk.captchaCount || 0}</b></div>
      <div class="dbg-row"><span>被限流次数</span><b>${rk.rateLimitCount || 0}</b></div>
      <div class="dbg-row"><span>被静默拦截次数</span><b>${rk.blockedCount || 0}</b></div>
      <div class="dbg-row"><span>最近要求验证码</span><b>${rk.lastCaptchaAt ? fmtTime(rk.lastCaptchaAt) : '—'}</b></div>
      <div class="dbg-row"><span>最近被限流</span><b>${rk.lastRateLimitAt ? fmtTime(rk.lastRateLimitAt) : '—'}</b></div>
      <div class="dbg-row"><span>最近静默拦截</span><b>${rk.lastBlockedAt ? fmtTime(rk.lastBlockedAt) : '—'}</b></div>
      <div class="form-actions keep-left">
        <button class="btn ghost tiny" id="riskProbeBtn" data-tip="会用随机用户名真实请求一次 4399 登录接口，判断当前 IP 是被要求验证码、被限流，还是被静默拒绝登录">主动探测风控</button>
        <span class="hint tiny" id="riskProbeOut"></span>
      </div>
      <div class="dbg-events">${evs.length ? evs.map((e) => `<div class="dbg-ev"><span class="dbg-ev-t">${fmtTime(e.at)}</span><span class="dbg-ev-k k-${esc(e.kind)}">${esc(e.where)}</span><span class="dbg-ev-d">${esc(e.detail || '')}</span></div>`).join('') : '<div class="muted">暂无记录</div>'}</div>
    </div>
    <div class="set-sec">
      <div class="set-title">数据</div>
      <div class="dbg-row"><span>数据目录</span><code class="mono">data/</code></div>
      <div class="form-actions"><button class="btn ghost tiny" id="openDataBtn">打开数据目录</button></div>
    </div>`);
  $('#ocrSampleBtn').onclick = async () => {
    const out = $('#ocrTestOut');
    out.textContent = '正在向 4399 拉取验证码…';
    try {
      const r = await api('/api/ocr/sample', { method: 'POST' });
      if (r.image) { $('#ocrPreview').src = r.image; $('#ocrPreviewWrap').hidden = false; }
      out.textContent = r.ok
        ? `识别结果：${r.text}（${r.ms} ms）`
        : (r.image ? '已取到验证码，但这次没认出来（再点一次换一张）' : ('失败：' + (r.message || '识别不出')));
      toast(r.ok ? '识别成功：' + r.text : (r.image ? '没认出来，再试一次' : (r.message || '识别失败')), r.ok ? 'success' : 'error');
    } catch (e) { out.textContent = '失败：' + e.message; }
  };
  $('#riskProbeBtn').onclick = async () => {
    const out = $('#riskProbeOut');
    out.textContent = '探测中…';
    try {
      const r = await api('/api/risk/probe', { method: 'POST' });
      out.textContent = r.message || (r.ok ? '' : '探测失败');
      toast(r.message || '探测完成', r.verdict === 'clear' ? 'success' : 'info');
      renderSettingsDebug($('#setBody'));
    } catch (e) { out.textContent = '失败：' + e.message; }
  };
  $('#openDataBtn').onclick = async () => {
    try {
      const r = await api('/api/open-data-dir', { method: 'POST' });
      toast(r.ok ? '已打开：' + r.path : (r.message || '打开失败'), r.ok ? 'success' : 'error');
    } catch (e) { toast('打开失败：' + e.message, 'error'); }
  };
}

/* ---------- 本地账号库（独立页面 · 表格 + 批量操作，仅存本机） ---------- */
let vaultItems = [];
let impPairs = [];
let vaultQuery = '';
let vaultReveal = false;            // 是否全量明文显示密码
let vaultSelected = new Set();      // 选中的条目 id
let vaultSort = { key: 'createdAt', dir: 'desc' };
let vaultLoginAbort = false;
let vaultLoginRunning = false;

try {
  const s = JSON.parse(localStorage.getItem('4399.vaultSort') || 'null');
  if (s && s.key) vaultSort = { key: String(s.key), dir: s.dir === 'asc' ? 'asc' : 'desc' };
} catch (e) { }

function vaultSaveSort() {
  try { localStorage.setItem('4399.vaultSort', JSON.stringify(vaultSort)); } catch (e) { }
}

async function loadVault() {
  try {
    const r = await api('/api/vault');
    vaultItems = r.vault || [];
  } catch (e) { vaultItems = []; }
  for (const id of [...vaultSelected]) if (!vaultItems.some((v) => v.id === id)) vaultSelected.delete(id);
  renderVault();
}

function vaultById(id) { return vaultItems.find((v) => v.id === id); }
function vaultSelectedItems() { return vaultItems.filter((v) => vaultSelected.has(v.id)); }

// 过滤 + 排序后的列表
function vaultVisible() {
  const q = vaultQuery.trim().toLowerCase();
  let list = vaultItems.slice();
  if (q) list = list.filter((v) => String(v.username || '').toLowerCase().includes(q) || String(v.note || '').toLowerCase().includes(q));
  const { key, dir } = vaultSort;
  const mul = dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    let x, y;
    if (key === 'createdAt') { x = Number(a.createdAt) || 0; y = Number(b.createdAt) || 0; }
    else if (key === 'password') { x = String(a.password || ''); y = String(b.password || ''); }
    else if (key === 'note') { x = String(a.note || ''); y = String(b.note || ''); }
    else { x = String(a.username || ''); y = String(b.username || ''); }
    if (x < y) return -1 * mul;
    if (x > y) return 1 * mul;
    const ax = String(a.username || ''), bx = String(b.username || '');
    return ax < bx ? -1 : (ax > bx ? 1 : 0);
  });
  return list;
}

function renderVault() {
  const body = $('#vaultBody');
  if (!body) return;
  const cnt = $('#vaultCount'); if (cnt) cnt.textContent = vaultItems.length;
  const emp = $('#vaultEmpty'); if (emp) emp.hidden = vaultItems.length > 0;
  const list = vaultVisible();
  body.innerHTML = list.map((v) => {
    const sel = vaultSelected.has(v.id);
    return `<tr class="vt-row${sel ? ' sel' : ''}" data-id="${esc(v.id)}">
      <td class="vt-c-chk"><label class="vt-chk"><input type="checkbox" data-vchk${sel ? ' checked' : ''} aria-label="选择"></label></td>
      <td class="vt-c-user"><span class="mono">${esc(v.username)}</span></td>
      <td class="vt-c-pass"><span class="vt-pass mono${vaultReveal ? ' on' : ''}" data-tip="鼠标悬停在密码上即可查看明文"><span class="vt-mask">••••••••</span><span class="vt-real">${esc(v.password)}</span></span></td>
      <td class="vt-c-note"><input class="vt-note-input" data-note value="${esc(v.note || '')}" placeholder="点此填写备注" maxlength="60" autocomplete="off"></td>
      <td class="vt-c-time">${v.createdAt ? esc(fmtTime(v.createdAt)) : '—'}</td>
      <td class="vt-c-act">
        <button class="btn ghost tiny" data-act="login" data-tip="填入登录框，手动完成登录">登录</button>
        <button class="btn ghost tiny" data-act="copy" data-tip="复制「账号 + 密码」">复制</button>
        <button class="btn ghost tiny danger" data-act="del" data-tip="从本地账号库删除">删除</button>
      </td>
    </tr>`;
  }).join('');

  const tbl = $('#vaultTable');
  if (tbl) tbl.querySelectorAll('th[data-sort]').forEach((th) => {
    const on = th.getAttribute('data-sort') === vaultSort.key;
    th.classList.toggle('on', on);
    th.classList.toggle('desc', on && vaultSort.dir === 'desc');
  });

  const all = $('#vaultSelectAll');
  if (all) {
    const ids = list.map((v) => v.id);
    const selN = ids.filter((id) => vaultSelected.has(id)).length;
    all.checked = ids.length > 0 && selN === ids.length;
    all.indeterminate = selN > 0 && selN < ids.length;
    all.disabled = ids.length === 0;
  }

  const rb = $('#vaultRevealBtn');
  if (rb) rb.innerHTML = icon(vaultReveal ? 'eyeOff' : 'eye') + (vaultReveal ? ' 隐藏密码' : ' 显示密码');

  updateVaultBulk();
}

function updateVaultBulk() {
  const bar = $('#vaultBulkBar');
  const sc = $('#vaultSelCount'); if (sc) sc.textContent = vaultSelected.size;
  if (!bar) return;
  // 操作栏常驻占位（不再 hidden），未选中时置灰，避免点「全选」时表格跳动
  const idle = vaultSelected.size === 0;
  bar.classList.toggle('idle', idle);
  const hint = $('#vaultBulkHint'); if (hint) hint.hidden = !idle;
  bar.querySelectorAll('.bulk-acts .btn').forEach((b) => { b.disabled = idle; });
}

// 导出为 txt（账号<TAB>密码[<TAB>备注]）
function vaultExport(items, filename) {
  if (!items.length) { toast('没有可导出的条目', 'error'); return; }
  const text = items.map((v) => v.username + '\t' + v.password + (v.note ? '\t' + v.note : '')).join('\r\n');
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('已导出 ' + items.length + ' 条', 'success');
}

/* ---------- 账号库页面事件（有表格才绑定） ---------- */
if ($('#vaultTable')) {
  // 列标题点击排序
  $('#vaultTable').querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (vaultSort.key === key) vaultSort.dir = vaultSort.dir === 'asc' ? 'desc' : 'asc';
      else vaultSort = { key, dir: key === 'createdAt' ? 'desc' : 'asc' };
      vaultSaveSort();
      renderVault();
    });
  });

  $('#vaultSelectAll').addEventListener('change', (e) => {
    const list = vaultVisible();
    if (e.target.checked) list.forEach((v) => vaultSelected.add(v.id));
    else list.forEach((v) => vaultSelected.delete(v.id));
    renderVault();
  });

  // 勾选 / 取消勾选单行
  $('#vaultBody').addEventListener('change', (e) => {
    if (!e.target.matches('input[data-vchk]')) return;
    const tr = e.target.closest('tr.vt-row');
    if (!tr) return;
    const id = tr.getAttribute('data-id');
    if (e.target.checked) vaultSelected.add(id); else vaultSelected.delete(id);
    tr.classList.toggle('sel', e.target.checked);
    updateVaultBulk();
    const all = $('#vaultSelectAll');
    if (all) {
      const ids = vaultVisible().map((v) => v.id);
      const selN = ids.filter((x) => vaultSelected.has(x)).length;
      all.checked = ids.length > 0 && selN === ids.length;
      all.indeterminate = selN > 0 && selN < ids.length;
    }
  });

  // 单条备注：失焦时保存
  $('#vaultBody').addEventListener('change', async (e) => {
    if (!e.target.matches('input[data-note]')) return;
    const tr = e.target.closest('tr.vt-row');
    if (!tr) return;
    const v = vaultById(tr.getAttribute('data-id'));
    if (!v) return;
    const note = e.target.value.trim();
    if (note === (v.note || '')) return;
    try {
      const r = await api('/api/vault/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: v.id, note }) });
      if (r && r.ok) { v.note = note; toast('备注已保存', 'success'); }
      else toast((r && r.message) || '保存失败', 'error');
    } catch (e2) { toast('保存失败：' + e2.message, 'error'); }
  });

  // 行内按钮（密码已改为鼠标悬停自动显示明文）
  $('#vaultBody').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr.vt-row');
    if (!tr) return;
    const v = vaultById(tr.getAttribute('data-id'));
    if (!v) return;
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'login') {
      openLogin();
      $('#username').value = v.username;
      $('#password').value = v.password;
      toast('已填入登录框，点「登 录」即可', 'info');
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(v.username + '\t' + v.password); toast('账号 + 密码已复制', 'success'); }
      catch (e2) { toast('复制失败（浏览器限制）', 'error'); }
    } else if (act === 'del') {
      if (!confirm('从本地账号库删除「' + v.username + '」？（不影响 4399 账号）')) return;
      try {
        await api('/api/vault/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: v.id }) });
        vaultSelected.delete(v.id);
        await loadVault();
        toast('已删除', 'success');
      } catch (e2) { toast('删除失败：' + e2.message, 'error'); }
    }
  });

  $('#vaultSearch') && $('#vaultSearch').addEventListener('input', (e) => { vaultQuery = e.target.value; renderVault(); });

  $('#vaultRevealBtn') && $('#vaultRevealBtn').addEventListener('click', () => {
    vaultReveal = !vaultReveal;
    renderVault();
  });

  $('#vaultExportAll') && $('#vaultExportAll').addEventListener('click', () => {
    vaultExport(vaultVisible(), '本地账号库_' + Date.now() + '.txt');
  });

  /* --- 批量操作 --- */
  $('#vaultBatchDelete') && $('#vaultBatchDelete').addEventListener('click', async () => {
    const ids = [...vaultSelected];
    if (!ids.length) return;
    if (!confirm('从本地账号库删除选中的 ' + ids.length + ' 条？（不影响 4399 账号，不可恢复）')) return;
    try {
      const r = await api('/api/vault/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', ids }) });
      if (r && r.ok) { vaultSelected.clear(); await loadVault(); toast('已删除 ' + r.count + ' 条', 'success'); }
      else toast((r && r.message) || '删除失败', 'error');
    } catch (e) { toast('删除失败：' + e.message, 'error'); }
  });

  $('#vaultBatchNote') && $('#vaultBatchNote').addEventListener('click', async () => {
    const ids = [...vaultSelected];
    if (!ids.length) return;
    const items = vaultSelectedItems();
    const same = items.every((v) => (v.note || '') === (items[0].note || ''));
    const note = prompt('给选中的 ' + ids.length + ' 条设置「导入备注」（留空则清空）：', same ? (items[0].note || '') : '');
    if (note == null) return;
    try {
      const r = await api('/api/vault/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'note', ids, note }) });
      if (r && r.ok) { await loadVault(); toast('已更新 ' + r.count + ' 条备注', 'success'); }
      else toast((r && r.message) || '更新失败', 'error');
    } catch (e) { toast('更新失败：' + e.message, 'error'); }
  });

  $('#vaultBatchCopy') && $('#vaultBatchCopy').addEventListener('click', async () => {
    const items = vaultSelectedItems();
    if (!items.length) return;
    const text = items.map((v) => v.username + '\t' + v.password).join('\r\n');
    try { await navigator.clipboard.writeText(text); toast('已复制 ' + items.length + ' 条（账号 + 密码）', 'success'); }
    catch (e) { toast('复制失败（浏览器限制）', 'error'); }
  });

  $('#vaultBatchExport') && $('#vaultBatchExport').addEventListener('click', () => {
    vaultExport(vaultSelectedItems(), '本地账号库_选中' + vaultSelected.size + '条.txt');
  });

  $('#vaultBatchLogin') && $('#vaultBatchLogin').addEventListener('click', openVaultBatchLogin);
}

/* ---------- 批量登录（串行 + 自定义间隔，遇风控自动停） ---------- */
function openVaultBatchLogin() {
  const ids = [...vaultSelected];
  if (!ids.length) { toast('请先勾选要登录的账号', 'error'); return; }
  openModal('批量登录（' + ids.length + ' 个）', `
    <p class="muted">将按顺序自动登录选中的账号（含自动识别验证码），每个之间等待指定间隔。若 4399 返回风控（「请稍后再试」，或静默拒绝登录且不给原因），会先等待重试，仍失败就停下并告诉你停在哪一条。</p>
    <div class="row"><label for="vblDelay">间隔（秒）</label><input type="number" id="vblDelay" value="2" min="0" max="60" step="0.5"></div>
    <div id="vblLog" class="vbl-log"><div class="vbl-line sum">准备就绪，点「开始批量登录」。</div></div>
    <div class="form-actions">
      <button class="btn primary" id="vblStart">开始批量登录</button>
      <button class="btn danger" id="vblStop" hidden>停止</button>
      <button class="btn ghost" id="vblClose">关闭</button>
    </div>`, 'wide');
  $('#vblStart').onclick = () => runVaultBatchLogin(ids);
  $('#vblStop').onclick = () => { vaultLoginAbort = true; toast('已请求停止，将在当前这条结束后停下', 'info'); };
  $('#vblClose').onclick = () => { if (vaultLoginRunning) { toast('正在登录中，请先点「停止」', 'info'); return; } closeModal(); };
}

// 遇 4399 静默风控（HTTP 200 + 登录页原样返回，无任何原因）时的退避策略。
// 实测该状态几十秒后自愈，所以先等再重试，比直接判失败更能救回账号。
const VBL_BLOCK_WAIT_S = 30;
const VBL_BLOCK_RETRY_MAX = 2;

async function runVaultBatchLogin(ids) {
  const items = ids.map(vaultById).filter(Boolean);
  if (!items.length) { toast('没有可登录的条目', 'error'); return; }
  if (vaultLoginRunning) return;
  const delay = Math.max(0, Math.min(60, Number($('#vblDelay').value) || 0));
  vaultLoginAbort = false;
  vaultLoginRunning = true;
  const startBtn = $('#vblStart'), stopBtn = $('#vblStop'), delayEl = $('#vblDelay');
  startBtn.disabled = true; startBtn.textContent = '登录中…';
  stopBtn.hidden = false;
  delayEl.disabled = true;
  const log = $('#vblLog');
  const line = (cls, txt) => { const d = document.createElement('div'); d.className = 'vbl-line ' + cls; d.textContent = txt; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  const res = { ok: 0, captcha: 0, fail: 0, added: [], timeout: [] };
  let stopped = '';
  for (let i = 0; i < items.length; i++) {
    if (vaultLoginAbort) { stopped = 'stop'; break; }
    const v = items[i];
    let cur = line('cur', `[${i + 1}/${items.length}] 正在登录 ${v.username} …`);
    let retried = 0;
    for (;;) {
      let r = null;
      try {
        r = await api('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: v.username, password: v.password, autoCaptcha: true }),
        });
      } catch (err) {
        res.fail++;
        if (/超时|timeout|ETIMEDOUT|AggregateError/i.test(err.message || '')) res.timeout.push(v.username);
        cur.className = 'vbl-line err';
        cur.textContent = `[${i + 1}/${items.length}] 失败 ${v.username} → ${err.message}`;
        break;
      }
      if (r && r.ok) {
        res.ok++;
        if (r.created && r.account && r.account.id) res.added.push(r.account.id);
        cur.className = 'vbl-line ok';
        cur.textContent = `[${i + 1}/${items.length}] 成功 ${v.username} → ${(r.account && (r.account.nickname || r.account.username)) || '已登录'}`;
        break;
      }
      if (r && r.needCaptcha) {
        res.captcha++;
        cur.className = 'vbl-line warn';
        cur.textContent = `[${i + 1}/${items.length}] 跳过 ${v.username} → 需要人工验证码`;
        break;
      }
      if (r && r.blocked) {
        if (retried < VBL_BLOCK_RETRY_MAX && !vaultLoginAbort) {
          retried++;
          cur.className = 'vbl-line warn';
          cur.textContent = `[${i + 1}/${items.length}] ${v.username} 被 4399 静默拦截，等待 ${VBL_BLOCK_WAIT_S} 秒后重试（第 ${retried}/${VBL_BLOCK_RETRY_MAX} 次）…`;
          await sleep(VBL_BLOCK_WAIT_S * 1000);
          if (vaultLoginAbort) { stopped = 'stop'; break; }
          cur = line('cur', `[${i + 1}/${items.length}] 正在重试 ${v.username} …`);
          continue;
        }
        res.fail++;
        cur.className = 'vbl-line err';
        cur.textContent = `[${i + 1}/${items.length}] 失败 ${v.username} → 4399 静默拒绝登录（IP 可能已被风控）`;
        stopped = 'blocked';
        break;
      }
      const rl = !!(r && (r.rateLimited || (r.risk && r.risk.recentRateLimit)));
      res.fail++;
      if (/超时/.test((r && r.error) || '')) res.timeout.push(v.username);
      cur.className = 'vbl-line err';
      cur.textContent = `[${i + 1}/${items.length}] 失败 ${v.username} → ${(r && r.error) || '登录失败'}`;
      if (rl) { stopped = 'ratelimit'; break; }
      break;
    }
    if (stopped) break;
    if (i < items.length - 1 && !vaultLoginAbort) await sleep(delay * 1000);
  }
  vaultLoginRunning = false;
  startBtn.disabled = false; startBtn.textContent = '重新开始';
  stopBtn.hidden = true;
  delayEl.disabled = false;
  try { await loadAccounts(); } catch (e) { }
  const hitRisk = stopped === 'ratelimit' || stopped === 'blocked';
  const summary = `批量登录完成：成功 ${res.ok}，需验证码 ${res.captcha}，失败 ${res.fail}`
    + (stopped === 'blocked' ? '（因 4399 静默风控已提前停止，剩余未尝试）'
      : stopped === 'ratelimit' ? '（因 4399 风控已提前停止）'
        : stopped === 'stop' ? '（已手动停止）' : '');
  line(hitRisk ? 'warn' : 'sum', summary);
  if (res.timeout.length) line('warn', `超时账号（网络到 4399 未在时限内返回，未做重试以免重复提交）：${res.timeout.join('、')}`);
  if (stopped === 'blocked') {
    line('warn', `4399 在这段时间内不处理来自本机的登录请求（约几十秒后恢复）。建议等 1~2 分钟再点「重新开始」，或把间隔调大一些。`);
  }
  toast(summary, hitRisk ? 'info' : 'success');
  if (res.added.length) {
    pickFolder({
      title: '批量登录完成 · 加入分组',
      message: `新登录添加了 ${res.added.length} 个账号，要放进哪个分组？（可跳过）`,
      confirmText: '加入分组',
      onPick: async (fid) => {
        if (fid) {
          await api('/api/accounts/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'move', ids: res.added, folderId: fid }) });
        }
        await loadAccounts();
        toast(fid ? '已归入分组' : '已添加（未分组）', 'success');
      },
    });
  }
}
function openImport() {
  impPairs = [];
  openModal('批量导入账号', `
    <div class="set-sec">
      <div class="set-k">导入备注（可选 · 会写进这一批全部条目，方便以后按备注排序 / 查找）</div>
      <input type="text" id="impNote" placeholder="例如：2026 小号 / 拉新号 / 某来源" maxlength="60" autocomplete="off">
    </div>
    <div class="set-sec">
      <div class="set-k">方式一：选择文本文件（可多选，自动识别 UTF-8 / GBK / UTF-16LE 等编码）</div>
      <input type="file" id="impFiles" multiple accept=".txt,.log,.csv,text/plain">
    </div>
    <div class="set-sec">
      <div class="set-k">方式二：直接粘贴文本</div>
      <textarea id="impText" rows="6" placeholder="把包含账号密码的文本粘贴到这里…"></textarea>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="impExtract">提取账号密码</button>
      <span class="hint tiny" id="impState"></span>
    </div>
    <div id="impPreview"></div>`, 'wide');
  $('#impExtract').onclick = doExtract;
}
async function doExtract() {
  const st = $('#impState');
  const files = $('#impFiles').files;
  const text = $('#impText').value;
  if (!files.length && !text.trim()) { toast('请选择文件或粘贴文本', 'error'); return; }
  st.textContent = '提取中…';
  let payload;
  if (files.length) {
    payload = { files: [] };
    for (const f of files) {
      const b64 = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1] || '');
        fr.readAsDataURL(f);
      });
      payload.files.push({ name: f.name, b64 });
    }
  } else {
    payload = { text };
  }
  try {
    const r = await api('/api/import/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const total = (r.files || []).reduce((n, f) => n + f.count, 0);
    st.textContent = `共提取 ${total} 组`;
    renderImportPreview(r.files || []);
    toast(`提取到 ${total} 组账号密码`, total ? 'success' : 'info');
  } catch (e) { st.textContent = '提取失败：' + e.message; toast('提取失败：' + e.message, 'error'); }
}
function renderImportPreview(files) {
  impPairs = [];
  let html = '';
  for (const f of files) {
    html += `<div class="imp-file"><div class="imp-file-head">${esc(f.name)} · ${esc(f.enc)} · ${f.count} 组</div>`;
    if (!f.count) { html += '<div class="muted">未提取到，请检查文本格式</div></div>'; continue; }
    html += '<div class="imp-rows">' + f.pairs.map((p) => {
      impPairs.push(p);
      const gi = impPairs.length - 1;
      return `<label class="imp-row"><input type="checkbox" data-gi="${gi}" checked><span class="mono">${esc(p.user)}</span><span class="mono muted">${esc(p.pass)}</span><span class="imp-how">${esc(p.how)}</span></label>`;
    }).join('') + '</div></div>';
  }
  html += `<div class="form-actions">
      <button class="btn primary" id="impSave">保存选中的到本地账号库</button>
      <button class="btn ghost" id="impSelAll">全选</button>
      <button class="btn ghost" id="impSelNone">全不选</button>
    </div>`;
  $('#impPreview').innerHTML = html;
  $('#impSelAll').onclick = () => $('#impPreview').querySelectorAll('input[data-gi]').forEach((c) => { c.checked = true; });
  $('#impSelNone').onclick = () => $('#impPreview').querySelectorAll('input[data-gi]').forEach((c) => { c.checked = false; });
  $('#impSave').onclick = doSaveImport;
}
async function doSaveImport() {
  const checks = [...$('#impPreview').querySelectorAll('input[data-gi]')];
  const items = checks.filter((c) => c.checked).map((c) => impPairs[Number(c.getAttribute('data-gi'))]).filter(Boolean);
  if (!items.length) { toast('请至少选择一条', 'error'); return; }
  const note = $('#impNote') ? $('#impNote').value.trim() : '';
  const btn = $('#impSave');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await api('/api/vault/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, note }) });
    toast(`已保存：新增 ${r.added}，更新 ${r.updated}，跳过 ${r.skipped}`, 'success');
    loadVault();
  } catch (e) { toast('保存失败：' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '保存选中的到本地账号库'; }
}

/* ---------- 网易云音乐小组件（官方外链播放器，无需登录） ---------- */
/* 播放走网易云官方 outchain 播放器，不接入任何第三方后端 / 不保存账号。 */
const MW_SONGS = [
  { id: '3359035705', name: "can't say(不说)", artist: 'Jux', dur: 185 },
  { id: '2617922230', name: 'i walk this earth all by myself', artist: 'Jux', dur: 125 },
  { id: '2620747889', name: 'save my soul', artist: 'Jux', dur: 214 },
  { id: '2617774869', name: 'Sleeptalking', artist: 'Jux', dur: 161 },
  { id: '2691957214', name: 'winter with u.', artist: 'Jux', dur: 180 },
  { id: '2621042586', name: '你和雨有一个共同点.', artist: 'Jux', dur: 146 },
  { id: '3423044478', name: 'Ladyfingers(钢琴版)', artist: 'Jux', dur: 123 },
  { id: '3313220735', name: 'here with u.', artist: 'Jux', dur: 185 },
  { id: '3341342527', name: 'Stay With You', artist: 'Jux', dur: 176 },
  { id: '2694841126', name: '此歌未竟', artist: 'Jux', dur: 92 },
  { id: '3416246402', name: 'Overture(序曲)', artist: 'Jux', dur: 128 },
  { id: '3421675964', name: 'Finals(终章)', artist: 'Jux', dur: 167 },
  { id: '2665183923', name: 'Suffering Once', artist: 'Jux', dur: 171 },
  { id: '2689315186', name: "Sayin'", artist: 'Jux', dur: 137 },
  { id: '3444169305', name: 'Never Go Away(陪伴直至永远)', artist: 'Jux', dur: 148 },
  { id: '3358311781', name: 'Lips', artist: 'Jux', dur: 142 },
  { id: '2716274445', name: 'Echo Bloom', artist: 'Traffic Lofi', dur: 125 },
  { id: '2716274444', name: 'Light Dreams', artist: 'Traffic Lofi', dur: 113 },
  { id: '2716276358', name: 'Cloud Drifts', artist: 'Traffic Lofi', dur: 108 },
  { id: '2647881094', name: 'Bright Lights', artist: 'Spective', dur: 143 },
];
let mwIndex = -1, mwPlaying = false, mwTimer = null, mwTick = null, mwElapsed = 0, mwOrder = [], mwCustom = null;

function mwFmt(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function mwFrameSrc(id, type, auto) {
  return `https://music.163.com/outchain/player?type=${type}&id=${encodeURIComponent(id)}&auto=${auto ? 1 : 0}&height=66`;
}
// 网易云 iframe 只当「播放引擎」，做成 1px 隐形；界面全部由本地自绘（深色友好，封面不会被反色）
function mwSetFrame(url) {
  const f = $('#mwFrame');
  if (f) f.src = url;
  const w = $('#musicWidget');
  if (w) w.classList.add('playing');
}
function mwCurrent() { return mwCustom || MW_SONGS[mwIndex] || null; }
function mwRenderCover(s) {
  const box = $('#mwCover');
  if (!box) return;
  box.innerHTML = (s && s.cover)
    ? `<img src="${esc(s.cover)}" alt="" onerror="this.style.display='none'">`
    : '<span class="mw-cover-ph">' + icon('music') + '</span>';
}
function mwRenderProgress() {
  const s = mwCurrent();
  const dur = (s && s.dur) || 0;
  const f = $('#mwProgFill');
  if (f) f.style.width = (dur ? Math.min(100, mwElapsed / dur * 100) : 0) + '%';
  const c = $('#mwCur'); if (c) c.textContent = mwFmt(mwElapsed);
}
function mwRender() {
  const s = mwCurrent();
  const title = s ? (s.name || s.title || '网易云音乐') : '未播放';
  $('#mwSong').textContent = s ? title : '网易云音乐';
  const t = $('#mwTitle'); if (t) t.textContent = title;
  const ar = $('#mwArtist'); if (ar) ar.textContent = s && s.artist ? '· ' + s.artist : '';
  $('#mwPlay').innerHTML = mwPlaying ? icon('pause') : icon('play');
  const d = $('#mwDur'); if (d) d.textContent = s && s.dur ? mwFmt(s.dur) : '--:--';
  const w = $('#musicWidget');
  if (w) w.classList.toggle('is-playing', mwPlaying);
  mwRenderCover(s);
  mwRenderProgress();
}
// 按「第一首固定 can't say，其余随机」生成播放顺序
function mwBuildOrder() {
  const rest = MW_SONGS.map((_, i) => i).filter((i) => i !== 0);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
  }
  mwOrder = [0, ...rest];
}
function mwSchedule(dur) {
  if (mwTimer) { clearTimeout(mwTimer); mwTimer = null; }
  if (!dur) return;
  mwTimer = setTimeout(() => { if (mwPlaying) mwGoNext(); }, (dur + 2) * 1000);
}
function mwStartTick() {
  mwStopTick();
  mwTick = setInterval(() => { if (mwPlaying) { mwElapsed += 1; mwRenderProgress(); } }, 1000);
}
function mwStopTick() { if (mwTick) { clearInterval(mwTick); mwTick = null; } }
// 拉取网易云公开页面的封面 / 歌手（本地缓存，失败不影响播放）
async function mwFetchMeta(s) {
  if (!s || s.cover || s._metaTried) return;
  s._metaTried = true;
  try {
    const r = await api('/api/music/meta?id=' + encodeURIComponent(s.id) + '&type=2');
    if (r && r.ok) {
      if (!s.artist && r.artist) s.artist = r.artist;
      s.cover = r.coverLocal || r.coverUrl || null;
      if (mwCurrent() === s) mwRender();
    }
  } catch (e) { /* 忽略 */ }
}
function mwPlayIndex(i) {
  mwCustom = null;
  mwIndex = i;
  const s = MW_SONGS[i];
  if (!s) return;
  mwElapsed = 0;
  mwSetFrame(mwFrameSrc(s.id, 2, true));
  mwPlaying = true;
  mwRender();
  mwSchedule(s.dur);
  mwStartTick();
  mwFetchMeta(s);
}
function mwGoNext() {
  if (!mwOrder.length) mwBuildOrder();
  const pos = mwOrder.indexOf(mwIndex);
  mwPlayIndex(mwOrder[(pos + 1) % mwOrder.length]);
}
function mwGoPrev() {
  if (!mwOrder.length) mwBuildOrder();
  const pos = mwOrder.indexOf(mwIndex);
  mwPlayIndex(mwOrder[(pos - 1 + mwOrder.length) % mwOrder.length]);
}
function mwTogglePlay() {
  const s = mwCurrent();
  if (!s) { mwPlayFirst(); return; }
  const type = s.type || 2;
  if (mwPlaying) {
    mwPlaying = false;
    mwStopTick();
    if (mwTimer) { clearTimeout(mwTimer); mwTimer = null; }
    mwSetFrame(mwFrameSrc(s.id, type, false));   // 以暂停态重新载入
  } else {
    mwPlaying = true;
    mwSetFrame(mwFrameSrc(s.id, type, true));
    mwSchedule(s.dur);
    mwStartTick();
  }
  mwRender();
}
function mwGoShuffle() {
  mwBuildOrder();
  mwPlayIndex(mwOrder[Math.floor(Math.random() * mwOrder.length)]);
}
function mwParseLink(v) {
  if (/^\d+$/.test(v)) return { id: v, type: 2 };
  const pl = v.match(/playlist[^]*?[?&#]id=(\d+)/);
  if (pl) return { id: pl[1], type: 0 };
  const sg = v.match(/song[^]*?[?&#]id=(\d+)/);
  if (sg) return { id: sg[1], type: 2 };
  const any = v.match(/[?&#]id=(\d+)/);
  if (any) return { id: any[1], type: 2 };
  return null;
}
async function mwLoadLink() {
  const v = ($('#mwLink').value || '').trim();
  if (!v) return;
  const p = mwParseLink(v);
  if (!p) { toast('无法识别，请粘贴网易云歌曲 / 歌单链接', 'error'); return; }
  if (mwTimer) { clearTimeout(mwTimer); mwTimer = null; }
  mwIndex = -1;
  mwElapsed = 0;
  mwCustom = { id: p.id, type: p.type, name: p.type === 0 ? '歌单播放中…' : '自定义歌曲', artist: '', dur: 0, cover: null };
  mwSetFrame(mwFrameSrc(p.id, p.type, true));
  mwPlaying = true;
  mwRender();
  mwStartTick();
  try {
    const r = await api('/api/music/meta?id=' + encodeURIComponent(p.id) + '&type=' + p.type);
    if (r && r.ok) {
      mwCustom.name = r.title || mwCustom.name;
      mwCustom.artist = r.artist || '';
      mwCustom.cover = r.coverLocal || r.coverUrl || null;
      mwRender();
    }
  } catch (e) { /* 忽略 */ }
  toast(p.type === 0 ? '已载入歌单（歌曲切换由网易云播放器控制）' : '已载入歌曲', 'success');
}
// 默认播放顺序：第一首 = can't say，其余随机
function mwPlayFirst() {
  mwBuildOrder();
  mwPlayIndex(mwOrder[0]);
}
// 打开页面后自动播放（默认关闭；只有显式打开「自动播放」才播）
function mwAutoplay() {
  try { if (localStorage.getItem('4399.musicAuto') !== '1') return; } catch (e) { }
  mwPlayFirst();
}

function mwInit() {
  // 恢复「固定展开」状态
  try {
    if (localStorage.getItem('4399.musicPinned') === '1') $('#musicWidget').classList.add('pinned');
  } catch (e) { }
  $('#mwCollapse').addEventListener('click', (e) => {
    e.stopPropagation();
    const w = $('#musicWidget');
    w.classList.toggle('pinned');
    try { localStorage.setItem('4399.musicPinned', w.classList.contains('pinned') ? '1' : '0'); } catch (e2) { }
  });
  $('#mwPlay').addEventListener('click', mwTogglePlay);
  $('#mwNext').addEventListener('click', mwGoNext);
  $('#mwPrev').addEventListener('click', mwGoPrev);
  $('#mwShuffle').addEventListener('click', mwGoShuffle);
  $('#mwLoad').addEventListener('click', mwLoadLink);
  $('#mwLink').addEventListener('keydown', (e) => { if (e.key === 'Enter') mwLoadLink(); });
  mwRender();
  mwAutoplay();
}

document.addEventListener('DOMContentLoaded', () => {
  const splashAt = Date.now();
  const splashEl = $('#splash');
  const splashOn = !!splashEl && !document.documentElement.classList.contains('no-splash');
  loadTheme(); initDouwa(); loadFolders(); loadVault(); mwInit();
  try { const v = localStorage.getItem('4399.gdView'); if (v === 'grid' || v === 'list') gdView = v; } catch (e) { }
  if ($('#gdView')) $('#gdView').querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x.getAttribute('data-view') === gdView));
  renderNavIndicator();
  setTimeout(renderNavIndicator, 60);
  let splashDone = false;
  const finishSplash = () => {
    if (splashDone) return;
    splashDone = true;
    if (!splashOn) return;
    splashSet(100, '就绪');
    // 最短展示 900ms，避免一闪而过
    setTimeout(() => splashEl.classList.add('done'), Math.max(0, 900 - (Date.now() - splashAt)));
  };
  if (splashOn) {
    splashSet(20, '正在加载配置…');
    Promise.resolve()
      .then(() => { splashSet(46, '正在读取账号数据…'); return loadAccounts(); })
      .catch(() => { })
      .then(() => new Promise((r) => setTimeout(() => { splashSet(88, '正在渲染界面…'); r(); }, 240)))
      .then(finishSplash);
  } else {
    Promise.resolve().then(loadAccounts).catch(() => { });
  }
  // 兜底：后端无响应时最多 5s 也必须收场，避免卡在启动层
  setTimeout(finishSplash, 5000);
});
