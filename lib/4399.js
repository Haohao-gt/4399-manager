'use strict';
// 4399 登录 / 账号信息 / 签到 协议封装
const { CookieJar, request, requestFollow, buildMultipart, DEFAULT_UA } = require('./http');

const PTLOGIN = 'https://ptlogin.4399.com';
const CLIENT_ID = 'b42fa86ea85a4dc8bab446a26c7ccd44';
const REDIRECT_URI = 'http://a.4399.cn/mobile/';
const MY4399 = 'https://my.4399.com';
const HUODONG = 'https://huodong.4399.com';
const U4399 = 'https://u.4399.com';
const IMG4399 = 'https://a.img4399.com';
const GPRP = 'https://gprp.4399.com';

// 区服角色查询：服务端实测约 3 秒允许一次，留出余量
const ROLE_QUERY_INTERVAL_MS = 3100;

// 判断一个错误/文案是否为「超时」，用于前端点名超时对象
function isTimeoutMsg(msg) { return /超时|ETIMEDOUT|timeout/i.test(String(msg || '')); }

function randomState() {
  // 32 位 hex
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function authUrl(state) {
  return `${PTLOGIN}/oauth2/authorize.do?client_id=${CLIENT_ID}` +
    `&response_type=TOKEN&auth_action=LOGIN&realNameLevel=5` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
}

// 提取某表单内 type=hidden 的 name/value
function decodeForms(html) {
  const map = {};
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/type\s*=\s*"hidden"/i.test(tag)) continue;
    const n = tag.match(/name\s*=\s*"([^"]*)"/i);
    const v = tag.match(/value\s*=\s*"([^"]*)"/i);
    if (n && !(n[1] in map)) map[n[1]] = v ? v[1] : '';
  }
  return map;
}

// 取指定 action 的 form 的隐藏字段
function extractForm(html, actionRe) {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || [];
  for (const f of forms) {
    const am = f.match(/action\s*=\s*"([^"]*)"/i);
    if (am && actionRe.test(am[1])) return decodeForms(f);
  }
  return null;
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ').trim();
}

// 去掉标签并解码实体（用于解析 HTML 表格单元格）
function stripTags(s) {
  return decodeHtmlEntities(String(s || '').replace(/<[^>]*>/g, ' '));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 第一步：拉授权页，拿隐藏字段
async function fetchAuthorizePage(jar, state) {
  const res = await requestFollow(authUrl(state), { method: 'GET', headers: { 'User-Agent': DEFAULT_UA } }, jar);
  const html = res.text();
  let fields = extractForm(html, /\/oauth2\/authorize\.do$/i) || extractForm(html, /\/oauth2\/authorize\.do/i);
  if (!fields) fields = decodeForms(html);
  return { html, fields };
}

// 第二步：提交登录（返回结构化结果）
async function submitLogin(jar, fields, { username, password, captcha, captchaId }) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) {
    if (k === 'username' || k === 'password' || k === 'captcha' || k === 'captcha_id') continue;
    form.set(k, v);
  }
  form.set('username', username);
  form.set('password', password);
  if (captcha) form.set('captcha', captcha);
  if (captchaId) form.set('captcha_id', captchaId);

  const res = await request(`${PTLOGIN}/oauth2/loginAndAuthorize.do`, {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': PTLOGIN,
      'Referer': authUrl(fields && fields.state ? fields.state : ''),
    },
    body: form.toString(),
    jar,
  });

  const text = res.text();
  // 4399 限流：HTTP 202 或正文提示「请稍后再试」
  const rateLimited = res.status === 202 || /请稍后再试/.test(text);

  // 302：成功（带 access_token 或 uid）
  if (res.status === 302 && res.location) {
    const loc = res.location;
    let q = {};
    try { q = Object.fromEntries(new URL(loc, PTLOGIN).searchParams); } catch (e) { }
    return { ok: true, location: loc, accessToken: q.access_token || null, uid: q.uid || null, raw: text };
  }

  // 200：判断错误 / 验证码 / 成功
  const cidMatch = text.match(/name\s*=\s*"captcha_id"\s+value\s*=\s*"([^"]+)"/i) ||
    text.match(/value\s*=\s*"([^"]+)"\s+name\s*=\s*"captcha_id"/i);
  const newCid = cidMatch && cidMatch[1] ? cidMatch[1] : null;

  const capErr = text.match(/id="captcha1_err_msg">\s*([\s\S]*?)\s*<\/p>/i);
  const capErrText = capErr ? decodeHtmlEntities(capErr[1]).trim() : '';
  const errMsg = text.match(/id="login_err_msg">\s*([\s\S]*?)\s*<\/p>/i);
  const errText = errMsg ? decodeHtmlEntities(errMsg[1]).trim() : '';

  // 验证码本身填错
  if (capErrText && /验证码/.test(capErrText)) {
    return { ok: false, error: capErrText, captchaError: true, captchaId: newCid, raw: text };
  }

  // 需要图形验证码：必须优先于错误消息判断
  // （login_err_msg 即使为空也会命中，否则会把“需要验证码”吞掉）
  if (newCid) {
    return { ok: false, needCaptcha: true, error: errText || undefined, captchaId: newCid, rateLimited, raw: text };
  }

  if (errText) return { ok: false, error: errText, rateLimited, raw: text };

  // 实名认证
  if (/setIdcardAndRealname\.do/.test(text)) {
    return { ok: false, error: '该账号需要实名认证，请先在官网完成实名后再试', needRealName: true, raw: text };
  }

  // 成功特征
  const tok = text.match(/name\s*=\s*"access_token"\s+value\s*=\s*"([^"]+)"/i);
  const code = text.match(/"code"\s*:\s*"?(\d+)/i);
  if ((tok && tok[1]) || (code && code[1] === '100')) {
    return { ok: true, accessToken: tok ? tok[1] : null, raw: text };
  }

  // 静默风控：4399 收到了 POST 却完全不处理 —— 把登录页原样渲染回来，
  // 错误容器是空的、不给验证码、不给任何原因、也不是 202 限流。
  // 实测该状态几十秒后自愈，所以标记成 blocked 交给上层退避重试。
  // 走到这里时 errText / capErrText / newCid 都为空，所以只要响应仍是登录页就能认定。
  const isLoginPage = /id="authorizeForm"|id="j-username"|name="authorizeForm"/i.test(text);
  if (isLoginPage) {
    return {
      ok: false,
      blocked: true,
      error: '4399 静默拒绝了本次登录（未返回任何原因）——当前 IP 很可能已被风控，稍等几十秒后重试通常即可恢复',
      rateLimited, raw: text, status: res.status,
    };
  }

  // 其它 200：无法识别的内容（可能是登录页改版）
  return { ok: false, error: '登录未成功（4399 返回了无法识别的内容，可能是登录页改版）', rateLimited, raw: text, status: res.status };
}

