/* ============================================================
   4399 账号管理器 · NTQQ 风格桌面壳
   - 左侧图标栏：复用原来的 #sideNav（app.js 已绑定事件，这里只补交互）
   - 中间会话列表：把账号渲染成 QQ 会话行（头像 / 昵称 / 副标题 / 时间）
   - 右侧内容区：原来的页面，选中会话时聚焦到单个账号
   依赖：app.js 暴露的 toast / icon / hydrateIcons（调用时已加载完毕）
   ============================================================ */
(function () {
  'use strict';

  var LS_PIN = '4399.shell.pin';
  var LS_MUTE = '4399.shell.mute';

  var state = {
    accounts: [],
    filtered: [],
    query: '',
    tab: 'all',
    focusId: null,
    pin: new Set(readList(LS_PIN)),
    mute: new Set(readList(LS_MUTE)),
  };

  /* ---------------- 小工具 ---------------- */
  function readList(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function saveList(key, set) {
    try { localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch (e) { }
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ic(name) {
    return typeof window.icon === 'function' ? window.icon(name) : '';
  }
  function tip(msg, type) {
    if (typeof window.toast === 'function') window.toast(msg, type || 'info');
    else console.log('[shell]', msg);
  }
  function hydrate(root) {
    if (typeof window.hydrateIcons === 'function') window.hydrateIcons(root || document);
  }
  function letterAvatar(name) {
    if (typeof window.letterAvatar === 'function') return window.letterAvatar(name);
    var ch = (String(name || '?').trim()[0] || '?').toUpperCase();
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56">'
      + '<rect width="56" height="56" fill="#4aa8e8"/>'
      + '<text x="50%" y="54%" font-size="26" fill="#0a0e13" text-anchor="middle" '
      + 'dominant-baseline="middle" font-family="sans-serif" font-weight="700">' + ch + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function avatarSrc(a) {
    if (a && a.uid) {
      return '/api/avatar?uid=' + encodeURIComponent(a.uid)
        + (a.avatarUpdatedAt ? '&t=' + a.avatarUpdatedAt : '');
    }
    return letterAvatar(a && (a.nickname || a.username));
  }
  /* QQ 式时间：今天 HH:MM / 昨天 / MM-DD */
  function sessTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return p(d.getHours()) + ':' + p(d.getMinutes());
    var y = new Date(now.getTime() - 86400000);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return p(d.getMonth() + 1) + '-' + p(d.getDate());
    return d.getFullYear() + '-' + p(d.getMonth() + 1);
  }
  function folderLabel(a) {
    if (!a || !a.folderId) return '';
    var list = [];
    try { list = (typeof folders !== 'undefined' && folders) || []; } catch (e) { list = []; }
    var f = list.find(function (x) { return x.id === a.folderId; });
    return f ? f.name : '';
  }

  /* ---------------- 会话列表渲染 ---------------- */
  function visibleAccounts() {
    var list = state.accounts.slice();
    var q = state.query.trim().toLowerCase();
    if (q) {
      list = list.filter(function (a) {
        return [a.nickname, a.username, a.uid, a.remark]
          .some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
      });
    }
    if (state.tab === 'valid') list = list.filter(function (a) { return a.sessionValid !== false; });
    if (state.tab === 'expired') list = list.filter(function (a) { return a.sessionValid === false; });

    list.sort(function (a, b) {
      var pa = state.pin.has(a.id) ? 1 : 0;
      var pb = state.pin.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      var ra = a.lastRefresh || a.lastLogin || 0;
      var rb = b.lastRefresh || b.lastLogin || 0;
      if (ra !== rb) return rb - ra;
      return String(a.nickname || a.username || '').localeCompare(String(b.nickname || b.username || ''), 'zh');
    });
    return list;
  }

  function render() {
    var box = document.getElementById('sessionList');
    if (!box) return;
    var list = visibleAccounts();
    state.filtered = list;

    if (!list.length) {
      box.innerHTML = '<div class="list-empty">'
        + (state.accounts.length ? '没有匹配的账号<br>换个关键词试试' : '还没有账号<br>点右上角 + 添加一个')
        + '</div>';
    } else {
      box.innerHTML = list.map(function (a) {
        var pinned = state.pin.has(a.id);
        var expired = a.sessionValid === false;
        var sub = [];
        if (a.uid) sub.push('UID ' + a.uid);
        else if (a.username) sub.push('@' + a.username);
        var fl = folderLabel(a);
        if (fl) sub.push(fl);
        if (a.credit != null && a.credit !== '') sub.push('积分 ' + a.credit);
        if (!sub.length) sub.push(a.username ? '@' + a.username : '暂无资料');

        return '<div class="sess' + (state.focusId === a.id ? ' active' : '') + '"'
          + ' data-id="' + esc(a.id) + '" role="button" tabindex="0"'
          + ' title="' + esc((a.nickname || a.username || '') + (expired ? ' · 登录态已过期' : '')) + '">'
          + '<div class="sess-av"><img src="' + esc(avatarSrc(a)) + '" alt=""'
          + ' data-fallback="' + esc(letterAvatar(a.nickname || a.username)) + '"'
          + ' onerror="this.onerror=null;this.src=this.dataset.fallback"></div>'
          + '<div class="sess-main">'
          + '<div class="sess-name">' + esc(a.nickname || a.username || '未知')
          + (pinned ? '<span class="pin-mark">置顶</span>' : '') + '</div>'
          + '<div class="sess-sub">' + esc(sub.join(' · ')) + '</div>'
          + '</div>'
          + '<div class="sess-side"><span class="sess-time">' + esc(sessTime(a.lastRefresh || a.lastLogin)) + '</span>'
          + '<span class="sess-dot' + (expired ? '' : ' ok') + '"></span></div>'
          + '</div>';
      }).join('');
    }

    var foot = document.getElementById('listFoot');
    if (foot) {
      var valid = state.accounts.filter(function (a) { return a.sessionValid !== false; }).length;
      foot.textContent = '共 ' + state.accounts.length + ' 个账号 · 有效 ' + valid;
    }

    // 聚焦时把对应的会话行滚进可视区
    if (state.focusId) {
      var active = box.querySelector('.sess.active');
      if (active && active.scrollIntoView) {
        try { active.scrollIntoView({ block: 'nearest' }); } catch (e) { }
      }
    }
  }

  /* ---------------- 聚焦单个账号（右侧只看这一个） ---------------- */
  function applyFocus() {
    var cards = document.querySelectorAll('#accounts .acc-card');
    var hint = document.getElementById('focusHint');
    var showAllBtn = document.getElementById('showAllBtn');
    if (!cards.length) return;

    if (state.focusId && !document.querySelector('#accounts .acc-card[data-id="' + cssEsc(state.focusId) + '"]')) {
      state.focusId = null;   // 账号被删了 / 列表还没渲染出来
    }

    var on = !!state.focusId;
    Array.prototype.forEach.call(cards, function (c) {
      c.style.display = (!on || c.getAttribute('data-id') === state.focusId) ? '' : 'none';
    });
    var grid = document.getElementById('accounts');
    if (grid) grid.classList.toggle('focus-mode', on);
    if (hint) {
      hint.classList.toggle('on', on);
      if (on) {
        var a = findAccount(state.focusId);
        hint.innerHTML = '正在查看 <b>' + esc((a && (a.nickname || a.username)) || '')
          + '</b> 的详情 · 点右上角「全部账号」回到列表';
      }
    }
    if (showAllBtn) showAllBtn.hidden = !on;
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function findAccount(id) {
    return state.accounts.find(function (a) { return a.id === id; }) || null;
  }

  function focusAccount(id) {
    var a = findAccount(id);
    if (!a) return;
    state.focusId = id;
    var nav = document.getElementById('navAccounts');
    if (nav) nav.click();          // 切回账号总览（内部会重渲染 → sync → applyFocus）
    var t = document.getElementById('pageTitle');
    var s = document.getElementById('pageSub');
    if (t) t.textContent = a.nickname || a.username || '账号详情';
    if (s) s.textContent = (a.username ? '@' + a.username : '') + (a.uid ? ' · UID ' + a.uid : '');
    applyFocus();
    render();
  }

  function showAll() {
    state.focusId = null;
    var nav = document.getElementById('navAccounts');
    if (nav) nav.click();
    applyFocus();
    render();
  }

  /* ---------------- 右键菜单 ---------------- */
  var menuEl = null;

  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }

  function cardAct(id, act) {
    var card = document.querySelector('#accounts .acc-card[data-id="' + cssEsc(id) + '"]');
    if (!card) return tip('账号卡片还没渲染好，稍等一下再试', 'warn');
    var btn = card.querySelector('[data-act="' + act + '"]');
    if (!btn) return tip('该操作当前不可用', 'warn');
    btn.click();
  }

  function copyText(text, okMsg) {
    var done = function () { tip(okMsg || '已复制', 'success'); };
    var fail = function () { tip('复制失败，请手动选择', 'error'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text)).then(done).catch(fail);
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = String(text);
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) { fail(); }
    }
  }

  function openMenu(x, y, a) {
    closeMenu();
    var pinned = state.pin.has(a.id);
    var items = [
      { k: 'pin', label: pinned ? '取消置顶' : '置顶会话', icon: 'star' },
      { k: 'copyUser', label: '复制账号', icon: 'copy' },
      { k: 'copyUid', label: '复制 UID', icon: 'at' },
      { sep: true },
      { k: 'refresh', label: '刷新资料', icon: 'refresh' },
      { k: 'security', label: '账号安全概览', icon: 'shield' },
      { k: 'edit', label: '编辑资料', icon: 'pencil' },
      { k: 'meta', label: '备注 / 分组', icon: 'note' },
      { sep: true },
      { k: 'relogin', label: '重新登录', icon: 'lock' },
    ];

    menuEl = document.createElement('div');
    menuEl.className = 'sess-menu';
    menuEl.innerHTML = items.map(function (it) {
      if (it.sep) return '<div class="sep"></div>';
      return '<button type="button" data-k="' + it.k + '">' + ic(it.icon) + '<span>' + esc(it.label) + '</span></button>';
    }).join('');
    document.body.appendChild(menuEl);

    var r = menuEl.getBoundingClientRect();
    var left = Math.min(x, window.innerWidth - r.width - 8);
    var top = Math.min(y, window.innerHeight - r.height - 8);
    menuEl.style.left = Math.max(8, left) + 'px';
    menuEl.style.top = Math.max(8, top) + 'px';

    menuEl.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-k]');
      if (!btn) return;
      var k = btn.getAttribute('data-k');
      closeMenu();
      if (k === 'pin') {
        if (state.pin.has(a.id)) state.pin.delete(a.id);
        else state.pin.add(a.id);
        saveList(LS_PIN, state.pin);
        render();
        return;
      }
      if (k === 'copyUser') return copyText(a.username || '', '已复制账号：' + (a.username || ''));
      if (k === 'copyUid') return copyText(a.uid || '', '已复制 UID：' + (a.uid || ''));
      cardAct(a.id, k);
    });
  }

  document.addEventListener('click', function (e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', closeMenu);

  /* ---------------- 标题栏 / 图标栏 ---------------- */
  function wireChrome() {
    var themeBtn = document.getElementById('themeBtn');
    var D = window.desktop;                 // 桌面版（Electron）注入的窗口控制
    if (D) document.body.classList.add('is-desktop');

    var winTheme = document.getElementById('winTheme');
    if (winTheme) winTheme.addEventListener('click', function () { if (themeBtn) themeBtn.click(); });

    var railTheme = document.getElementById('railTheme');
    if (railTheme) railTheme.addEventListener('click', function () { if (themeBtn) themeBtn.click(); });

    var railMusic = document.getElementById('railMusic');
    if (railMusic) railMusic.addEventListener('click', function () {
      var w = document.getElementById('musicWidget');
      if (!w) return;
      w.classList.toggle('pinned');
      railMusic.classList.toggle('active', w.classList.contains('pinned'));
    });

    var winMin = document.getElementById('winMin');
    if (winMin) winMin.addEventListener('click', function () {
      if (D && D.minimize) D.minimize();
      else tip('浏览器标签页没有最小化，用系统的最小化按钮就好', 'info');
    });

    var winFull = document.getElementById('winFull');
    if (winFull) winFull.addEventListener('click', function () {
      if (D && D.toggleMaximize) { D.toggleMaximize(); return; }
      var d = document;
      if (!d.fullscreenElement) {
        var p = d.documentElement.requestFullscreen ? d.documentElement.requestFullscreen() : null;
        if (p && p.catch) p.catch(function () { tip('浏览器拒绝了全屏请求', 'warn'); });
      } else if (d.exitFullscreen) {
        d.exitFullscreen();
      }
    });
    if (D && D.onMaximizedChange) {
      D.onMaximizedChange(function (max) { document.body.classList.toggle('is-maximized', max); });
      if (D.isMaximized) D.isMaximized().then(function (max) { document.body.classList.toggle('is-maximized', !!max); }).catch(function () { });
    }

    var winClose = document.getElementById('winClose');
    if (winClose) winClose.addEventListener('click', function () {
      if (D && D.close) { D.close(); return; }
      window.close();
      setTimeout(function () {
        tip('浏览器不允许脚本关标签页，请按 Ctrl+W 或点标签上的 ×', 'info');
      }, 120);
    });

    var listAdd = document.getElementById('listAdd');
    if (listAdd) listAdd.addEventListener('click', function () {
      var navAdd = document.getElementById('navAdd');
      if (navAdd) navAdd.click();
    });

    var showAllBtn = document.getElementById('showAllBtn');
    if (showAllBtn) showAllBtn.addEventListener('click', showAll);
  }

  function wireList() {
    var box = document.getElementById('sessionList');
    if (box) {
      box.addEventListener('click', function (e) {
        var row = e.target.closest('.sess');
        if (row) focusAccount(row.getAttribute('data-id'));
      });
      box.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var row = e.target.closest('.sess');
        if (!row) return;
        e.preventDefault();
        focusAccount(row.getAttribute('data-id'));
      });
      box.addEventListener('contextmenu', function (e) {
        var row = e.target.closest('.sess');
        if (!row) return;
        e.preventDefault();
        var a = findAccount(row.getAttribute('data-id'));
        if (a) openMenu(e.clientX, e.clientY, a);
      });
    }

    var search = document.getElementById('listSearch');
    if (search) search.addEventListener('input', function () {
      state.query = search.value || '';
      render();
    });

    var tabs = document.getElementById('listTabs');
    if (tabs) tabs.addEventListener('click', function (e) {
      var b = e.target.closest('.ltab');
      if (!b) return;
      state.tab = b.getAttribute('data-tab') || 'all';
      Array.prototype.forEach.call(tabs.querySelectorAll('.ltab'), function (x) {
        x.classList.toggle('active', x === b);
      });
      render();
    });
  }

  function ensureHint() {
    if (document.getElementById('focusHint')) return;
    var host = document.getElementById('pageAccounts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'focus-hint';
    el.id = 'focusHint';
    host.insertBefore(el, host.firstChild);
  }

  /* ---------------- 对外接口：app.js 渲染完账号后调用 ---------------- */
  window.NTQQ_SHELL = {
    sync: function (list) {
      state.accounts = Array.isArray(list) ? list : [];
      ensureHint();
      render();
      applyFocus();
    },
    focus: focusAccount,
    showAll: showAll,
    refresh: render,
  };

  /* ---------------- 页面切换时同步壳状态 ----------------
     「分组 / 本地账号库」自带左侧导航，这时收起会话列表，避免双栏重复 */
  function wrapSwitchPage() {
    if (typeof window.switchPage !== 'function' || window.switchPage.__shellWrapped) return;
    var orig = window.switchPage;
    var wrapped = function (name) {
      orig(name);
      document.body.classList.toggle('page-groups', name === 'groups');
      document.body.classList.toggle('page-vault', name === 'vault');
      closeMenu();
    };
    wrapped.__shellWrapped = true;
    window.switchPage = wrapped;
  }

  /* ---------------- 深链接：#page=groups / #acc=<账号id> ---------------- */
  function applyHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    var p;
    try { p = new URLSearchParams(h); } catch (e) { return; }
    var page = p.get('page');
    if (page && typeof window.switchPage === 'function') window.switchPage(page);
    var acc = p.get('acc');
    if (acc) {
      // 账号列表是异步加载的，等它到位再聚焦
      var tries = 0;
      var tick = setInterval(function () {
        if (findAccount(acc)) { clearInterval(tick); focusAccount(acc); }
        else if (++tries > 25) clearInterval(tick);
      }, 200);
    }
  }

  function boot() {
    ensureHint();
    wireChrome();
    wireList();
    wrapSwitchPage();
    hydrate(document);
    render();
    applyHash();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
