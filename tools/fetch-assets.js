'use strict';
// 一次性脚本：从萌娘百科下载「小林家的龙女仆」主题资源到 public/theme/tohru/
// 仅用于本地个人主题，运行时不需要联网。
// 说明：主题现在只用下面这一个素材。
//   · kv-tohru.png（顶栏主视觉）是从萌娘百科原图本地裁切得到的，不在此脚本范围内；
//   · 早前下载过的 kv.png / kv-s1.jpg / logo.png / canna.png / elma.png / tohru.png / kanna.png
//     都已随主题精简删除，不再需要，所以从列表里去掉了。
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'theme', 'tohru');
fs.mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://mzh.moegirl.org.cn/' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(download(new URL(r.headers.location, url).href, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode + ' ' + url)); }
      const chunks = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve({ buf: Buffer.concat(chunks), type: r.headers['content-type'] || '' }));
    }).on('error', reject);
  });
}

// [文件页名称, 输出文件名]
const FILES = [
  ['KobayashiLogo.png', 'logo-kobayashi.png'],
];

(async () => {
  for (const [name, out] of FILES) {
    const url = 'https://mzh.moegirl.org.cn/Special:FilePath/' + encodeURIComponent(name);
    try {
      const { buf, type } = await download(url);
      if (!/image\//.test(type)) { console.log('跳过(非图片)', name, type); continue; }
      fs.writeFileSync(path.join(OUT, out), buf);
      console.log('OK', out, buf.length, 'bytes', type);
    } catch (e) {
      console.log('失败', name, e.message);
    }
  }
})();
