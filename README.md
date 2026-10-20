# 4399 账号管理器（本地版）

一个**本地运行**的第三方 4399 账号管理小工具：网页前端 + Node.js 后端，**零第三方依赖**（没有 `package.json`，不需要 `npm install`）。
只用于管理**你自己的** 4399 账号，登录态与账号数据全部保存在本机 `data/` 目录，服务只监听 `127.0.0.1`。

> ⚠️ **用途边界**
> 仅限个人自用账号管理，**不含**撞库、批量注册、验证码自动破解、风控绕过。
> 「批量登录」只针对**你自己**已存入本地账号库的账号，且一旦识别到 4399 风控会自动停止并退避。
> 本项目与 4399 官方无关，请自行遵守平台服务条款。

## 功能

### 账号

- **登录**：走 4399 网页 OAuth（`ptlogin.4399.com/oauth2/authorize.do` → `loginAndAuthorize.do`）。需要时弹图形验证码手动输入；已配置 OCR 时优先自动识别，识别失败自动退回手动
- **账号信息**：昵称、UID、头像、积分、等级、成长值、性别、生日、地区、IP 属地、认证状态
- **签到**：群组首页签到（`my.4399.com`）+ 独家游戏签到（`huodong.4399.com`），支持批量签到
- **批量操作**：批量刷新（波浪并发，整波失败自动降为串行）、批量签到、批量登录
- **分组与备注**：账号可归入分组、加备注；列表支持按分组 / IP 属地筛选与排序
- **游玩历史**：读取最近玩过的游戏（图标 / 分类 / 星级）
- **编辑资料**：修改昵称 / 性别 / 生日 / 地区（省 · 市）
- **更换头像**：本地选图上传（转 base64 走本地服务，避免跨域）
- **实名查询**：查询账号实名状态，可自动解除占用，结果本地缓存 24 小时

### 本地账号库

- 单独保存「账号 + 密码」，**密码以 AES-256-GCM 加密落盘**（`data/vault.json`），密钥为 `data/vault.key` 随机 32 字节
- 支持从文本批量导入、文件夹批量导入、单条编辑 / 删除
- 用于「批量登录」把账号灌进管理器，避免一个个手输

### 任务与容错

- 长任务（区服查询、实名查询）走 **Job + 轮询**，可随时取消，已完成的中间结果会保留
- 网络层对**读取类**请求做重试；登录不重试（避免重复提交）
- 识别 4399 限流 / 静默风控后自动停止任务并退避

### 界面

- **三套深色主题**：4399（石墨底 + 品牌橙）、小林家的龙女仆（托尔）、梵高「星空」，全部纯 CSS 变量切换
- 图标走内联矢量路径（无 Emoji、无图标字体）
- 音乐组件：网易云官方外链播放器，悬浮自动展开，**默认暂停**
- 宣传片录制台：`public/promo-studio.html`，用 canvas 动画 + `MediaRecorder` 录制 1920×1080 品牌动效，可选码率，回传保存到 `data/`

### 数据

- **备份**：一键导出账号、分组、配置、本地账号库（密码为**密文**）
- **恢复**：导入合并 / 覆盖
- **清除**：彻底删除 `data/` 下全部内容（含密钥、错误日志、音乐缓存、宣传片）

## 运行