// 拉取验证码图片（返回 base64 data url）
async function fetchCaptchaImage(jar, captchaId) {
  const res = await request(`${PTLOGIN}/ptlogin/captcha.do?captchaId=${encodeURIComponent(captchaId)}`, {
    method: 'GET',
    headers: { 'User-Agent': DEFAULT_UA, 'Referer': PTLOGIN + '/' },
    jar,
  });
  if (res.status !== 200) return null;
  const ct = res.headers['content-type'] || 'image/png';
  return 'data:' + ct + ';base64,' + res.body.toString('base64');
}

// 从 cookie 里拿 uid（Pauth = uid|...）
function uidFromJar(jar) {
  const pauth = jar.get('Pauth');
  if (pauth) { const p = pauth.split('|'); if (p[0]) return p[0]; }
  return null;
}
function nickFromJar(jar) {
  const pnick = jar.get('Pnick');
  if (pnick) { try { return decodeURIComponent(pnick); } catch (e) { return pnick; } }
  return null;
}

// 获取账号信息
async function getUserInfo(jar, uidHint) {
  const uid = uidFromJar(jar) || uidHint || null;
  const info = {
    uid, nickname: nickFromJar(jar), avatar: null,
    credit: null, grade: null, growth: null,
    followed: null, joinTime: null, verified: null,
  };

  // 头像 / 关注 / 注册时间（my.4399.com 已强制 https）
  if (uid) {
    try {
      const r = await requestFollow(`${MY4399}/forums/user-info?uid=${uid}&withMedal=1&_AJAX_=1`, {
        method: 'GET', headers: { 'User-Agent': DEFAULT_UA, 'X-Requested-With': 'XMLHttpRequest' },
      }, jar);
      const res = (JSON.parse(r.text()).result) || {};
      info.avatar = res.avatar || res.avator || null;
      info.followed = res.followed != null ? res.followed : null;
      info.joinTime = res.join_time != null ? res.join_time : null;
      info.verified = res.verified != null ? res.verified : null;
      if (res.num_grade != null) info.grade = res.num_grade;
      if (res.num_credit != null) info.credit = res.num_credit;
    } catch (e) { /* 忽略 */ }
  }

  // 积分 / 等级 / 成长值
  try {
    const r = await requestFollow(`${MY4399}/jifen/async-user?t=${Date.now()}`, {
      method: 'GET', headers: { 'User-Agent': DEFAULT_UA, 'X-Requested-With': 'XMLHttpRequest' },
    }, jar);
    const res = (JSON.parse(r.text()).result) || {};
    if (res.credit != null) info.credit = res.credit;
    if (res.grade != null) info.grade = res.grade;
    if (res.growth != null) info.growth = res.growth;
  } catch (e) { /* 忽略 */ }

  return info;
}

// 群组首页签到（my.4399.com 每日签到）
async function groupSignIn(jar) {
  const r = await requestFollow(`${MY4399}/plugins/sign/set-t-${Date.now()}`, {
    method: 'GET',
    headers: { 'User-Agent': DEFAULT_UA, 'X-Requested-With': 'XMLHttpRequest' },
  }, jar);
  let j;
  try { j = JSON.parse(r.text()); }
  catch (e) { return { ok: false, message: '签到接口返回异常', raw: r.text().slice(0, 300) }; }
  const code = Number(j.code);
  if (code === 100) return { ok: true, message: '群组签到成功', data: j };
  if (code === 101) return { ok: true, already: true, message: '群组今天已签到过了', data: j };
  if (code === 99) return { ok: false, message: '登录态已失效，请重新登录', data: j };
  return { ok: false, message: j.msg || ('群组签到失败(code ' + j.code + ')'), data: j };
}

// 独家游戏签到（www.4399.com/djyx 礼券签到）
async function gameSignIn(jar) {
  const r = await request(`${HUODONG}/2017/dujia/ajax.php`, {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': 'https://www.4399.com',
      'Referer': 'https://www.4399.com/djyx/',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: 'act=qdao',
    jar,
  });
  const raw = r.text().trim();
  let j;
  try { j = JSON.parse(raw.replace(/^\s*\(/, '').replace(/\)\s*$/, '')); }
  catch (e) { return { ok: false, message: '签到接口返回异常', raw: raw.slice(0, 300) }; }
  if (j.key === 'suc') {
    return { ok: true, message: (j.msg || '独家游戏签到成功').replace(/<br\s*\/?>/gi, ' '), data: j };
  }
  const already = /已经签到/.test(j.msg || '');
  return { ok: already, already, message: j.msg || '独家游戏签到失败', data: j };
}

