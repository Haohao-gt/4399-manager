'use strict';
// 本地账号库密码的「静态加密」（仅存本机，不出本机）
// ------------------------------------------------------------------
// 方案：AES-256-GCM（Node 内置 crypto，零依赖）
//   · 密钥：首次运行时随机生成 32 字节，写入 data/vault.key（权限 0600）
//   · 密文格式：enc:v1:<base64(iv[12] | authTag[16] | ciphertext)>
//   · 读取时若发现没有 enc:v1: 前缀，按历史明文原样返回（便于一次性迁移）
// 注意：密钥文件 data/vault.key 不进备份、不随备份导出；
//       换机恢复备份后，旧条目的密码无法解出（这是刻意选择的安全取舍）。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function createVaultCrypto(keyFile) {
  let key = null;

  function loadKey() {
    if (key) return key;
    try {
      const raw = fs.readFileSync(keyFile);
      if (raw && raw.length >= KEY_LEN) { key = raw.subarray(0, KEY_LEN); return key; }
    } catch (e) { /* 首次运行或文件损坏 → 重新生成 */ }
    key = crypto.randomBytes(KEY_LEN);
    try {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
    } catch (e) { /* 落盘失败时仍可用内存中的密钥工作 */ }
    return key;
  }

  // 明文 → 密文（空串保持空串）
  function encrypt(plain) {
    const text = String(plain == null ? '' : plain);
    if (!text) return '';
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
    const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
  }

  // 密文 → 明文；历史明文原样返回；解不开返回空串（不抛错）
  function decrypt(stored) {
    const s = String(stored == null ? '' : stored);
    if (!s) return '';
    if (s.indexOf(PREFIX) !== 0) return s;   // 历史明文
    try {
      const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
      if (buf.length < IV_LEN + TAG_LEN) return '';
      const iv = buf.subarray(0, IV_LEN);
      const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const ct = buf.subarray(IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch (e) {
      return '';
    }
  }

  function isEncrypted(stored) {
    return String(stored == null ? '' : stored).indexOf(PREFIX) === 0;
  }

  return { encrypt, decrypt, isEncrypted, PREFIX };
}

module.exports = { createVaultCrypto, PREFIX };