1. 安装 [Node.js](https://nodejs.org/)（18+）
2. 双击 **`启动4399管理器.bat`**
   - 会开一个独立控制台窗口，已有实例在跑时会提示并直接打开浏览器
   - 启动后自动打开 <http://127.0.0.1:8790>
3. 也可以手动执行：`node server.js`

服务只绑定 `127.0.0.1:8790`，同一局域网内其它设备无法访问。

## 目录结构

```
4399-manager/
├─ 启动4399管理器.bat     # 启动器（GBK 编码，带重复实例检测）
├─ server.js              # HTTP 服务 + 全部 API（仅 127.0.0.1:8790）
├─ lib/
│  ├─ http.js             # 极简 HTTP 客户端 + CookieJar + multipart + 重试（零依赖）
│  ├─ 4399.js             # 4399 登录 / 信息 / 签到 / 资料 / 区服 / 实名 协议封装
│  ├─ ocr.js              # 验证码 OCR（32 位桥进程）
│  ├─ extract.js          # 从文本里提取「账号 + 密码」
│  └─ vault-crypto.js     # AES-256-GCM 本地账号库加解密
├─ public/                # 网页前端（原生 HTML/CSS/JS，无构建）
│  ├─ index.html
│  ├─ style.css
│  ├─ app.js
│  ├─ promo-studio.html   # 宣传片录制台
│  ├─ regions.json        # 省 / 市数据
│  └─ theme/              # 三套主题素材
├─ tools/
│  ├─ ocr.dll             # 可选：自训练验证码 OCR 模型
│  ├─ ocrbridge.exe       # 32 位桥进程（编好的）
│  ├─ OcrBridge.cs        # 桥进程源码
│  └─ fetch-assets.js     # 一次性素材下载脚本
└─ data/                  # 运行时生成，已在 .gitignore 中忽略
```

## 数据与安全

| 文件 | 内容 |
|---|---|
| `data/accounts.json` | 账号登录态（**含 cookie**，请勿外传） |
| `data/vault.json` | 本地账号库（密码为 AES-256-GCM 密文） |
| `data/vault.key` | 解密密钥（**32 字节，永不外传**） |
| `data/folders.json` | 分组 |
| `data/config.json` | 配置（辅助账号、音乐组件等） |
| `data/music-cache.json` / `data/music-covers/` | 音乐组件缓存 |
| `data/promo.mp4` | 宣传片（录制台产物） |
| `data/errors.log` | 错误日志 |

- 加密格式：`enc:v1:<base64(iv[12] | tag[16] | ciphertext)>`，无该前缀的按历史明文处理；解不开时返回空串，不抛错
- **备份文件不含 `data/vault.key`**：换机恢复后，本地账号库里原有的密码将无法解密，重新登录一次即可重新写入
- `data/` 已整体加入 `.gitignore`，不会被提交

## API 一览

<details>
<summary>展开</summary>

**账号**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 账号密码登录（可能返回 `needCaptcha`） |
| GET | `/api/captcha?token=` | 刷新图形验证码 |
| GET | `/api/accounts` | 账号列表（不含 cookie） |
| POST | `/api/accounts/bulk` | 批量操作（刷新 / 签到 / 删除等） |
| POST | `/api/accounts/:id/refresh` | 刷新账号信息 |
| POST | `/api/accounts/:id/sign` | 签到（`{type:'group'\|'game'}`） |
| GET | `/api/accounts/:id/history` | 游玩历史 |
| GET | `/api/accounts/:id/roles?abbr=` | 区服列表 |
| POST | `/api/accounts/:id/roles` | 查询角色（`{abbr, sids}`，约 3 秒/区服） |
| GET | `/api/accounts/:id/profile-form` | 拉取修改资料表单 |
| POST | `/api/accounts/:id/profile` | 保存资料（昵称 / 性别 / 生日 / 地区） |
| POST | `/api/accounts/:id/avatar` | 上传头像 |
| POST | `/api/accounts/:id/meta` | 备注 / 分组 |
| POST | `/api/accounts/:id/security` | 安全 / 认证信息 |
| POST | `/api/accounts/:id/realname` | 实名查询（自动解除占用） |
| POST | `/api/accounts/:id/realname-cancel` | 取消实名查询 |
| POST | `/api/accounts/:id/delete` | 删除本地账号 |
| GET | `/api/avatar?uid=` | 头像代理（解决防盗链） |
| POST | `/api/register` | 注册账号 |
| GET | `/api/register/captcha?token=` | 注册验证码 |

**本地账号库**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/vault` | 账号库（密码为**解密后**明文，仅本机） |
| POST | `/api/vault/import` | 导入（含文件夹批量） |
| POST | `/api/vault/bulk` | 批量增删改 |
| POST | `/api/vault/update` | 单条更新 |
| POST | `/api/vault/delete` | 单条删除 |
| POST | `/api/import/extract` | 从文本提取「账号 + 密码」 |

**分组 / 配置 / 数据**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/folders` | 分组列表 / 新建 |
| POST | `/api/folders/:id` | 重命名（`{name}`）或删除（`{action:'delete'}`） |
| GET | `/api/config` | 读取配置 |
| POST | `/api/config/helper` | 保存辅助账号 |
| POST | `/api/config/reset` | 恢复默认配置 |
| GET | `/api/data/summary` | 数据占用统计 |
| POST | `/api/data/wipe` | 彻底清除全部数据 |
| POST | `/api/open-data-dir` | 在资源管理器中打开 `data/` |
| GET | `/api/backup` | 导出备份 |
| POST | `/api/restore` | 导入备份 |

**任务 / 风控 / OCR**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/jobs/:id` | 长任务进度 |
| POST | `/api/jobs/:id/cancel` | 取消长任务 |
| GET | `/api/status` | 系统状态 + 风控统计 |
| POST | `/api/risk/probe` | 探测当前 4399 风控状态 |
| GET | `/api/ocr/status` | OCR 桥状态 |
| POST | `/api/ocr/test` | 用上传图片测试 OCR |
| POST | `/api/ocr/sample` | 用内置样本测试 OCR |

**其它**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/game-presets` | 区服查询预设游戏 |
| GET | `/api/music/meta?id=&type=` | 网易云歌曲 / 歌单元信息 + 本地封面 |
| GET | `/api/music/cover?id=&type=` | 本地封面代理 |
| POST | `/api/music/covers/slim` | 封面瘦身（重取 300×300 JPEG） |
| GET | `/api/about` | 关于信息 |
| GET / POST / DELETE | `/api/promo` | 宣传片读取 / 保存 / 删除 |
| GET | `/media/promo` | 宣传片播放（支持 Range / 206） |

</details>

## 关于验证码 OCR

`tools/ocr.dll` 是一份**自训练的**验证码识别模型（32 位）。64 位 Node 无法直接加载 32 位 DLL，因此通过 `tools/ocrbridge.exe`（源码见 `tools/OcrBridge.cs`）走 stdin/stdout 做桥接。

- 三个文件都在仓库里，开箱可用
- 缺失时不影响主流程：`/api/ocr/status` 会报告不可用，前端自动退回**手动输入验证码**
- 想换模型，把同名 `ocr.dll` 放进 `tools/` 即可（或设环境变量 `OCR_DLL` 指向别处）

## 已知限制

- 区服角色查询接口（`my.4399.com/zhuanti/<缩写>/jscx`）只对少数游戏开放，内置 6 个是实测可用的；其它游戏会提示无法解析
- 每个区服查询约需 3 秒（服务端限流），请按需勾选
- 4399 接口可能随时调整；若登录或签到失效，需要更新 `lib/4399.js` 中的协议实现
- 实名查询按钮需要先在「设置 → 辅助账号」配置好辅助账号
- 修改资料仅支持昵称 / 性别 / 生日 / 地区，**不含** QQ / 邮箱
- 需要实名认证的账号请先在官网完成实名
- 宣传片录制依赖 `MediaRecorder`，录制时标签页必须保持前台（`requestAnimationFrame` 在后台会停止）
- 若某账号 cookie 失效（签到 / 刷新失败），重新登录一次即可

## 素材与版权

- `public/theme/4399/` 的豆娃形象、`public/theme/tohru/` 的龙女仆相关图片，**版权归原权利方**（4399 / 龙女仆制作委员会 / 萌娘百科等），本项目仅作个人学习与界面演示使用，未获授权
- `public/theme/starry/` 使用梵高《星空》（公有领域）
- `tools/ocr.dll` 为本项目自训练模型

如相关权利方认为不妥，请联系删除。

## 许可

代码仅用于个人学习与自用，未授予商业使用许可。