// ---------------- 个人资料（u.4399.com/profile/） ----------------
// 返回：头像 / 昵称 / 用户名 / 性别 / 生日 / 地区 / QQ / 邮箱 / IP属地 / 认证状态
async function getUserProfile(jar) {
  const url = `${U4399}/profile/`;
  const r = await requestFollow(url, {
    method: 'GET', headers: { 'User-Agent': DEFAULT_UA, 'Referer': url },
  }, jar);
  const html = r.text();
  if (r.status !== 200 || html.length < 200) {
    return { ok: false, message: '无法加载个人资料页 HTTP ' + r.status };
  }

  // 头像：.u_avatar img（//a.img4399.com/<uid>/middle）
  let avatar = null;
  const av = html.match(/class="u_avatar"[\s\S]{0,400}?<img[^>]*\bsrc="([^"]+)"/i);
  if (av && av[1]) avatar = av[1].startsWith('//') ? 'https:' + av[1] : av[1];

  // 认证状态：存在 .v-ok 即已认证
  const verified = /class="[^"]*\bv-ok\b/.test(html);

  // 表格：<td class="label">标签 :</td><td class="input">值</td>
  const fields = {};
  const re = /<td[^>]*class="label"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class="input"[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html))) {
    const label = stripTags(m[1]).replace(/[\s:：]/g, '');
    let val = stripTags(m[2]);
    if (val === '<未填写>' || val === '未填写' || val === '') val = null;
    if (label && !(label in fields)) fields[label] = val;
  }

  const ip = html.match(/IP属地[：:]\s*([^<\s]+)/);
  const emailRaw = fields['邮箱'];
  const email = emailRaw ? emailRaw.replace(/\s*[（(]?\s*已?绑定\s*[)）]?\s*$/, '').trim() : null;

  return {
    ok: true,
    avatar,
    nickname: fields['昵称'] || null,
    username: fields['用户名'] || null,
    gender: fields['性别'] || null,
    birthday: fields['生日'] || null,
    region: fields['地区'] || null,
    qq: fields['QQ'] || null,
    email: email || null,
    ipLocation: ip ? ip[1] : null,
    authStatus: verified ? '已身份认证' : '未认证',
    fields,
  };
}

// ---------------- 账号安全概览（基于 u.4399.com/profile/ 的资料） ----------------
// 说明：4399 未在可访问页面上暴露「密保 / 手机」详情（该页由 JS 异步加载且常返回登录态失效），
// 因此这里只汇总确实可读到的：邮箱(掩码+是否绑定)、QQ(掩码)、身份认证、IP属地等。
async function getSecurityInfo(jar) {
  const p = await getUserProfile(jar);
  if (!p.ok) return p;
  const raw = p.fields || {};
  const emailRaw = raw['邮箱'] || '';
  const qqRaw = raw['QQ'] || '';
  return {
    ok: true,
    username: p.username,
    nickname: p.nickname,
    email: p.email,
    emailBound: /已绑定/.test(emailRaw),
    qq: p.qq,
    qqBound: !!qqRaw,
    gender: p.gender,
    birthday: p.birthday,
    region: p.region,
    ipLocation: p.ipLocation,
    authStatus: p.authStatus,
    avatar: p.avatar,
  };
}

