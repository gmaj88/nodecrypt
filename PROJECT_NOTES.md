# NodeCrypt 项目笔记（维护者手册）

> 目的：让任何人在换设备/接手项目时快速理解本项目的架构、部署方式和踩过坑的地方。
> 最后更新：2026-11-05

---

## 1. 项目是什么

端到端加密（E2EE）匿名聊天系统，支持文字/语音通话/离线推送通知（含 APP 杀进程场景）。由三部分组成：

| 部分 | 说明 | 部署位置 |
|---|---|---|
| `client/` | 纯 ES6 网页端（Vite 构建，无框架），聊天页 + 语音通话 | Cloudflare Workers 静态资源（`env.ASSETS`） |
| `worker/` | 服务端：WebSocket 信令 + ChatRoom Durable Object + 推送/TURN 辅助 API | Cloudflare Workers |
| `uniapp/` | Android/iOS 壳 APP（HBuilderX 工程）：首页频道列表 + web-view 内嵌网页端 + uniPush 推送监听 + 角标 | HBuilderX 云打包，**不入 git（被 .gitignore 忽略）** |

生产地址：`https://ai.aiui.de5.net`（自定义域名，指向同一个 worker；`https://nodecrypt.gmaj88.workers.dev` 为默认 workers.dev 地址）。

## 2. 目录结构（关键文件）

```
worker/
  index.js        # Worker 入口：/api/push-test 诊断端点、/voice-turn 路由、WS upgrade → ChatRoom DO
  chatroom.js     # ChatRoom Durable Object：房间状态、成员、加密握手、消息广播、离线设备注册/触发推送
  push.js         # 个推/厂商推送核心：鉴权、单推 body 组装、设备注册存取、诊断/清理
  voiceTurn.js    # /voice-turn：WebRTC TURN 短时凭据（Metered 静态认证，HMAC-SHA1，实例级缓存 1 小时）
client/
  js/NodeCrypt.js # WebSocket 客户端 + 加密握手 + logEvent（由 debug 开关控制）
  js/room.js      # 房间/成员/信令分发（voice-* 消息在此转给 voiceChat）
  js/chat.js      # 聊天消息渲染；滚动已用 rAF 合批（scheduleScrollToBottom）
  js/util.voice.js# WebRTC P2P mesh 语音：麦克风采集、信令、远端播放、播放增益
  js/util.avatar.js # 用户名→头像 SVG 生成（Map 缓存，>300 清空）
  js/util.i18n.js # 多语言（默认中文）
  index.html      # 主页面骨架（含 voice-call-panel 通话面板）
uniapp/
  App.vue         # APP 生命周期：前台判定、角标（plus.runtime.setBadgeNumber）、push click 路由进房、webview 预热（仅 WiFi、延迟 2.5s）
  pages/chat/chat.vue       # 聊天页：进入即 close 预加载 webview、请求 RECORD_AUDIO/CAMERA 权限、Android 反射放开 webview 自动播放
  pages/index/index.vue     # 首页：频道列表 + 未读角标
  utils/push.js   # uniPush 1.0 监听（click/receive/launch）、cid 注册上报
  utils/config.js # DEFAULT_ORIGIN（必须 https）、默认频道
  manifest.json   # 必须保持 "unipush": { "version": "1", "offline": true }（勿改成 2.0）
```

## 3. 加密模型（简述）

- 网页端与 DO 先完成服务端 RSA 握手，再基于房间成员密钥协商出**端到端会话密钥**；服务器只转发密文（`onMessage-server-decrypted` 日志显示的是客户端本地解密后的内容）。
- 语音信令也复用这条加密通道（`{a:'m', t:'voice-offer/answer/ice/...'}`）。
- 推送 payload 里**不含消息内容**，只带频道 hash（`sha256(频道名)`），点击后由客户端拉取该频道。

## 4. 推送链路（踩坑最多的部分）

