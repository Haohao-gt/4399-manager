'use strict';
// 从杂乱的文本中批量提取「账号 + 密码」。
// 兼容多种编码（UTF-8 / UTF-8 BOM / GBK / UTF-16LE）与多种书写格式。

// ---- 编码嗅探：返回 { enc, text } ----
function readSmartBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { enc: 'utf16le', text: buf.slice(2).toString('utf16le') };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    // UTF-16BE：交换字节后按 LE 解码
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return { enc: 'utf16be', text: swapped.toString('utf16le') };
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { enc: 'utf8-bom', text: buf.slice(3).toString('utf8') };
  try { return { enc: 'utf8', text: new TextDecoder('utf-8', { fatal: true }).decode(buf) }; } catch (e) { /* 继续 */ }
  try { return { enc: 'gbk', text: new TextDecoder('gbk').decode(buf) }; } catch (e) { /* 继续 */ }
  return { enc: 'latin1', text: buf.toString('latin1') };
}

// 标签（其后必须紧跟冒号）
const RE_ACCT = /^(?:账号|帐号|用户名|账户|登陆名|登录名|帐)\s*[:：]\s*(.+)$/;
const RE_PWD = /^(?:密码|密\s*码|密)\s*[:：]\s*(.+)$/;
const RE_BARE_ACCT = /^[A-Za-z0-9_]{3,24}$/;
const RE_BARE_PWD = /^[\x21-\x7e]{3,24}$/;
const RE_SEP = /^([A-Za-z0-9_]{3,24})\s*-{2,}\s*([\x21-\x7e]{3,24})$/;
const NOISE = /^(id|qq|区服|昵称|性别|生日|地区|手机|邮箱|实名|姓名|身份证|等级|大区|角色|问题|答案|密保)/i;

function normLine(l) {
  return String(l || '').replace(/[\u2014\u2013\uFF0D]/g, '-').trim();
}
// 去掉密码尾部误带的“--其他信息”
function cleanPass(p) {
  return String(p || '').split(/-{2,}/)[0].trim();
}

function extractPairs(text) {
  const pairs = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/).map(normLine);
  let pending = null;
  const push = (u, p, how) => {
    u = String(u || '').trim();
    p = cleanPass(p);
    if (!u || !p) return;
    if (!RE_BARE_ACCT.test(u)) return;
    if (!RE_BARE_PWD.test(p)) return;
    if (NOISE.test(u)) return;
    const k = u + '\u0000' + p;
    if (seen.has(k)) return;
    seen.add(k);
    pairs.push({ user: u, pass: p, how });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // 1) 同一行里同时出现「账号…密码…」
    const ia = line.search(/(?:账号|帐号|用户名|账户|帐)\s*[:：]?/);
    const ip = line.search(/(?:密码|密\s*码|密)\s*[:：]?/);
    if (ia >= 0 && ip > ia) {
      const seg = line.slice(ia, ip);
      const mu = seg.match(/^(?:账号|帐号|用户名|账户|帐)\s*[:：]?\s*([A-Za-z0-9_]{3,24})/);
      const mp = line.slice(ip).match(/^(?:密码|密\s*码|密)\s*[:：]?\s*([\x21-\x7e]{3,24})/);
      if (mu && mp) { push(mu[1], mp[1], '同行标签'); continue; }
    }

    // 2) 纯分隔符：账号----密码
    const ms = line.match(RE_SEP);
    if (ms) { push(ms[1], ms[2], '分隔符'); continue; }

    // 3) 账号标签行（可能同行还带密码）
    const ma = line.match(RE_ACCT);
    if (ma) {
      const v = ma[1].trim();
      const mp2 = v.match(/^(.*?)\s*(?:密码|密\s*码|密)\s*[:：]?\s*([\x21-\x7e]{3,24})$/);
      if (mp2) { push(mp2[1].trim().replace(/[-:：\s]+$/, ''), mp2[2], '同行标签'); continue; }
      if (RE_BARE_ACCT.test(v)) pending = v;
      continue;
    }

    // 4) 密码标签行
    const mp = line.match(RE_PWD);
    if (mp) {
      const v = mp[1].trim();
      if (pending) { push(pending, v, '分两行'); pending = null; }
      continue;
    }

    // 5) 裸相邻两行：账号一行、密码一行
    if (RE_BARE_ACCT.test(line) && i + 1 < lines.length) {
      const nxt = lines[i + 1];
      if (RE_BARE_PWD.test(nxt) && !NOISE.test(nxt)) push(line, nxt, '相邻两行');
    }
  }
  return pairs;
}

module.exports = { readSmartBuffer, extractPairs };