// ---------------- 头像代理（a.img4399.com 有防盗链，需带 Referer） ----------------
async function fetchAvatar(uid) {
  for (const size of ['big', 'middle']) {
    try {
      const r = await request(`${IMG4399}/${encodeURIComponent(uid)}/${size}`, {
        method: 'GET', headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${U4399}/` }, retries: 2,
      });
      if (r.status === 200 && r.body && r.body.length > 0) {
        return { ok: true, contentType: r.headers['content-type'] || 'image/jpeg', body: r.body };
      }
    } catch (e) { /* 尝试下一个尺寸 */ }
  }
  return { ok: false };
}

// ---------------- 游玩历史（gprp.4399.com） ----------------
async function getGameHistory(jar) {
  const r = await request(`${GPRP}/cg/get_gamehistory.php`, {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': MY4399,
      'Referer': MY4399 + '/',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: 'from=index&simple=true&page_size=18',
    jar,
    retries: 2,
  });
  let j;
  try { j = JSON.parse(r.text()); }
  catch (e) { return { ok: false, message: '接口返回异常', raw: r.text().slice(0, 200) }; }
  if (j.login === false) return { ok: false, needLogin: true, message: '登录态已失效，请重新登录' };

  const infos = j.game_infos || {};
  const raw = Array.isArray(j.played_gids) ? j.played_gids : [];
  const abs = (u) => (u && u.startsWith('//') ? 'https:' + u : u);
  // played_gids 是对象数组 [{gid, stars}]，也兼容纯数字数组
  const games = raw.map((item) => {
    const isObj = item && typeof item === 'object';
    const gid = isObj ? item.gid : item;
    const info = infos[gid] || {};
    const name = typeof info.name === 'string' ? info.name
      : (typeof info.game_name === 'string' ? info.game_name : '游戏 ' + gid);
    let url = abs(info.url);
    if (!url && info.playlink) url = info.playlink.startsWith('http') ? info.playlink : (MY4399 + info.playlink);
    return {
      gid: String(gid),
      name,
      stars: isObj && item.stars != null ? item.stars : (info.stars != null ? info.stars : null),
      category: info.tidName || null,
      tags: Array.isArray(info.sList) ? info.sList.map((s) => s && s.sName).filter(Boolean) : [],
      pic: abs(info.pic) || null,
      url: url || null,
    };
  });
  return { ok: true, total: j.total || games.length, games };
}

// ---------------- 区服角色查询（my.4399.com/zhuanti/<缩写>/jscx） ----------------
function normalizeAbbr(abbr) {
  const s = String(abbr || '').trim();
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : null;
}

async function getGameServerOptions(jar, abbr) {
  const game = normalizeAbbr(abbr);
  if (!game) return { ok: false, message: '游戏缩写只能包含字母、数字、短横线和下划线' };
  const url = `${MY4399}/zhuanti/${game}/jscx`;
  const r = await requestFollow(url, {
    method: 'GET', headers: { 'User-Agent': DEFAULT_UA, 'Referer': url },
  }, jar);
  if (r.status !== 200) return { ok: false, message: '加载区服页失败 HTTP ' + r.status };

  const html = r.text();
  const map = new Map();
  const re = /data-sid="(\d+)"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const sid = Number(m[1]);
    const name = stripTags(m[2]);
    if (Number.isInteger(sid) && sid > 0 && name && !map.has(sid)) map.set(sid, name);
  }
  const servers = [...map].map(([sid, name]) => ({ sid, name })).sort((a, b) => a.sid - b.sid);
  if (!servers.length) return { ok: false, message: '未能解析出区服列表，请检查游戏缩写是否正确' };
  return { ok: true, abbr: game, servers };
}

// 区服角色查询：支持并发、真实进度、可取消
// - 默认并发 3；一旦撞到 status:-3（限流）立刻降为串行，串行时仍保持 3.1s 间隔
// - opts.isCancelled() 返回 true 时不再发起新请求（已经在飞的请求让它自然结束）
// - opts.onProgress(done, total, res) 每完成一个区服回调一次，res 为该区服的明细
const ROLE_QUERY_CONCURRENCY = 3;

async function queryGameRoles(jar, abbr, sids, opts = {}) {
  const game = normalizeAbbr(abbr);
  if (!game) return { ok: false, message: '游戏缩写不合法' };
  const list = [...new Set((Array.isArray(sids) ? sids : []).map(Number))]
    .filter((s) => Number.isInteger(s) && s > 0).sort((a, b) => a - b);
  if (!list.length) return { ok: false, message: '请至少选择一个区服' };

  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const maxConc = Math.max(1, Math.min(Number(opts.concurrency) || ROLE_QUERY_CONCURRENCY, 8));

  const base = `${MY4399}/zhuanti/${game}`;
  const roles = [], failures = [], emptyServerIds = [];
  const total = list.length;
  let done = 0, active = Math.min(maxConc, total), lastAt = 0, cancelled = false;

  const one = async (sid) => {
    if (isCancelled()) return { sid, cancelled: true };
    if (active <= 1) {                          // 串行模式：保持 3.1s 间隔
      const wait = ROLE_QUERY_INTERVAL_MS - (Date.now() - lastAt);
      if (lastAt && wait > 0) await sleep(wait);
    }
    lastAt = Date.now();
    try {
      const r = await request(`${base}/jscx-ajaxSearchInfo`, {
        method: 'POST',
        headers: {
          'User-Agent': DEFAULT_UA,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Origin': MY4399,
          'Referer': `${base}/jscx`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: `sid=${sid}&_AJAX_=1`,
        jar,
        retries: 2,
      });
      let j;
      try { j = JSON.parse(r.text()); }
      catch (e) { return { sid, failure: { sid, message: '响应不是有效的 JSON' } }; }
      if (j.status === -3) return { sid, rateLimited: true, failure: { sid, message: '操作过于频繁，请稍后再试' } };
      if (j.status !== 1 || !Array.isArray(j.data)) {
        return { sid, failure: { sid, message: j.msg || '服务端返回的数据格式无效' } };
      }
      if (!j.data.length) return { sid, empty: true };
      return { sid, roles: j.data.map((role) => Object.assign({}, role, { sid: Number(role.sid || sid) })) };
    } catch (e) {
      const msg = (e && e.message) || '查询失败';
      return { sid, failure: { sid, message: msg, timeout: isTimeoutMsg(msg) } };
    }
  };

  // 按「波」推进：波宽 = 当前并发上限，撞到限流就把上限降到 1
  let i = 0;
  while (i < list.length) {
    if (isCancelled()) { cancelled = true; break; }
    const wave = list.slice(i, i + active);
    const results = await Promise.all(wave.map(one));
    i += wave.length;
    let hitLimit = false;
    for (const res of results) {
      if (res.cancelled) { cancelled = true; break; }
      done++;
      if (res.rateLimited) hitLimit = true;
      if (res.roles) for (const role of res.roles) roles.push(role);
      else if (res.empty) emptyServerIds.push(res.sid);
      else if (res.failure) failures.push(res.failure);
      onProgress(done, total, res);
    }
    if (cancelled) break;
    if (hitLimit && active > 1) active = 1;    // 撞限流：剩下的改成串行
  }

  roles.sort((a, b) => a.sid - b.sid);
  return { ok: true, abbr: game, roles, emptyServerIds, failures, done, total, cancelled };
}

// ---------------- 区服查询预设游戏 ----------------
// my.4399.com/zhuanti/<缩写>/jscx 仅对少数游戏开放，以下为实测可用的常用游戏。
// 仍可在界面里手输任意缩写（「自定义」）。
const GAME_PRESETS = [
  { abbr: 'ssjj', name: '生死狙击' },
  { abbr: 'hxjy', name: '火线精英' },
  { abbr: 'msdzls', name: '美食大战老鼠' },
  { abbr: 'pkt', name: '皮卡堂' },
  { abbr: 'sgkd', name: '街机三国' },
  { abbr: 'touch', name: 'Touch触动' },
];

// ---------------- 修改个人资料 / 头像（u.4399.com） ----------------
// 拉取修改页：__HASH__ + 当前昵称/性别/生日
async function getModifyForm(jar) {
  const url = `${U4399}/profile/modify.html`;
  const r = await requestFollow(url, {
    method: 'GET', headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${U4399}/profile/` },
  }, jar);
  const html = r.text();
  if (r.status !== 200 || html.length < 200) return { ok: false, message: '无法加载修改页 HTTP ' + r.status };

  const hash = (html.match(/name="__HASH__"\s+value="([^"]+)"/i) || [])[1] || null;
  let nickname = (html.match(/id="ipt_nick"[^>]*value="([^"]*)"/i) || [])[1];
  if (nickname == null) nickname = (html.match(/name="nick"[^>]*value="([^"]*)"/i) || [])[1] || '';
  const birthday = (html.match(/id="ipt_birthday"[^>]*value="([^"]*)"/i) || [])[1] || '';
  const sex = /id="rad_sex_female"[^>]*checked/i.test(html) ? '2'
    : (/id="rad_sex_male"[^>]*checked/i.test(html) ? '1' : '1');

  return { ok: true, hash, nickname: decodeHtmlEntities(nickname), sex, birthday };
}

// 提交资料修改：只提交修改页表单真实存在的字段（昵称/性别/生日/地区）
async function modifyProfile(jar, params = {}) {
  const form = await getModifyForm(jar);
  if (!form.ok) return { ok: false, message: form.message };

  const birthday = String(params.birthday || form.birthday || '').trim();
  const bd = birthday.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!bd) return { ok: false, message: '生日格式应为 YYYY-MM-DD' };
  const pad = (n) => String(n).padStart(2, '0');

  const body = new URLSearchParams();
  body.set('__HASH__', form.hash || '');
  body.set('birthday', birthday);
  body.set('nick', params.nickname != null && params.nickname !== '' ? params.nickname : form.nickname);
  body.set('sex', params.sex || form.sex || '1');
  body.set('bir_year', bd[1]);
  body.set('bir_month', pad(bd[2]));
  body.set('bir_day', pad(bd[3]));
  if (params.province) body.set('local_province', params.province);
  if (params.city) body.set('local_city', params.city);

  const url = `${U4399}/profile/modify-save.html`;
  const r = await request(url, {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': U4399,
      'Referer': `${U4399}/profile/modify.html`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
    jar,
  });
  let j;
  try { j = JSON.parse(r.text()); }
  catch (e) { return { ok: false, message: '保存返回异常 HTTP ' + r.status, raw: r.text().slice(0, 200) }; }

  if (j.state === true || j.ret === 'succ' || j.c === 200) {
    return { ok: true, message: typeof j.d === 'string' ? j.d : '资料已保存' };
  }
  let message = j.e || (typeof j.d === 'string' ? j.d : null) || '保存失败';
  if (j.c) message += '（code ' + j.c + '）';
  return { ok: false, message, data: j };
}