### 4.1 组件与流程
1. APP（uniapp）启动/进房时，通过 URL 参数把个推 cid 上报给网页端 → 客户端经加密通道向 DO 注册 `devices:<hash> -> {cid: seen}`。
2. DO 房间收到消息时，对所有离线（WS 断开）且"新鲜"（`deviceRecordTtl`）的设备调用 `worker/push.js → notifyOfflineDevices`。
3. 对每个 cid 调个推 REST V2 `/push/single/cid`，body 包含：
   - `push_message.notification`（个推在线通道通知，`click_type: startapp`，payload=频道 hash）
   - `push_channel.android.ups`（厂商离线通知，`click_type: intent`，intent 指向 APP 包名 Activity 并携带 `S.payload=<hash>`）
   - `settings: { ttl, strategy: { default: 4 } }` —— **个推通道策略 4 = 厂商优先、失败自动退回个推离线库**（服务端原生兜底，单条消息绝不重复下发。不要手工发两条！）
4. iOS：`push_channel.ios`（aps + auto_badge +1）。

### 4.2 必配 Secrets（Cloudflare Worker "nodecrypt"）
- `GETUI_APP_ID` / `GETUI_APP_KEY` / `GETUI_MASTER_SECRET` —— 个推开发者中心
- `GETUI_ANDROID_PACKAGE` —— Android 包名（当前 `uni.app.UNI8357253`）。用于拼厂商点击 intent；**缺失时厂商通知点击只能"打开首页"，无法直达房间**。
- `GETUI_HW_CATEGORY`（可选）—— 华为通知自分类 category，默认 `IM`（即时聊天）

设置方式：`echo <值> | npx wrangler secret put <名称>`（或 dashboard）。设置后立即生效。

### 4.3 uniPush 1.0 厂商通道要求（华为为例）
1. DCloud 开发者中心 → uni-push 1.0 → 应用配置：填华为 AppID/SecretKey/包名，上传 AGC 下载的 `agconnect-services.json`；
2. AGC 后台需先开通推送服务，并填入云打包证书的 SHA256 指纹（云端证书也可）；
3. app 包名、DCloud 后台配置、 manifested 包名三者一致；
4. **必须正式证书/云端证书云打包**（标准基座/调试包收不到厂商离线消息）；
5. manifest 必须保留 `"unipush": { "version": "1", "offline": true }`；
6. 手机端 HMS Core 较新 + 通知权限（含"营销通知"）开启。

### 4.4 额度与限制
- 厂商公信消息 **约 2 条/日/设备**（华为"资讯营销类"频控）。
- **华为通知自分类权益申请通过 ≠ 额度自动生效**：必须推送消息携带 `category: "IM"`（"即时聊天"场景），才按"服务与通讯类"计（数量不受限）。已在服务端 HW options 携带（缺省 IM，可用 `GETUI_HW_CATEGORY` 覆盖）。
- 诊断端点可用 `?push=1&test=1` 携带 `pushOptions.testMessage: true` 走**华为测试通道**（每应用每日 1000 条，不占正式额度，仅测试用途，正式推送绝不携带）。
- 额度耗尽或厂商拒绝时：策略 4 自动退回个推离线库 → **表现为"打开 APP 才收到"**，注意别把它误判为"厂商通道没配通"。
- 判断厂商通道是否真通，看 `/api/push-test` 返回的 `status: "successed_offline"`（嵌套结构 `data[taskId][cid]`）。

### 4.5 诊断端点（临时，可用后可移除）
- `GET /api/push-test` —— 列出所有已注册频道 hash 与设备；
- `GET /api/push-test?hash=<hash>` —— 单频道设备列表；
- `GET /api/push-test?hash=<hash>&purge=1` —— 清空该频道（或不带 hash 清全部）设备注册（清残留重装 cid）；
- `GET /api/push-test?hash=<hash>&push=1` —— **真实下发测试推送**并返回全过程：设备列表、个推鉴权、每个 cid 的 `code/msg/status/delivered/raw/body`、`androidPackage`、`hwCategory`、`vendorBody`；
- `GET /api/push-test?hash=<hash>&push=1&test=1` —— 同上，但走华为**测试通道**（testMessage，不占正式额度）。
- AGC 后台无法直接对设备发"测试消息"（面向 token 的运营推送需要 device token，uniapp 应用不便提取）；验证厂商链路用 push-test 端点即可（等价个推单推→华为）。

