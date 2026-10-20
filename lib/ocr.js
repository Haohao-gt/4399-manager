'use strict';
// 验证码 OCR：通过 32 位桥进程加载用户自训练的 ocr.dll
// 主程序是 64 位 Node，无法直接加载 32 位 DLL，所以用 tools/ocrbridge.exe 做桥。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BRIDGE = path.join(__dirname, '..', 'tools', 'ocrbridge.exe');
// 模型固定放在工程内的 tools/ 下（自包含）；也可用环境变量 OCR_DLL 指向别处
const LOCAL_DLL = path.join(__dirname, '..', 'tools', 'ocr.dll');

let child = null;
let ready = false;
let starting = null;
let lastError = null;
let buf = '';
let pending = [];

function dllPath() {
  if (process.env.OCR_DLL) return process.env.OCR_DLL;
  return LOCAL_DLL;
}
function available() { return ready; }
function status() {
  return { ready, error: lastError, dll: dllPath(), bridgeExists: fs.existsSync(BRIDGE), dllExists: fs.existsSync(dllPath()) };
}

function drain() {
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    let line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === 'READY') { ready = true; continue; }
    const p = pending.shift();
    if (p) { clearTimeout(p.timer); p.resolve(line); }
  }
}

function start() {
  if (starting) return starting;
  starting = new Promise((resolve) => {
    if (!fs.existsSync(BRIDGE)) { lastError = '缺少 tools/ocrbridge.exe'; ready = false; return resolve(false); }
    if (!fs.existsSync(dllPath())) { lastError = '找不到 ocr.dll：' + dllPath(); ready = false; return resolve(false); }
    try {
      child = spawn(BRIDGE, [dllPath()], {
        windowsHide: true,
        env: Object.assign({}, process.env, { GLOG_minloglevel: '3', GLOG_logtostderr: '0' }),
      });
    } catch (e) { lastError = e.message; ready = false; return resolve(false); }

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 3000) stderr = stderr.slice(-3000); });
    child.stdout.on('data', (d) => { buf += d.toString('utf8'); drain(); });
    child.on('error', (e) => { lastError = 'OCR 桥启动失败：' + e.message; ready = false; });
    child.on('exit', (code) => {
      ready = false; child = null; starting = null;
      lastError = 'OCR 桥已退出(code=' + code + ')' + (stderr ? ' ' + stderr.split('\n').filter(Boolean).slice(-2).join(' ') : '');
      const list = pending; pending = [];
      list.forEach((x) => { clearTimeout(x.timer); x.reject(new Error(lastError)); });
    });

    const t0 = Date.now();
    const timer = setInterval(() => {
      if (ready) { clearInterval(timer); resolve(true); }
      else if (!child) { clearInterval(timer); resolve(false); }
      else if (Date.now() - t0 > 30000) { clearInterval(timer); lastError = 'OCR 桥启动超时'; resolve(false); }
    }, 120);
  });
  return starting;
}

function recognize(buffer) {
  return new Promise((resolve, reject) => {
    if (!ready || !child) return reject(new Error(lastError || 'OCR 未就绪'));
    const item = { resolve, reject, timer: null };
    item.timer = setTimeout(() => {
      const i = pending.indexOf(item);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error('OCR 识别超时'));
    }, 25000);
    pending.push(item);
    try { child.stdin.write(Buffer.from(buffer).toString('base64') + '\n'); }
    catch (e) { pending.pop(); clearTimeout(item.timer); reject(e); }
  });
}

// 传 data url 或纯 base64
async function recognizeDataUrl(dataUrl) {
  const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(String(dataUrl || ''));
  const b64 = m ? m[1] : String(dataUrl || '');
  return recognize(Buffer.from(b64, 'base64'));
}

// 识别并校验长度（4399 验证码固定 4 位，不区分大小写）
async function recognizeCaptcha(dataUrl) {
  const text = (await recognizeDataUrl(dataUrl)).trim();
  if (!/^[0-9a-zA-Z]{4}$/.test(text)) return null;
  return text;
}

function stop() {
  try { if (child) { child.stdin.write('QUIT\n'); setTimeout(() => { try { child.kill(); } catch (e) { } }, 300); } } catch (e) { }
}

module.exports = { start, available, status, recognize, recognizeDataUrl, recognizeCaptcha, stop, dllPath, BRIDGE };