// 上传头像（multipart，字段名 avatar —— 已实测确认）
async function uploadAvatar(jar, buffer, filename, contentType) {
  if (!buffer || !buffer.length) return { ok: false, message: '图片内容为空' };
  if (buffer.length > 3 * 1024 * 1024) return { ok: false, message: '图片过大（上限约 3MB）' };
  const referer = `${MY4399}/profile/avatar?from=u`;
  const { body, contentType: ct } = buildMultipart({}, [{
    name: 'avatar', filename: filename || 'avatar.jpg',
    contentType: contentType || 'image/jpeg', data: buffer,
  }]);
  const r = await request(`${MY4399}/profile/avatar-upload-from-u`, {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_UA, 'Content-Type': ct,
      'Origin': MY4399, 'Referer': referer, 'X-Requested-With': 'XMLHttpRequest',
    },
    body,
    jar,
  });
  let j;
  try { j = JSON.parse(r.text()); }
  catch (e) { return { ok: false, message: '上传返回异常 HTTP ' + r.status, raw: r.text().slice(0, 200) }; }
  if (j.state === true || j.ret === 'succ' || j.c === 200 || j.code === 100) {
    return { ok: true, message: typeof j.msg === 'string' ? j.msg : '头像已更新', data: j };
  }
  return {
    ok: false,
    message: (typeof j.msg === 'string' ? j.msg : null) || (typeof j.e === 'string' ? j.e : null) || (typeof j.d === 'string' ? j.d : null) || '头像上传失败',
    data: j,
  };
}

// ==================== 注册账号 ====================
const REGISTER_URL = `${PTLOGIN}/ptlogin/register.do`;

function registerBaseFields() {
  return {
    postLoginHandler: 'refreshParent', displayMode: 'embed', bizId: '', appId: 'u4399',
    gameId: '', cid: '', externalLogin: 'qq', aid: '', ref: '',
    css: 'https://uc.img4399.com/root/css/ptlogin.css?a3993b7', redirectUrl: '',
    regMode: 'reg_normal', sessionId: '', regIdcard: 'true', noEmail: '',
    crossDomainIFrame: '', crossDomainUrl: '', mainDivId: 'popup_reg_div',
    showRegInfo: 'true', includeFcmInfo: 'false', expandFcmInput: 'true',
    fcmFakeValidate: 'false', realnameValidate: 'true', userNameLabel: '4399用户名',
    level: '4', sec: '1', reg_eula_agree: 'on',
  };
}

// 注册页会下发会话 cookie；captchaId 只有在需要验证码时才渲染
async function newRegisterJar() {
  const jar = new CookieJar();
  const url = `${REGISTER_URL}?postLoginHandler=refreshParent&displayMode=embed&appId=u4399` +
    `&regMode=reg_normal&regIdcard=true&realnameValidate=true&mainDivId=popup_reg_div`;
  try {
    await requestFollow(url, { method: 'GET', headers: { 'User-Agent': DEFAULT_UA, 'Referer': 'https://www.4399.com/' } }, jar);
  } catch (e) { /* 忽略 */ }
  return jar;
}