## 5. 语音通话

- 架构：WebRTC **P2P mesh**（每个房间成员与其他成员各建一条 `RTCPeerConnection`），STUN 用 Google 公共；蜂窝 NAT 走 TURN `/voice-turn`（Metered，服务端已配好凭据，勿删密钥）。
- 麦克风失败不退场：自动转"仅听模式"（`recvonly` transceiver）。
- 播放双通道：`<audio srcObject>` + WebAudio 兜底（WebView 自动播放限制）；Android webview 已反射 `setMediaPlaybackRequiresUserGesture(false)`（chat.vue）。
- **音量偏小**是 Android WebView 的 WebRTC 走"通话音量"通道所致：通话面板有喇叭按钮 ×1/×1.8/×3 软件增益；同时提示用户把系统"通话音量"拉满。
- 常见坑：安装新包后系统麦克风权限会重置，需重新授权；ICE 故障有 `iceRestart` 自动重试（`util.voice.js`）。

## 6. 部署

```powershell
# 前置：npx wrangler login（浏览器授权一次）
npm run build          # 构建 client → dist/
npm run deploy         # wrangler 部署 worker + 静态资源
git push origin main   # 用户已配置 git 自动部署（推main后 Cloudflare 会重新构建）
```

- 当前 Worker 名：`nodecrypt`；DO 绑定：ChatRoom；环境变量/secrets 见 4.2。
- **部署后 Durable Object 滞留旧代码**：热部署后 DO 内存实例可能继续跑旧版本，先**关闭所有聊天页面（断开 WS）等 10 秒**再测，否则会误判"代码没生效"。

## 7. 调试开关（浏览器 console）

```js
localStorage.setItem('nodecrypt-debug', '1');   // 开：输出 INFO/EVENT 日志（含解密内容）
localStorage.removeItem('nodecrypt-debug');     // 关（默认）
```
改完刷新页面生效。默认关闭是为了少暴露敏感内容、控制台安静。

## 8. 历史问题备忘（已解决，防复发）

| 问题 | 根因 | 处理 |
|---|---|---|
| 聊天界面滚动卡顿 | 直赋 scrollTop 触发布局抖动 | `scheduleScrollToBottom()` rAF 合批（chat.js） |
| 杀进程收不到推送 | 个推单推未带 `push_channel` + 厂商通道未配 | 服务端补 push_channel + DCloud 后台配华为厂商 |
| 点击通知不进房 | 厂商通道 `click_type: startapp` 且缺包名 | 改为 `intent` + `GETUI_ANDROID_PACKAGE` secret |
| 重复推送/误判失败 | 解析个推返回嵌套结构错误 + 手工兜底双发 | 修 nested 解析 + 个推策略 4 原生兜底 |
| 华为自分类权益通过仍被 2 条/日 频控 | 推送未携带 category 字段 | 服务端 HW options 携带 `notification/category: IM` |
| APP 语音无声 | Android WebView 播放/采集链路 | 反射放开 autoplay + 手势解锁 AudioContext + 双通道播放 |
| 语音音量小 | WebRTC 走通话音量通道 | 面板 ×1/×1.8/×3 增益按钮 + 提醒通话音量条 |
| 控制台刷屏（INFO 密文/解密内容） | `main.js` 里 `debug: true` 硬编码 | 改为 `localStorage` 开关，默认关 |

## 9. 本地开发小抄

- `wrangler dev` 本地跑 worker（DO 用本地模拟）；client 用 `npm run build` 产物，或走 vite dev server + 反代（按仓库原脚本）。
- `wrangler.toml`/`wrangler.jsonc` 无需提交 secrets；已配置的 secret 用 `npx wrangler secret list` 查看（只显示名字）。

## 10. 未完成/后续可做（截至本更新）

- `/api/push-test` 诊断端点属临时工具，稳定后可精简或下线。
- 华为"自分类权益"申请（提高公信额度）尚未做；未申请前公信消息 2 条/日/设备。
- iOS 端推送（APN 证书/商户号）尚未配置，目前仅安卓链路验证过。
- 频道 `a` 的 hash `ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb`（= sha256("a")）可用作测试房间。