function extractCaptchaId(html) {
  const s = String(html || '');
  const m = s.match(/captchaId="(captchaReq[0-9a-zA-Z]+)"/) || s.match(/captchaId=(captchaReq[0-9a-zA-Z]+)/);
  return m ? m[1] : null;
}

async function submitRegister(jar, p) {
  const form = new URLSearchParams();
  const base = registerBaseFields();
  if (p.sessionId) base.sessionId = p.sessionId;
  for (const [k, v] of Object.entries(base)) form.set(k, v);
  form.set('password', p.password);
  form.set('passwordveri', p.password);
  form.set('realname', p.realname);
  form.set('idcard', p.idcard);
  form.set('username', p.username);
  form.set('email', p.qq || '');
  if (p.captcha) form.set('inputCaptcha', p.captcha);

  const r = await request(REGISTER_URL, {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': PTLOGIN,
      'Referer': REGISTER_URL,
    },
    body: form.toString(),
    jar,
  });
  const html = r.text();
  const dom = stripTags(html);
  const captchaId = extractCaptchaId(html);
  // 4399 把具体失败原因放在 <div id="Msg"> 里（如「姓名身份证不匹配」）
  const msgM = html.match(/<div[^>]*id="Msg"[^>]*>([\s\S]*?)<\/div>/i);
  const errorMsg = msgM ? (stripTags(msgM[1]).replace(/\s+/g, ' ').trim() || null) : null;
  const rateLimited = r.status === 202 || /请稍后再试/.test(dom);
  return {
    html, dom, captchaId, errorMsg, rateLimited, status: r.status,
    // 只有拿到真实的 captchaReq 才算需要验证码；模板里的占位符不算
    needCaptcha: !!captchaId,
    captchaError: /验证码错误/.test(html) || /验证码错误/.test(dom),
    success: /注册成功/.test(html) || /注册成功/.test(dom),
    idcardLimit: /超过限制/.test(html) || /超过限制/.test(dom),
    exists: /用户名已存在|已被注册|用户名存在|已经注册/.test(html) || /用户名已存在|已被注册/.test(dom),
  };
}

// ==================== 纯账号密码登录（用于辅助账号） ====================
const LOGIN_DO = `${PTLOGIN}/ptlogin/login.do?v=1`;

function plainLoginBase() {
  return {
    loginFrom: 'uframe', postLoginHandler: '', layoutSelfAdapting: 'true', externalLogin: '',
    displayMode: '', layout: 'vertical', bizId: '', appId: '', gameId: '', css: '',
    redirectUrl: '', sessionId: '', mainDivId: 'embed_login_div', includeFcmInfo: 'false',
    level: '0', regLevel: '0', userNameLabel: '', userNameTip: '', welcomeTip: '', sec: '',
  };
}

async function submitPlainLogin(jar, { username, password, captcha, sessionId }) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(plainLoginBase())) form.set(k, v);
  // 验证码会话 id（captchaReq…）必须回传，否则验证码永远对不上
  if (sessionId) form.set('sessionId', sessionId);
  form.set('password', password);
  form.set('username', username);
  if (captcha) form.set('inputCaptcha', captcha);

  const r = await request(LOGIN_DO, {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': PTLOGIN,
      'Referer': LOGIN_DO,
    },
    body: form.toString(),
    jar,
  });
  const text = r.text();
  const dom = stripTags(text);
  const needCaptcha = /点击图片换一张|inputCaptcha/.test(text);
  const captchaError = /验证码错误/.test(text);
  const ok = !!jar.get('Pauth') && !needCaptcha && !captchaError;
  const sidM = text.match(/name="sessionId"[^>]*value="(captchaReq[0-9a-zA-Z]+)"/i) ||
    text.match(/captchaId=(captchaReq[0-9a-zA-Z]+)/i);
  const rateLimited = r.status === 202 || /请稍后再试/.test(dom);
  return {
    text, dom, status: r.status, ok, needCaptcha, captchaError, rateLimited,
    captchaId: sidM ? sidM[1] : null,
    pwdError: /密码错误/.test(text) || /密码错误/.test(dom),
    noUser: /用户不存在|账号不存在|账号不存在/.test(text) || /用户不存在/.test(dom),
    rechargeDispute: /账号存在充值纠纷/.test(text),
  };
}

// 纯登录的验证码图：必须带上该会话的 captchaReq id
function fetchPlainCaptcha(jar, captchaId) { return fetchCaptchaImage(jar, captchaId || '0'); }

// ==================== 独家：查询实名信息（监护平台 jianhu 流程） ====================
// 参考 4399Morika 2.0 源码整理出的真实流程：
//   1) 带被查账号登录态访问 jianhu/login.html?auth=transfer，跟随 Location 拿到 jhPauth
//   2) POST userCheck-getCheckStatus：直接返回当前绑定状态；已绑定完成时
//      result.post_info.parents 里就是（4399 脱敏后的）实名信息，且 result.kuid 是「辅助账号」的 uid
//   3) 若还没有绑定：POST userCheck-checkUid（body kusername=<辅助账号用户名>）向辅助账号发一条验证消息
//   4) 辅助账号登录后到 my.4399.com/plugins/pm/ 收件箱取 tid → detail-read 取出「账号归属校验链接」
//   5) 辅助账号访问该链接（24 小时有效、只能用一次）完成归属确认
//   6) 再次 getCheckStatus 即拿到实名信息
//   7) 拿到实名后「解除占用」= POST userCheck-reCheckUid（body kuid=<辅助账号 uid>），
//      等同于监护平台 jianhu/home 上的「重新申请」按钮，只释放占用状态，不影响双方实名
const JIANHU = `${U4399}/jianhu`;
const JH_HDR = { 'User-Agent': DEFAULT_UA, 'Referer': `${U4399}/profile/` };
const JH_AJAX = Object.assign({}, JH_HDR, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' });

function jhJson(text) { try { return JSON.parse(text); } catch (e) { return null; } }

// 跟随 3xx 跳转：4399 的归属校验链接是 301 → 302 → 200，不跟随就拿不到结果
async function followGet(url, headers, jar, maxHops = 6) {
  let cur = url;
  let last = null;
  for (let i = 0; i < maxHops; i++) {
    const r = await request(cur, { method: 'GET', headers, jar, retries: 2 });
    last = r;
    if (r.location) { cur = new URL(r.location, cur).toString(); continue; }
    break;
  }
  return last;
}

// 带被查账号登录态换取监护平台完整 cookie（jhPauth）
async function jianhuAuth(jar) {
  const r1 = await request(
    `${U4399}/sso/jianhu/login.html?refer=${encodeURIComponent(`${JIANHU}/api/signstate-author`)}&auth=transfer`,
    { method: 'GET', headers: JH_HDR, jar, retries: 2 },
  );
  if (!r1.location) return { ok: false, message: '监护平台跳转失败（账号登录态可能已失效，请重新登录）' };
  await request(new URL(r1.location, U4399).toString(), { method: 'GET', headers: JH_HDR, jar, retries: 2 });
  return { ok: !!jar.get('jhPauth') };
}

// 当前绑定状态（已完成时含脱敏实名信息 + kuid）
async function getCheckStatus(jar) {
  const raw = (await request(`${JIANHU}/api/userCheck-getCheckStatus`, { method: 'POST', headers: JH_AJAX, body: '', jar, retries: 2 })).text();
  const j = jhJson(raw);
  const res = (j && j.result) || {};
  const p = ((res.post_info || {}).parents) || {};
  return {
    code: j ? j.code : null,
    kuid: res.kuid != null ? String(res.kuid) : null,
    status: res.check_status != null ? Number(res.check_status) : null,
    helperName: res.kusername || null,
    name: p.name || null, idCard: p.id_card || null, phone: p.phone || null,
    isReal: p.is_real, raw,
  };
}

// 解除占用（= 监护平台 jianhu/home 上的「重新申请」）
// 4399 真正的接口是 userCheck-reCheckUid（body: kuid=<getCheckStatus 里的 result.kuid>，必须 form 编码）
async function cancelRealNameCheck(jar, kuid) {
  const raw = (await request(`${JIANHU}/api/userCheck-reCheckUid`, {
    method: 'POST', headers: JH_AJAX, body: 'kuid=' + encodeURIComponent(kuid), jar,
  })).text();
  const j = jhJson(raw);
  const msg = j ? String(j.msg || '') : '';
  return { ok: !!(j && String(j.code) === '100'), msg, raw };
}

// 向辅助账号发起验证消息，返回 kuid
async function startRealNameCheck(jar, helperUsername) {
  const raw = (await request(`${JIANHU}/api/userCheck-checkUid`, {
    method: 'POST', headers: JH_AJAX, body: 'kusername=' + encodeURIComponent(helperUsername), jar,
  })).text();
  const j = jhJson(raw);
  const msg = j ? String(j.msg || j.info || j.error || '') : '';
  const kuid = (j && j.result && j.result.kuid) ? String(j.result.kuid) : null;
  const ok = kuid != null || /验证消息已发送/.test(raw);
  return { ok, kuid, msg, raw };
}

// 辅助账号收件箱里取「账号归属校验链接」
async function fetchCheckLink(helperJar) {
  const pm = (await request(`${MY4399}/plugins/pm/`, { method: 'GET', headers: JH_HDR, jar: helperJar, retries: 2 })).text();
  const tidM = pm.match(/detail-tid-([^-]+)-uid-/);
  if (!tidM) return { ok: false, message: '辅助账号收件箱里没有验证消息（可能已超过 24 小时，或辅助账号不对）' };
  const detail = (await request(
    `${MY4399}/plugins/pm/detail-read?tid=${tidM[1]}&sid=4294967296&maxSid=0&time=-1&dir=0&read=1`,
    { method: 'GET', headers: JH_HDR, jar: helperJar, retries: 2 },
  )).text();
  let dtext = detail;
  const dj = jhJson(detail);
  if (dj && Array.isArray(dj.result)) dtext = dj.result.map((x) => (x && x.message) || '').join('\n');
  const linkM = dtext.match(/https?:\/\/my\.4399\.com\/forums\/jianhu-checkUrl\?transfer=[^"'\s<>\\]+/);
  if (!linkM) return { ok: false, message: '验证消息里没找到归属校验链接' };
  let link = linkM[0];   // 注意：正则没有捕获组，匹配结果在 [0]（原来是 [1]，会拿到 undefined 并在 indexOf 处抛错）
  if (!/[?&]from=4399/.test(link)) link += (link.indexOf('?') >= 0 ? '&' : '?') + 'from=4399';
  return { ok: true, link };
}

// 解除占用 = 监护平台 jianhu/home 上的「重新申请」按钮（userCheck-reCheckUid）。
// 只释放被查账号的「监护申请占用中」状态，不影响双方账号各自的实名认证。
// 查询拿到实名后自动调用，尽力而为：失败也不影响查询结果本身。
async function releaseOccupation(jar, kuid) {
  if (!kuid) return false;
  try {
    const c = await cancelRealNameCheck(jar, kuid);
    return !!c.ok;
  } catch (e) { return false; }
}

/**
 * 查询实名信息（4399 返回的是脱敏数据）。
 * 关键改进：先查 getCheckStatus —— 之前已经绑定过的话，直接就能拿到信息，不需要重发验证消息，
 * 也就不会再出现「已有验证中的账号」卡死的情况。
 * 拿到信息后一律「解除占用（重新申请）」，不把被查账号留在占用状态；
 * 结果由调用方本地缓存，24 小时内直接读缓存，不需要再发验证消息。
 * @param {object} targetJar 被查账号登录态
 * @param {object} helperJar 辅助账号登录态
 * @param {string} helperUsername 辅助账号用户名
 * @param {string} [helperUid] 辅助账号 uid（用于判断挂起的验证是不是当前这个辅助账号）
 * @param {string} [targetUid] 被查账号 uid
 * @param {boolean} [autoRelease] 拿到实名后是否自动解除占用（默认 true）
 */
// 实名查询的步骤标签（前后端共用，用于展示进度）
const RN_STEP_LABELS = ['获取监护平台登录态', '检查绑定状态', '发起验证消息', '辅助账号确认归属', '读取实名信息', '解除占用'];

async function getRealNameInfo(targetJar, helperJar, helperUsername, helperUid, targetUid, autoRelease = true, opts = {}) {
  const release = (kuid) => (autoRelease ? releaseOccupation(targetJar, kuid) : Promise.resolve(false));
  const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  // 每一步开始前先报进度，再检查是否已被取消（取消用异常中断，由调用方捕获）
  const step = (n) => { onProgress(n, RN_STEP_LABELS.length, RN_STEP_LABELS[n - 1]); };
  const halt = () => { if (isCancelled()) throw Object.assign(new Error('已取消'), { cancelled: true }); };

  // 1-2. 监护平台登录态
  step(1); halt();
  const auth = await jianhuAuth(targetJar);
  if (!auth.ok) return { ok: false, message: auth.message || '监护平台登录态获取失败' };

  // 3. 先看是否已有绑定：已完成 → 直接返回脱敏信息（秒出，且不消耗验证消息）
  step(2); halt();
  let st = await getCheckStatus(targetJar);
  if (st.status === 1 && st.name) {
    step(6);
    const released = await release(st.kuid);
    return { ok: true, name: st.name, idCard: st.idCard, phone: st.phone, kuid: st.kuid, helperName: st.helperName, released, via: 'status' };
  }

  // 4. 有挂起的验证：挂起的正是当前辅助账号 → 先去收件箱翻链接；
  //    否则必须先取消，不然会一直卡在「已有验证中的账号」
  let kuid = st.kuid;
  if (st.status === 0) {
    const same = kuid && helperUid && String(kuid) === String(helperUid);
    if (same) {
      step(4); halt();
      const got0 = await fetchCheckLink(helperJar);
      if (got0.ok) {
        await followGet(got0.link, JH_HDR, helperJar);
        st = await getCheckStatus(targetJar);
        if (st.name) {
          step(6);
          const released = await release(st.kuid || kuid);
          return { ok: true, name: st.name, idCard: st.idCard, phone: st.phone, kuid: st.kuid || kuid, helperName: st.helperName, released, via: 'pending' };
        }
      }
    }
    if (kuid) {
      halt();
      const c = await cancelRealNameCheck(targetJar, kuid);
      if (!c.ok && c.msg) return { ok: false, message: '取消上一次挂起的验证失败：' + c.msg };
    }
  }

  // 5. 发起新的验证消息
  if (helperUid && targetUid && String(helperUid) === String(targetUid)) {
    return { ok: false, message: '不能把被查询的账号本人当辅助账号，请在「设置 → 辅助账号」换一个别的账号' };
  }
  step(3); halt();
  const sc = await startRealNameCheck(targetJar, helperUsername);
  if (!sc.ok) {
    let msg = sc.msg || '发起验证失败';
    if (/频繁|不得重复|暂不可用/.test(sc.raw) || /频繁|不得重复|暂不可用/.test(msg)) {
      msg = '查询过于频繁，请稍后再试（4399：一段时间内不得重复获取）';
    } else if (/不可绑定当前登录的账号/.test(msg)) {
      msg = '不能把被查询的账号本人当辅助账号，请在「设置 → 辅助账号」换一个别的账号';
    }
    return { ok: false, message: msg, raw: sc.raw.slice(0, 300) };
  }

  // 6. 辅助账号确认归属（点击验证消息里的链接）
  step(4); halt();
  const got = await fetchCheckLink(helperJar);
  if (!got.ok) return { ok: false, message: got.message, raw: sc.raw.slice(0, 200) };
  await followGet(got.link, JH_HDR, helperJar);

  // 7. 再查一次，拿实名信息，然后解除占用（不把账号留在「监护申请占用中」）
  step(5); halt();
  st = await getCheckStatus(targetJar);
  if (!st.name && !st.idCard) {
    return { ok: false, message: '未获取到实名信息（该账号可能未绑定实名，或验证还没生效）', raw: st.raw.slice(0, 300) };
  }
  const finalKuid = st.kuid || sc.kuid;
  step(6);
  const released = await release(finalKuid);
  return { ok: true, name: st.name, idCard: st.idCard, phone: st.phone, kuid: finalKuid, helperName: st.helperName, released, via: 'fresh' };
}

module.exports = {
  CookieJar, randomState, authUrl, fetchAuthorizePage, submitLogin, fetchCaptchaImage,
  getUserInfo, groupSignIn, gameSignIn, uidFromJar, nickFromJar,
  getUserProfile, getSecurityInfo, fetchAvatar, getGameHistory, getGameServerOptions, queryGameRoles,
  GAME_PRESETS, getModifyForm, modifyProfile, uploadAvatar,
  newRegisterJar, submitRegister, submitPlainLogin, fetchPlainCaptcha, getRealNameInfo, RN_STEP_LABELS,
  ROLE_QUERY_CONCURRENCY, isTimeoutMsg,
  jianhuAuth, getCheckStatus, cancelRealNameCheck, startRealNameCheck, fetchCheckLink,
  CLIENT_ID, REDIRECT_URI, PTLOGIN, MY4399, HUODONG, U4399, IMG4399, GPRP,
};
