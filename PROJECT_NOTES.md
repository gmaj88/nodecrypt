# NodeCrypt 维护者手册（PROJECT_NOTES）

> 更新：2026-11-09（凭据线上取证核实、§4 重写）。供换设备 / 他人接手使用。

## 1. 项目是什么

	端到端加密（E2EE）匿名聊天系统，支持文字/语音通话/离线推送通知（含 APP 杀进程场景）。由三部分组成：
	
	| 部分 | 说明 | 部署位置 |
	|---|---|---|
	| `client/` | 纯 ES6 网页端（Vite 构建，无框架），聊天页 + 语音通话 | Cloudflare Workers 静态资源（`env.ASSETS`） |
	| `worker/` | 服务端：WebSocket 信令 + ChatRoom Durable Object + 推送/TURN 辅助 API | Cloudflare Workers |
	| `uniapp/` | Android/iOS 壳 APP（HBuilderX 工程）：首页频道列表 + web-view 内嵌网页端 + uniPush 推送监听 + 角标 | HBuilderX 云打包，**不入 git（被 .gitignore 忽略）** |
	
	生产地址：`https://ai.aiui.de5.net`（自定义域名，指向同一个 worker；`https://nodecrypt.gmaj88.workers.dev` 为默认 workers.dev 地址）。
	
### 1.1 架构速览
- `worker/`：Cloudflare Worker（Durable Object `ChatRoom` 承载 WS 房间；静态资源 `dist/`）。
- `client/`：网页前端（Vite 构建 → `dist/`）。
- `uniapp/`：APP 壳（gitignore，不入库）。内嵌 webview 打开站点；`uniapp/utils/push.js` 注册 uniPush 1.0。
- 部署：`npm run build && npm run deploy`（wrangler）。生产域名 `https://ai.aiui.de5.net`（浏览器/APP 默认）。
- 
### 1.2 目录结构（关键文件）
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

### 1.3 加密模型（简述）
- 网页端与 DO 先完成服务端 RSA 握手，再基于房间成员密钥协商出**端到端会话密钥**；服务器只转发密文（`onMessage-server-decrypted` 日志显示的是客户端本地解密后的内容）。
- 语音信令也复用这条加密通道（`{a:'m', t:'voice-offer/answer/ice/...'}`）。
- 推送 payload 里**不含消息内容**，只带频道 hash（`sha256(频道名)`），点击后由客户端拉取该频道。

## 2. 端到端推送链路（核心机制）
- 服务端**盲中继**：推送只含房间 sha256 hash，绝无房间名/消息明文。
- 个推 REST v2 单推 `push/single/cid`；`settings.strategy.default=4`：厂商优先，失败自动落个推离线库（APP 打开补投）——**不要手工双发**。
- 单推返回 `data` 是 `{taskId:{cid:status}}` 二层嵌套；status：`successed_offline`=厂商/离线、`successed_online`=个推在线。
- 华为离线通知必须 `click_type:'intent'` + 包名 + `io.dcloud.PandoraEntry`（DCloud 固定格式），`S.payload=<房间hash64>`——真华为机点击可直达聊天室（已实测）。
- **非华为机型/个推离线库补投路径的 click payload 只有 `{title,content}`、自定义 payload 丢失（实测）** → 服务端把 hash 前 8 位放正文 `[xxxxxxxx]`，客户端从 content 提取做前缀匹配（`uniapp/utils/push.js` extractHash TAG_RE）。
- 华为 IM 自分类：AGC 权益审核通过后，消息仍须携带 `category:"IM"`（options `HW` 路径），否则按营销类 2 条/日/设备频控。
- 测试通道：`pushOptions.testMessage=true`（`?push=1&test=1` 或 wrangler secret `GETUI_TEST_MODE=1` 全量启用）；华为测试消息 1000 条/日，不占营销额度。

## 3. 厂商配置矩阵（三处必须逐字一致）
| 项 | 华为 AGC | DCloud (uni-push 1.0 厂商推送设置) | 个推 (配置管理→应用配置→华为) |
|----|----------|--------------------------------------|--------------------------------|
| AppID | `119677959`（**Android应用** 类型，非 HarmonyOS 应用） | 同左 | 同左 |
| Client Secret | OAuth 2.0 凭据 `6a9fb22f…` | ← 同左（勿填证书指纹！） | ← 同左 |
| 包名 | `uni.app.UNI8357253` | 同左 | 同左 |
| SHA-256 指纹 | DCloud 云端证书指纹 `5C:0D:62:…` | — | — |
| agconnect-services.json | 从 Android 应用详情页下载 | 粘贴进表单（改配置后重新下载更新） | — |
| 回执 | 推送服务→配置→应用回执→回调 `https://thirdrcp-hz.getui.com/hw` | — | — |
| 自分类权益（IM） | 每 AppID 单独审批，换 AppID 要重申请 | — | — |

坑：
- **单击密码错误类问题的历史根因**都在"三处 Secret 不一致/填成指纹/旧 AppID"。
- **厂商离线推送要新打云包才生效**：DCloud 红字"厂商参数修改完成后需重新提交云端打包"。
- Hi 畅享 / 华为智选（WIKO 贴牌）**无 HMS 推送内核**：离线厂商推送天然不可用，消息只能等打开 APP 由个推离线库补投。
- OPPO 离线要求上架商店（个推规则），未配置 OPPO 前杀进程收不到属预期。
-养护：AGC 毕业后维护注意 targetSdkVersion 公告。

## 4. Secrets/环境变量（wrangler）
所有凭据保存于 Cloudflare Workers Secrets（后台）——`npx wrangler secret list` 只能看到**名字**、值不可回读。代码一律从 `env.*` 读取（worker/push.js），**仓库内零硬编码凭据**；`wrangler.toml` 不含任何 secret。

### 4.0 凭据清单（2026-11-09 线上取证核实）
| 变量 | 用途 | 当前值 | 备注 |
|---|---|---|---|
| `GETUI_APP_ID` | 个推 AppID | `fplnURjNWa53RVsqdEDCZ3` | [获取地址](https://dev.dcloud.net.cn/pages/app/push/index) |
| `GETUI_APP_KEY` | 个推 AppKey | `2Kj0MJuOxn9IMCQFZs1L36` | 与 MasterSecret 配对签名才有效，单独泄漏不可冒用 |
| `GETUI_MASTER_SECRET` | 个推 MasterSecret | 仅存后台（明文不记录） | **核心签名凭据**，疑似泄漏须在个推后台轮换；只回显 sha256 指纹（见基线） |
| `GETUI_ANDROID_PACKAGE` | 华为 intent 包名 | `uni.app.UNI8357253` | |
| `GETUI_APP_NAME` | 通知标题 | `Channel` | 缺省 'NodeCrypt' |
| `GETUI_HW_CATEGORY` | 华为消息分类 | `IM` | `IM` 正式；排障临时口径见 13.1/13.3 |
| `GETUI_TEST_MODE` | 华为测试通道开关 | `0` | `1`=排障期临时开（不占营销额度） |
| `GETUI_MAX_CIDS_PER_CHANNEL` | 每频道离线 cid 上限 | 32（默认） | 保险丝；容量满静默淘汰旧 cid 属预期（push.js） |

**指纹基线与取证方法**（接手人自查口径）：
- `GET /api/push-test?hash=<hash>&push=1&cid=<cid>` 回显 `fingerprints.{appId,appKey,masterSecret}`＝三个 secret 各自的 **sha256 hex 指纹**（服务端 `sha256Hex()`，从不回显明文）；
- 2026-11-09 基线：appId=`af582b886c6c271d2bd3dc9ce88436aed9b38735bdf5dc712942313c8891c14a`（＝sha256("fplnURjNWa53RVsqdEDCZ3") ✓）、appKey=`1b3c1d4e41528c3b389ece97076bfaa2db232341f0f4c126a0bbbb4d7feffdad`、masterSecret=`018315f61d17654a90aeb8d4d9c08b3e64d8759f87ee9613335536e52b08a1b6`；
- 更直接的"正确性"证据：同请求 `auth=ok`（getui 鉴权 sign 成功，需三元组互相匹配；2026-11-09 实测 ✓）。

### 4.1 部署
```powershell
# 前置：npx wrangler login（浏览器授权一次）
npm run build          # 构建 client → dist/
npm run deploy         # wrangler 部署 worker + 静态资源（本地直署）
git push origin main   # CI 构建（约 1.5–9 分钟，切换期行为见 13.8）
```
- 当前 Worker 名：`nodecrypt`；DO 绑定：ChatRoom；secrets 见 4.0。
- **部署后 DO 滞留旧代码**：热部署后 DO 内存实例可能继续跑旧版本，先**关闭所有聊天页面（断开 WS）等 10 秒**再测，否则会误判"代码没生效"。
- 临时调试代码（如回显取证）**只走本地 `npm run deploy`**，不留含调试代码的公开提交；随改随署随 `git checkout` 还原。

### 4.2 本地开发小抄
1. 前置一次：`npx wrangler login`（浏览器授权）。
2. 看 secret 名单（值不可回读）：`npx wrangler secret list`。
3. 设置/轮换某个 secret（交互式输入）：`npx wrangler secret put GETUI_APP_ID`。
4. 本地跑 worker：`npx wrangler dev`（DO 用本地模拟）；本地 secrets 放 `.dev.vars`（每行 `KEY=value`，**已被 .gitignore 排除、不入库**）。
5. 本地跑 client：`npm run build`（产物 `dist/`）；`npx wrangler dev` 会带静态资源一起跑。
6. 本地验证生产代码：`npm run build && npm run deploy`（本地直署上生产）——与 `git push` CI 构建同代码则结果一致。

### 4.3 调试开关（浏览器 console）
```js
localStorage.setItem('nodecrypt-debug', '1');   // 开：输出 INFO/EVENT 日志（含解密内容）
localStorage.removeItem('nodecrypt-debug');     // 关（默认）
```
改完刷新页面生效。默认关闭是为了少暴露敏感内容、控制台安静。

### 4.4 推送常见现象备忘
- **通知栏正文显示 JSON（{"title","content","payload"} 长串）**：历史根因是客户端本地通知参数错误（见 13.12，2026-11-09 已修复）；判别法——**推送诊断 raw（首页长按频道）是人话而通知是 JSON**→ 查客户端本机通知代码；两者都是 JSON→ 查服务端透传 payload 形态（13.2 对照表）。
- **打开 APP 一次性弹出多条旧通知** = 个推离线库历史积压批量补投（服务端零存储，离线期间内容唯一载体就是通知），一次性消化后恢复正常；"有人进房又收到 N 条"时序巧合，服务端没有任何 join 推送路径。
- **前台静默消失 bug（2026-11-07 修复）**：App.vue 原逻辑"APP 可见就跳过未读计数"，导致手机停在首页时收推送零提示、角标从不出现。修复后：仅当"该消息对应房间正由 webview 前台渲染"（`globalData.activeRoomHash` 比对，chat.vue 桥接上报）才跳过；否则计未读 + 刷新角标 + `plus.push.createMessage` 本地通知（标题 Channel / 有新消息，payload=频道 hash，点击直达房间）。

### 4.5 公开仓库安全性说明
- **代码公开无碍**：secrets 全部在 Cloudflare/AGC/个推后台；wrangler.toml 无 secret；调试端点常规只回显 sha256 指纹，不回显明文。
- **凭据冒用面**：个推鉴权 sign=sha256(AppKey+时间戳+MasterSecret)——AppID/AppKey 单独泄漏无冒用风险；MasterSecret 与 AGC Client Secret 是轮换底线。
- **内容破解面**：消息密钥由房间成员端到端握手派生，服务器只见密文，推送只含频道 sha256——拿到仓库代码 ≠ 解密内容。
- **现实攻击面**：频道 hash 不可反推名字，但**"频道名+密码"弱组合可被字典试出**（hash 公共、可离线爆破）——正式使用请用强密码/长名字（频道名即随机性补给）。
- **曾经的取证缺口**：AppID/AppKey 明文无从回读，2026-11-09 用一次性本地直署（临时回显后立即还原）取证完毕，方法存档于 4.2/4.1，指纹见 4.0 基线。

## 5. 诊断端点
- `GET /api/push-test` —— 列出所有已注册频道 hash 与设备；
- `GET /api/push-test?hash=<hash>` —— 单频道设备列表；
- `GET /api/push-test?hash=<hash>&purge=1` —— 清空该频道（或不带 hash 清全部）设备注册（清残留重装 cid）；
- `GET /api/push-test?hash=<hash>&push=1` —— **真实下发测试推送**并返回全过程：设备列表、个推鉴权、每个 cid 的 `code/msg/status/delivered/raw/body`、`androidPackage`、`hwCategory`、`vendorBody`；
- `GET /api/push-test?hash=<hash>&push=1&test=1` —— 同上，但走华为**测试通道**（testMessage，不占正式额度）。
- `GET /api/push-test?report=1&cid=<cid>&taskid=<taskId>`：查个推任务明细/报表（单推 detail 需向个推动态申请权限，可能 `no permission`）
- DO 热部署坑：聊天页 WS 不断开时 DO 滞留旧代码——关掉所有聊天页等 10 秒再测。新版判定：不带 push 参数返回 `{channelHash,note}` 简短格式。

## 6. 客户端（uniapp 壳）注意
- `manifest.json`：`"unipush": {"version": "1", "offline": true}`——**offline:true 不可丢**（决定云打包是否集成厂商组件）。
- 通知点击：click 事件 + `checkLaunchMessage`（冷启动兜底）双路；hash 提取失败时仅调试开关（`uni.setStorageSync('@nodecrypt/debug',1)`）下弹诊断窗。
- 频道列表顶角"删除"图标已按用户要求移除（保留长按菜单）。
- **长按菜单（2026-11-09）：`打开/修改昵称/删除`**——"修改频道名"已**永久移除**（改名=重算 hash=实质换新房间，两台手机改名后互相看不到；教训：频道唯一标识是房间名+密码，不要做改名功能）；"推送诊断"经 `SHOW_PUSH_DIAG` 开关隐藏（index.vue 顶部，代码保留随时恢复）。
- 菜单实现用"动作名→函数"映射（勿用固定 tapIndex，删项后索引会错位）。
- **频道密码策略（2026-11-09 二次定稿：创建=名字、加入=链接，密码全程不可见不可输）**：房间唯一标识=房间名（服务端只见 `sha256(房间名)`），密码只参与端到端密钥派生（同名同密码=同房间，这正是分享链接的机制）。绑定行为：
  - **分享链接添加**：密码照链接原样保存（想同房间的正路不变），不弹"复制分享链接"提示（链接本来就有）；
  - **手动新建**：只输房间名（兼容 `#名`，手输密码路径已取消）；密码=36 进制时间戳+随机的隐藏值（≤15 字符，兼容 web 表单上限，永不展示）；创建成功**直接进入聊天室**，APP 端弹一次"复制分享链接给对方"（原生 `uni.showModal`，DOM 弹层盖不住全屏 web-view）；web 端进房成功后弹分享浮层；
  - **同名语义（APP）**：按房间名查重（不看 origin）——本地已有同名 → 直接进入该频道（密码不动、无重复记录）；本地没有同名（哪怕别人占了同名）→ 新建随机密码频道（双方互不可见）；
  - **同名语义（web）**：同会话内重复建名 → "此频道已存在"拦截；**web 房间列表不持久化**（刷新即清空），刷新/换设备后重进必须用分享链接；
  - 密码不出现在任何 UI（列表 meta 只显示 origin·昵称），仅保存在本地频道记录并传给 webview（`p=` 参数）；
  - 分享链接=凭据（密码仅 base64+位移弱混淆，非加密），勿公开发布；
  - 侧栏「创建新的频道」按钮已隐藏（`index.html .join-room display:none`，`openLoginModal` 代码保留）；换房/新建一律回首页或分享链接。

## 7. 性能
- `client/public/_headers`：`/assets/*` immutable 一年缓存（Workers Static Assets 支持），减少 APP 内打开慢。
- App.vue 2.5 秒后 WiFi 下静默预热站点。

## 8. 语音
- WebRTC mesh；播放经 WebAudio 增益（×1/×1.8/×3）；×3 会提示"外放过大易啸叫，建议耳机"。
- 远端音频无声历史根因：WebView 自动播放限制 + 通话音量通道音量小；反射解锁 + 增益解决。

### 8.1 一对一通话（2026-11-07 新增）
- 入口：语音按钮**单击=群呼**（不变），**长按 500ms=弹选人面板**（列出房内除自己以外的成员）。
- 发起方：`startCall(peerId)` 设 `directPeerId`，信令只发给该成员（voice-active/offer 带 `direct:true`）。
- 接听方：**自动接听**——未入会时收到 `direct:true` 的 offer 即加入（getUserMedia 首次会弹麦克风授权，等同确认）；群呼 offer 在未入会时仍被忽略，群呼中收到的 1:1 邀请也忽略。
- 通话中：所有信令（mute/inactive）只发给对端；新成员加入不自动建连；对方 语音挂断/离开房间/连接失败（ICE 重启无效）→ 本端自动退出通话并恢复群呼模式。
- 媒体：WebRTC DTLS-SRTP 点对点，两人可解；信令密文也只有目标成员收到。服务器零改动。
- 相关 i18n 键：`voice.call_direct_hint / direct_pick_title / direct_starting / direct_incoming`。

## 9. 输入限制（web 与 APP 已统一，2026-11-07）
统一规则：**用户名 / 房间名 / 频道密码**三者一致——
- **长度上限 15 字符**（web: input `maxlength=15`；APP: `slice(0,15)`）。
- **禁止空白符**（空格/Tab/全角空格等 `\s`）：
  - web：`ui.js preventSpaceInput`（keydown 拦截 + input 剥离）；
  - APP：`uniapp/pages/index/index.vue` 各输入点 `replace(/\s+/g,'')`；（旧"房间名[空格]密码"写法已随手输密码取消而废止）。
- **特殊字符（ASCII 标点/符号）已放开**：`!@#$%^&*()-_+=[]{}<>.,;:|\/?` 等均可输入（旧版 web 曾禁 `preventSpaceInput` 内的 ASCII 标点，2026-11-07 放开）。
- 撇号 `'`、中文、emoji、**全角标点（（）！等）**均合法。
- 服务端零校验（盲中继，房间名仅参与 sha256 派生；消息内容另有 DOMPurify 防注入：`util.string.js` 只放行 `<br>`）。
- 消息正文（聊天输入框）无上述限制，任意字符均可。

## 10. i18n 约定（避免"新增文案变英文"的坑）
- 所有面向用户的文案必须走 `client/js/util.i18n.js` 的 `t(key, fallback)`，**en 与 zh 两本词典都要补键**（历史上两本常只补一边 → fallback 英文直出）。
- 禁止模块内自造本地 `t()`（曾致图片过大弹窗英文，已改为全局 i18n `image.too_large`）。
- **按钮/提示的动态赋值也要走 i18n**（历史上失败分支硬编码 `'ENTER'` 直出英文，2026-11-09 已改为 `t('ui.enter')`）；`warnTip`/`btn.innerText`/toast 一律 `t()`。
- 2026-11-09 新增键（两本词典已同步）：`ui.password_auto_hint`、`action.share_prompt_title`、`action.share_prompt_desc`、`action.copy_link`；帮助文案（step_password/room_isolation_note/tip_group_chat/tip_security_reminder/tip_password_strategy 等）已改写为"密码自动生成、进房靠分享链接"。

## 10.1 补推说明（2026-11-07 补）
- 其他新增场景已逐字核对：图片过大 alert、设置面板 3 处 alert（含"通知已开启"系统通知正文）、节点断开状态条、一对一通话 5 个键、增益 ×3 啸叫提示——全部入 en/zh 双词典。

## 11. 非华为机型杀进程收消息——路线图（2026-11-07 摸底，暂缓执行）
目标手机：OPPO（ColorOS）+ 旧荣耀畅享（华为智选 WIKO，无 HMS 内核）。**上架商店门槛高，用户决定暂缓，先记录待办**。

### 11.1 原理
杀进程后能否收到取决于三个途径：
1. **厂商系统推送**（HMS / OPUSH / 米推 / 荣耀 Push / FCM）——唯一稳定方案（华为已打通）。
2. **个推 SDK 进程存活**（"个推在线"，依赖自启动+后台白名单）——可用但不稳，ROM 省电策略会杀。
3. **个推离线库补投**（现状：OPPO/荣耀畅享消息等到打开 APP 才补达）。

上游已具备的条件（无需再调）：worker 推送 `strategy.default=4` 厂商优先，接入新厂商后服务端**零改动**自动路由；诊断端点 `/api/push-test?push=1` 看 status。

### 11.2 A 方案：厂商通道接入（正式解，需上架）
| 厂商 | 注册平台 | 是否要求上架自家商店 |
|------|----------|----------------------|
| OPPO/一加/realme | OPUSH 开放服务（AppKey/AppSecret） | **是**（OPPO 软件商店，白名单额度来自上架记录） |
| vivo/iQOO | vivo 开放平台 Push | **是** |
| 荣耀 | 荣耀开发者服务·Push | **是**（荣耀应用市场） |
| 小米/红米 | 小米开放平台·推送 | 否（注册应用即可） |

执行步骤（照做即可）：
1. 对应厂商开放平台注册应用（包名 `uni.app.UNI8357253`）拿 AppID/AppKey/AppSecret。
2. DCloud 后台 uni-push①·0 → 推送通道：逐家填入参数；**改完必须重新云打包**才生效。
3. 个推后台 → 配置管理→应用配置→同步录入厂商参数（参考 §3 华为流程）。
4. 上架商店后额度放开。
5. 云打包重装 → `/api/push-test?hash=…&push=1` 看 status=`successed_offline` 并实测杀进程直弹。

### 11.3 B 方案：用户自启动/后台白名单（零代码过渡）
不给他人手机静默解锁的权限，只能引导（APP 里可放"收不到通知？请允许自启动"图文贴士；跳系统页需原生插件，可后置）：
- **OPPO（ColorOS）**：设置→应用→应用管理→NodeCrypt→耗电管理→允许完全后台行为；「应用启动管理」→ 关闭自动管理 → 允许自启动/后台运行/关联启动。
- **vivo（Funtouch/OriginOS）**：设置→电池→后台耗电管理→允许后台高耗电；i管家→自启动→打开。
- **小米（MIUI）**：安全中心→自启动管理→开；省电策略=无限制。
- **荣耀**：设置→应用→应用启动管理→全部允许；省电优化→允许后台运行。
- 通用：多任务里锁后台；通知管理→允许锁屏/横幅通知。
不推荐：前台服务常驻保活（体验差且仍被新 ROM 杀）、双进程/JobScheduler（15 分钟级延迟，做不了即时消息）。

## 12. 幽灵通知根治与通知日志（2026-11-08，commit 6a350f1）

### 12.1 幽灵通知机制（B/C/D 现象实证）
"手机进聊天室 → 其它手机收到 1/4 条推送"的真正源头：E2E 握手借道消息转发通道。
- 进房时客户端向频道内在线成员发送密钥交换封装（`a:'w'` 公钥广播、`a:'c'` 握手/username、语音信令 `a:'c'`）；
- 服务端转发成功即无条件 `notifyOfflineDevices` → 所有注册离线设备各收一条 "NodeCrypt/有新消息 [hash8]"；
- 推送条数=当时握手中继条数（B=1、C/D=4 稳定复现），与"无人发消息"无关。

### 12.2 修复：`n:0` 意图标记
- **控制类**在加密前 wrapper 加 `n: 0`（NodeCrypt.js 握手/w 公钥广播；util.voice.js 信令）；服务端 `decrypted.n === 0` 时只转发、跳过推送（index.js 两处 notify 调用点）；
- **内容类**（私聊文本/图片/文件 main.js 三处、频道消息 sendChannelMessage）不加标记 → 默认照常推送；
- 兼容性：旧客户端不带标记 → 行为与原来相同（不会丢推送）；webview 每次打开即加载最新 client js，即时生效，无需重新云打包。

### 12.3 服务端通知标题 env 化
`push.js` 常量 `NOTIFY_TITLE='NodeCrypt'` → `notifyTitle(env)`：`GETUI_APP_NAME` 缺省 'NodeCrypt'。
新 secret：`GETUI_APP_NAME=Channel`（APP 改名后推送标题同步为 Channel）。

### 12.4 通知日志（替代被网络封禁的 wrangler Tail）
- `notifyOfflineDevices` 新增 `source` 参数（'private'/'channel'）；
- 每次触发滚动记录到 DO storage `notify-log:{hash}`（上限 30 条：ts、source、skip 原因、devices、逐 cid {ok,code,msg,status}）；
- 拉取：`/api/push-test?hash=<hash>&notifylog=1`（可叠加 `&push=1` 同时返回实时推送诊断）。

### 12.5 Secrets 现状（2026-11-08）
- `GETUI_HW_CATEGORY=IM`（纠正 MARKETING，华为 IM 权益计频；营销类 2 条/日/设备 额度解除）；
- `GETUI_TEST_MODE=0`（关闭测试通道，恢复正式下发语义）；
- `GETUI_APP_NAME=Channel`。

### 12.6 后续验证矩阵（notifylog 对照）
- A'（3 台杀掉、浏览器发内容）：notifylog 应记录 2 单源 'channel'×逐 cid 结果，打开手机离线库补投可见；真华为应突破日 2 条；
- B'/C'/D'（手机进房、浏览器在线）：notifylog 零记录、其它手机零通知（幽灵根除）；
- 角标：真收推送后频道列表角标应显示；仍不显则用 HBuilderX 基座调试看 App.vue receive 回调日志定位。

## 13. 推送链路已知坑与厂商适配矩阵（2026-11-08 定稿，commit b8ebabe）

> 结论先行：杀掉进程推送在**真华为已全链路打通**（横幅+人话正文+点击直达+点击角标）；WIKO/HMS 机型杀掉暂靠 getui 离线库补投（打开即收+角标）；OPPO 未接厂商通道（同补投模式）。以下为全过程的坑与铁律，防重犯。

### 13.1 华为/HMS（真华为 + WIKO 等 HMS 生态机型）
1. **category 键位铁律**：UPS options.HW 里必须用 **android 级**键 `'/message/android/category'`（worker/push.js buildPushBody）。此前误用 notification 级 `/message/android/notification/category`——**华为静默忽略、不报错**，消息被降级为"资讯营销类"：额度 2 条/日/设备，**超额静默吞掉**（下发侧仍回 successed_offline，极具迷惑性），且营销类"静默通知仅通知中心"永不弹横幅。官方消息体结构参考华为 FAQ（`android:{notification:{...},category:"IM"}`）与个推《多厂商参数》`/message/android/category` 条目。
2. **AGC 自分类权益**：IM 等服务与通讯类需 AGC"自分类权益"申请，状态必须是"已通过+**已激活**"（官方流程强调通过后要手动点激活，超期未激活需重申）。权益生效后 category=IM 才被信任；未生效时携带 category 同样按营销类处理。
3. **测试消息**：`GETUI_TEST_MODE=1`（getui 侧 testMessage/target_user_type=1）测试消息 500 条/日**不占营销额度**——调试期用组合 `TEST_MODE=1 + category=适当值` 一律能显示，排障利器；正式环境必须翻回 `TEST_MODE=0`。
4. **厂商通道语义**：下发响应 `successed_offline` 仅代表"厂商/离线通道接单"，**不等于用户可见**（显示失败=HMS 侧静默）。真华为通知类别的"历史/更新的类别"列表，只有真正展示过第一条厂商通知后才会出现。
5. **WIKO（HMS 生态）**：与真华为共用同一 AGC 应用权益，配置对它**自动生效**；实测杀掉仍不出横幅（厂商通道展示未生效，原因待查），当前走 getui 离线库补投（打开即收+角标正常）。

### 13.2 透传 payload 规范（铁律）与 payload 时代对照表
- **现行规范**：`push_message.transmission` = **纯文本** `有新消息 [hash12] YYYY-MM-DD HH:MM`（12 位 tag + 日期时间戳，见 13.13）；厂商通知 title=Channel、body 同文本、intent payload=完整 hash（worker/push.js）。
- **禁止回潮**：payload 含 `title/content` 字段的 JSON（三字段形态）会被个推**自动转成"通知"渲染**且**前台 receive 不再触发**→角标断链（实战定案）。单字段 `{"hash":…}` 虽保 receive，但厂商通知正文会显示整段 JSON，不人话。
- **时代对照表**（判代速查）：
  - `{"title":"channel","content":"有新消息","payload":…}` → 三字段期（82bdb46），receive 断链+厂商通知显示整段 JSON；
  - `{"hash":"ca978…"}` → 单字段期（c558fd0 下线），receive ✓但 JSON 正文；
  - `有新消息 [ca978112]` → 现行（6aa734c 起；2026-11-09 起升级为 `[hash12]`+日期，即 `有新消息 [ca978112ca1b] 2026-11-09 21:05`）；
- **离线库残留**：getui 离线库按入队时的 payload 快照补投；payload 格式更新后**旧快照不会变**，用 TTL=1h（settings.ttl=3600000）自然过期，或整机静置 1h+ 清空后再验。
- 客户端解析：uniapp/utils/push.js extractHash——**先对整串做 `[hash8]` TAG 扫描**（纯文本配套），再看 hash/payload 嵌套字段；云打包需含此版。

### 13.3 Secrets 与诊断工具速查
- `GETUI_APP_NAME=Channel`（通知标题）、`GETUI_HW_CATEGORY=IM`（正式）、`GETUI_TEST_MODE=0`（正式；排障期临时 1）。
- `/api/push-test`：
  - `?hash=<hash>&push=1[&test=1][&cid=<单指定向>]` 下发（&cid= 单机取证，不骚扰其它设备）；
  - `&notifylog=1` 拉取 DO 通知日志（近期 30 条：source/skip/逐 cid status）——替代被禁的 wrangler tail；
  - `&forget=<cid>` 清除注册瘟 cid（20001 自动移除同源）；`&report=1&taskid=…&cid=…` 查任务（AGC 权限可能不足）。
- 客户端：首页长按频道 → 「推送诊断」弹窗 = 本机 cid + 最近 5 条 receive 留痕（hash8/时间/note/**raw 原始消息 300 字**）+ 各频道未读；按钮「复制诊断」一键到剪贴板。
- 现象↔日志对照：`successed_online`=个推在线送达（APP 进程活着）；`successed_offline`+无横幅=先怀疑 **13.1 第 1/2 条**；`successed_offline`+有横幅=厂商链路通。

### 13.4 厂商适配路线图（其它机型杀掉直达的最短路径）
- 通用结论：**每接入一个厂商 = 一次该厂商的权益/键位流程**（AGC/平台申请 + UPS options 键位 + 额度规则），不是逐手机调参。
- **WIKO/HMS**：随华为配置自动生效（见 13.1 第 5 条，横幅待查）。
- **OPPO（暂不接，备查清单）**：OPPO 推送运营平台配 appkey/masterSecret；options.HW 同构改 `options.OP`：`'/category'`（OPUSH 分类）+ `'/notify_level':16`（通知栏+锁屏+横幅+震动+铃声，须"强提醒"申请）+ `channel_id`（自定义渠道，需 APP 端先创建）。getui《多厂商参数》有完整示例。
- **vivo/小米**：同类（vivo classification=1 系统消息+category；小米 channel_id 申请）。

### 13.5 click-角标语义（客户端，防误读）
- 点击通知进入 = **计 1 条未读并保留角标**（App.vue routePushToChannel；30 秒窗口对同 hash 去重，防 click/launch/前台本地通知三路双计）；chat.vue 经 60 秒旗标（pushRouteChannel）跳过进房即清读；用户**正常点入该频道**时才清零（markChannelRead）。
- **receive→click 双计修复（2026-11-09）**：receive 计数时记 `receiveCountedAt[hash前8位]`（内存级），click 计数前检查——同 key **5 分钟内已由 receive 计数则跳过**。此前踩坑：补投 1 条 → 打开角标 1 → 点本地通知 → 知 path 再 +1 → 返首页 2。厂商冷启动点击（进程重启内存无标记）不受影响，照常计 1。
- 前台首页 receive → 角标 +1 + 本地提示（notifyLocalPush）——仅"该房间正被前台 webview 渲染"才跳过计数。

### 13.6 状态快照（2026-11-08 晚）
- 真华为：杀掉→横幅/人话正文/点击直达/返回首页角标=1 ✓ 全通（正式组合 TEST_MODE=0+IM+android 级 category）。
- 三台在首页收推送：角标 ✓；WIKO 补投：打开即收 ✓ 角标 ✓，正文判残留中（13.7）。
- WIKO/OPPO 杀掉：靠 getui 离线库补投（打开即收），厂商横幅未生效（OPPO 未接入；WIKO 待查）。

### 13.7 遗留观察（WIKO 补投正文 JSON）
> （**结论被 13.12 推翻**：JSON 通知是客户端本机通知参数 bug 现造，不是旧通知滞留/重组。仅判定思路留档。）
- WIKO 打开时的补投：receive raw（诊断面板）已是纯文本 `有新消息 [ca978112]`，但通知栏显示的正文仍是 JSON——嫌疑：① 看到的是**通知栏里未清除的旧时代通知**（清通知栏再看最新一条）；② getui 离线补投重组显示。判定法：清空通知栏→杀→发一条→打开→看**置顶最新一条**正文；若仍 JSON，再用诊断 raw 对照（raw 纯文本而通知 JSON=显示层重组，需服务端再适配）。

### 13.8 部署切换须知（CI 切换期间的行为，实测经验）
- **git push 触发 CI 部署约需 1.5–9 分钟**，且**切换期间新旧 Worker 实例并存**：部分请求打到旧版本、部分到新版本，验证返回体时出现"新旧字段混出"属正常现象，需多轮重试确认。
- **实测经验：部署切换期间需所有人退出聊天室（回首页/杀掉 APP）再测试**，否则聊天页面持有的旧 WS/页面状态可能与新版本 isolate 对不上，出现"切换没完成/行为错乱"的假象。测前统一退出聊天室是标准动作。
- 验证部署是否切完：用 `/api/push-test?hash=<hash>&notifylog=1&push=1` 的回显 body 检查最新代码的特征字段（如 notifyBody 时间戳后缀）；连续两次回显一致且含新特征即切换完成。

### 13.9 正文"出生时间戳"判代法（0e110eb 上线生效）
- `notifyBody()` 尾部追加发送时刻 `HH:MM`（+8 时区），透传 payload 与厂商通知 body 同步携带，形如 `有新消息 [ca978112] 19:05`。
- 现场实测：真华为杀掉进程收到的通知**带时间戳且人话** ✓（0e110eb 部署验证通过）；
- WIKO/OPPO 补投期间通知栏出现的 JSON 正文**不带时间戳** → 依判代法初判为**旧时代残留/通知栏滞留**（区分方法：清空通知栏+静置队列 TTL 过期后再看到带新时间戳的人话通知即收官；若清栏后新通知仍 JSON 无时间戳，再走显示层重组对策：透传 payload 仅发 hash8 短串、厂商通知文案与点击 payload 彻底解耦）。

### 13.10 透传 payload 短串化（6aa2b9a——**已撤回，且其"显示层重组"动机被 13.12 推翻**）
- 实证链：receive raw（诊断面板）已是带时间戳人话（`有新消息 [ca978112] 19:16`+），但**非厂商机型通知栏的正文仍显示长 JSON（payload 被截断省略）** → 显示层在重组 payload（个推/DCloud 离线转通知的具体重组机理未开源，无从拦截）。
- 对策：`push_message.transmission` 由人话长文案改为**极短标签** `[hash8] HH:MM`（notifyTag()）；厂商通知 title/body 仍走 notifyBody 人话（华为横幅不受影响）。显示层无论怎么重组，可见内容只剩一行短标签，可读且不误导。
- 客户端无需再改：extractHash 的整串 `[hash8]` TAG 扫描直接匹配 `[ca978112] 19:58` 形态，角标/路由链保持。
- 顺带事实：**APP 已存活时点击"厂商通知"不触发 plus.push click 事件**（点击留痕 note=click 记录为空；冷启动路径 getLaunchAppMessage 已消费）。点击诊断覆盖不完整属已知限制，以通知复位/路由行为为准。
- 判代法补充：通知正文**带新 HH:MM**=本轮新消息；**不带/时间已过**=残留（getui 离线库 TTL=1h 自然过期）。

### 13.11 收口实验与终态（20:2x，6aa2b9a 后回滚为统一人话格式）
> （**"个推离线库/SDK 缓存快照回放"假说已被 13.12 推翻**：用户重装 APP 后 JSON 仍复现，回放解释不成立——那个 JSON 每次都是客户端现造的。仅实验结论留档：A 无自循环 ✓ 仍有效；"终态统一人话"与服务端决策正确不变。）
- **实验 A（清空通知栏+静止 5 分钟）**：无任何自发消息 → 排除"自循环生成"。
- **实验 B（强行停止+重开）**：打开即收到补投，通知栏正文仍为长 JSON（`{"title":"Channel","content":"有新消息","payload":"ca978…"}`，**无时间戳**），而同期 receive raw（诊断面板）均为带时间戳人话 → 实锤：**通知栏 JSON 与当前消息 payload 无关，是个推离线库/SDK 缓存中"三字段时代快照"的回放**（强杀无法清除，疑 GTSDK 侧通知缓存或离线库未 ACK 重投；彻底清除需卸载重装/清除应用数据，代价是本地频道列表与 cid 重注册）。
- **终态服务端格式（用户定稿）**：所有下发链路正文统一人话 `有新消息 [hash8] HH:MM`（transmission 与厂商通知同源 notifyBody；短串化 notifyTag 试验撤回）。
- 当前残留下一步（明日复测项）：① 新消息各端通知正文应为带时间戳人话；② 若 WIKO/OPPO 通知栏 JSON 残留仍在且影响观感，动"卸载重装/清除数据"清缓存（重加频道 a 即可回环）；③ 厂商点击角标链路（13.5）与前台角标（13.6）维持已通状态。

### 13.12 真根因：plus.push.createMessage 参数签名错误（2026-11-09 定案，13.7/13.10/13.11 假说全部推翻）
- **现象收敛**：通知栏 JSON 正文（`{"title":"Channel","content":"有新消息","payload":"ca978…"}`）在 Huawei/WIKO/OPPO 都出现过、重装 APP 仍复现、receive raw（诊断面板）是人话——三条矛盾长期误导排查。
- **根因**：App.vue notifyLocalPush 把 `plus.push.createMessage(content, payload, options)` 三参全传错——① **整对象当第 1 参（content）**→ 原生桥接把对象 JSON 序列化 → 通知正文=对象 JSON 串；② 第 2 参传 `{}` → 点击消息 payload 丢失，点击路由不稳；③ 第 3 参传**回调函数**（应传 options）→ `cover/notifyId/autoCancel` 全部静默失效 → 通知堆叠不覆盖、震动回调从未执行。
- **为何与机型无关**：这段本机通知代码在"APP 存活收到消息"时一律执行（前台首页计数路径 + 打开补投路径），与服务端 payload、个推离线库、厂商通道全部无关；厂商横幅（华为）抢占了注意力，导致 WIKO/OPPO（无横幅）暴露了 JSON。正文无时间戳、payload 是完整 64 位 hash，都来自客户端硬编码与服务端透传 payload 是两回事。
- **修复（App.vue）**：`notifyLocalPush(target, msg)` 按签名三参传值——content=推送原始正文（服务端人话+时间戳，异常形态兜底'有新消息'）、payload=频道完整 hash（click 事件 extractHash 直接命中，点击直达修复）、options={title:'Channel',cover:true,autoCancel:true}；震动改为调用后直接 `uni.vibrateLong()`（此前从未生效）。
- **排查教训**：诊断面板 raw 与通知栏正文是**两条不同来源**（透传 vs 本机通知），比对时必须分别取值；"某种数据结构反复出现"先查**本进程代码现造**的可能，再查外部缓存/服务端——"重装仍复现"本应立刻排除一切本地缓存假说（本可以更早破案，D 测试后重装提醒了这一点）。

### 13.13 hash tag 8→12 位 + 日期时间戳（2026-11-09 定稿）
- **正文格式**：`有新消息 [hash12] YYYY-MM-DD HH:MM`（+8 时区，例 `有新消息 [ca978112ca1b] 2026-11-09 21:05`）——12 位 tag 定案 + 全通知带日期（聊天室内容不变，仅推送链路）。
- **为什么 8→12**：8 位=32-bit，恶意构造同名碰撞分钟级（后果仅路由串频道，不泄密）；12 位=48-bit——几千频道撞车率 ~10⁻⁹、10 万频道 ~0.002%、50% 撞车需 ~2000 万频道；16 位（64-bit 恶意构造不可行）被否决（正文收益比 12 位只多 4 字符）。
- **客户端兼容策略**：`TAG_RE`/`resolveChannel` 接受 **8–64 位 hex**（新 12 位、旧 8 位残留通知、厂商 intent 64 位 payload 全吃）；`store.js incrementUnreadByHash` 加 8–64 位前缀解析（厂商点击回退用正文 tag 时计数不再静默失效）。
- **过渡期**：旧 APK（固定 8 位 TAG_RE）遇 12 位 tag 解析失败 → 回退"单频道"兜底（`resolveChannel` 单频道规则）。部署顺序：服务端 12 位随 git push 生效，手机尽快重打包；全部重打包后过渡即完结。

### 13.14 创建/加入模型改版边界（2026-11-09 定案）
- **模型**：创建=只输房间名（密码自动生成、隐藏、不可输）；加入=分享链接。适用于 web（首页表单）与 APP（"+"添加弹窗）两端一致。
- **同名不同密码 ≠ 隔离推送**（**已于 2026-11-11 改版解决，见 §13.16**）：原状房间/推送路由键是 `sha256(房间名)`，服务端不知道密码——同名不同密码的两个房间消息互通不可见（密钥不同），但**会互相收到"有新消息"提醒/角标**（内容不泄密，仅提醒串频）。现路由键改为 `sha256(房间名 + NUL + 密码)`（web `NodeCrypt.setCredentials` 与 APP `store.js channelHash` 同公式），同名不同密码在 WS 频道、设备注册、离线推送三条链路上**彻底隔离**；同名+同密码（分享链接进入）仍为同一房间。**注意**：hash 输入含密码 → 服务器可见"密码派生标识"（与既有 `sha256(password)` 握手暴露面同量级，密码不可逆推）；改版后旧 hash 下的设备注册失效——APP 本地记录由 `readList()` 迁移重算，但 cid 须**重新进入频道一次**才在新 hash 下注册。
- **web 房间不持久化**：`roomsData` 仅内存；刷新后列表清空，重进必须靠分享链接（浏览器侧可收藏链接当凭据）。APP 端有本地持久化（store.js），不受影响。
- **兼容防线**：`autofillRoomPwd` 对带 r/node 参数（含旧"无密码链接"）打下 `form.dataset.fromLink=1` 旗标——链接进入一律按原凭据进房，绝不生成新密码；仅"手输名字+密码框为空+无旗标"三条件齐备才判定为新建。
- **HTML5 校验坑**：`display:none` 的 input 带 `minlength` 会导致提交时报 "not focusable" 静默失败——隐藏密码框必须去掉 `minlength`（已改）。

### 13.15 在线状态自愈与"静默隐身"可观测性（2026-11-10 定案）
- **症状回顾**：三端同房（电脑浏览器+2 手机 APP），新加入的人约 1 分钟才互相可见；期间**文字消息同样延迟/丢失**，**无任何操作到点自动恢复**；复现点：新加入者看不到别人、别人也看不到他，先来的两人互发正常。
- **根因（不是网速/带宽）**：①客户端 `pong` 被直接忽略（此前 ping 只发不判）——socket 半开/网络瞬时断链时客户端无感知，要等 **OS TCP 重传超时（实测 ~60s）** 才触发 onclose→3s 重连，期间的握手/消息全部滞留或丢失；②服务端 `cleanupOldConnections` 只在**有人新连接**时才跑，且此前先 `delete clients` 后才让 close 回调摘除成员——摘不掉，`channels[]` 残留僵尸 ID 且**不补播成员表**；③成员表 `l` 只由 join/close 触发，握手消息一旦丢包没有重试路径（`l` 分支只对"无条目"的 peer 发 `w`，条目存在但没握完就永远不再发）。
- **客户端自愈（NodeCrypt.js）**：
  - `pingInterval` 20s→**10s**；新增 `lastPongAt` + **pongTimeout=25s 看门狗**（pong 分支更新时间戳；ping 时超期即 `forceReconnect` 走既有 onclose→3s 重连）——最坏不可见时间从 ~60s 压到 ~30s；
  - `visibilitychange`(visible)/`online`/`focus` 触发连通性检查：CONNECTING 不打断（防重连风暴）、CLOSED 立即 `connect()`、OPEN 但 `lastPongAt` 过期先发探测 ping，3s 无 pong 强制重连；
  - `l` 分支对**未完成握手**的条目（缺 `shared` 或 `username`）**复用旧密钥对重发 `w`**；`c` 处理新增"收到 64hex 明文公钥=对方在请求重新握手"识别——条目已有 `shared` 时**用既有 shared 补发 `u`**（服务端重播成员表即可驱动双向重握手）；
  - debug 时间线（`nodecrypt-debug=1`）：connect→open 耗时、pong RTT、`l` 成员数/重发数、close/forceReconnect 原因。
- **服务端对账（worker/index.js）**：
  - `cleanupOldConnections` 先同步从 `channels[]` filter 摘除（保留属主），循环结束对每个受影响频道**补播成员表**，再 close/delete；close 回调同步改用 filter（原 `indexOf+splice` 在 -1 时**会误删最后一个成员**）；
  - 新增 **DO alarm 周期清理**（`cleanupInterval=15s`）：`handleSession` 建新连接时预约、`cleanupOldConnections` 尾部有客户端则续约/无客户端则 `deleteAlarm()`；半开连接不再依赖"下一个 join"才被发现；
  - 心跳语义不变：服务端每条入站消息刷新 `seen`，`seenTimeout` 仍 60s（>60s 静默即按半开处理）。
- **静默隐身可见化（防密码不一致被误读为网络问题）**：
  - 8 秒仍未完成握手的成员 → `onClientPending` 回调 → 系统提示「有成员未能完成加密握手——通常是密码不一致（手动输入房间名而非通过分享链接加入）」（`system.pending_handshake`，每个 peer 一次，secured/left 时清除）；
  - **密码指纹**：分享链接/APP 打开页 URL 追加 `v=`（FNV-1a 32bit 8hex，客户端 `ui.js` 与 APP `codec.js` 算法一致）；接收端与解密出的密码比对（web 在 `autofillRoomPwd`、APP 在粘贴链接时），不符提示"链接可能被改动或截断"（`system.share_verify_failed`）；
  - **频道头部显示指纹徽标**（`.pwd-fp`，8hex、可选中复制）：多端一致=同一加密频道——用于区分"同名不同密码的独立房间"（13.14 的推送串频场景肉眼可判）。
- **语音昵称 bug（顺手修复）**：`util.voice.js` 三处（发起邀请/被叫来电提示/对方离开）只查 `.userName`，而 `userMap` 实际字段是 `.username` → 一对一通话提示显示的是 **clientId**；现按 `userName||username||name||peerId` 兜底。另修 `main.js` 选人面板昵称拼接未 `escapeHTML`（user-controlled XSS 兜底）。
- **遗留（另行立项）**：`handleServerKey` 直接信任服务端发来的 RSA 公钥并写入 `nodecrypt_server_key`（只写不读）——服务端公钥可被 MITM 替换，削弱 E2EE 声明；建议后续做首次连接钉扎（TOFU）+ 公钥指纹显示。

### 13.16 后台推送改版：通知消息 + 可见性主动离线 + 同名隔离（2026-11-11 定案）
- **双根因回顾**：①在线设备收不到推送——`listOfflineDevices` 跳过 `record.online`，聊天页退后台 web-view 存活、WS 不断（`chat.vue` unload 才会断），设备永远"在线"，服务端根本不发；要等 `seenTimeout=60s` 清理才短暂离线。②离线/在线通道都用透传（`push_message.transmission`）——后台 JS 被 Android 冻结后无人创建本地通知，"收不到"；APP 打开才补投。
- **在线通道 transmission → notification**（`worker/push.js buildPushBody`）：`push_message.notification = { title, body, channel_id:'nodecrypt', channel_name:'消息提醒', channel_level:4, ...vendorNotification }`——由个推 SDK/厂商系统原生弹通知栏，**后台冻结也能弹**；`click_type:'intent'` + intent 内 `S.payload=hash` 与厂商通道同构，点击路由复用既有 `extractHash`（intent payload + 正文 `[hash12]` 双保险）。字段合法性经个推官方文档核实（notification 支持 title/body/channel_id/channel_name/channel_level/click_type/intent）。`push_channel`/`options.HW` 未动。
- **可见性主动离线（关键新机制）**：
  - web（`NodeCrypt.js`）：`appHidden` 状态 + `setAppHidden(hidden)`（去重早退）+ `sendVisibility()`（加密控制消息 `{a:'v', p:0/1}`，守卫 `serverShared && isOpen()`）；`visibilitychange` 双向分支（visible 时顺带连通性检查）；重连/入房注册推送 token 后若仍 `appHidden` 补报 `p:0`；`destruct()` 从 `ncInstances` 注册表摘除。
  - Android WebView 的 Page Visibility 不可靠（退后台不触发）→ APP 原生兜底：`chat.vue` 在 `onHide`/`onShow` 经 `evalJS` 调 `window.__ncSetHidden(1/0)`（`$getAppWebview().children()[0]`，文件尾定义一次、fan-out 所有实例、单实例异常不中断）。
  - worker（`index.js`）：action `'v'` → `handleVisibility`（校验 `p` 为 0/1）→ `push.js setDeviceOnline(storage, channelHash, clientId, online)`——只改 `link === clientId` 设备记录的 `online`/`seen`，**不关 WS**；退后台即刻成为离线推送目标，不再等 seenTimeout。
- **未读双计去重（store.js 共享标记）**：同一条消息可能同时经 WS 桥接（chat.vue 页面隐藏时 `incrementUnreadByHash`）与离线推送 receive（App.vue）到达——内存态标记 `markUnreadCounted(hash)`/`wasUnreadCountedWithin(hash, ms)`（hash 前 8 位 hex 为 key，不持久化）：receive/桥接计数前查 **5 秒**窗口；点击路径查 **5 分钟**窗口（原 `receiveCountedAt` 语义，`receiveCountedAt` 机制删除）；厂商冷启动点击无标记照常计 1。
- **App.vue receive 不再弹本地通知**：在线通道已是通知消息，`notifyLocalPush`（`plus.push.createMessage`）会双份——方法整体删除，前台提示=未读计数+桌面角标；`activeRoomHash` 正在渲染时仍跳过计数（WS 已实时送达并标已读）。
- **同名隔离改版（§13.14 收尾）**：路由键改为 `sha256(房间名 + '\u0000' + 密码)`（web `setCredentials` 与 APP `store.js channelHash` 同公式；`credentials.password` 仍为 `sha256(password)`，握手不变；输出仍 64 hex → `[hash12]` 长度不变）。APP 侧 `readList()` 一次性迁移（旧记录按新公式重算回写）；`addOrMergeChannel` 合并更新密码时同步重算 hash。**上线必做**：每个频道重进一次（cid 在新 hash 下重新注册）；测试阶段不留兼容层——旧 APK + 新 web 的同名房间 hash 不一致（可接受）。
- **已知局限（按验证矩阵预期）**：厂商通知点击体无法客户端取证；无厂商通道的机型（OPPO）杀进程/冻结后仍收不到（厂商通道白名单限制）；后台 JS 挂起时首页角标可能滞后、点击通知后补计；补报机制依赖退后台前 WS 存活（已被 kill 则本来就离线，`close` 回调兜底）。
- **验证矩阵（OPPO/WIKO + `/api/push-test?hash=<hash>&notifylog=1&push=1`）**：①首页退后台任意本地频道来消息 → 系统通知栏（需先重进频道一次完成 cid 注册）；②聊天页退后台 5 秒内来消息 → 通知栏；③点通知 → 直达频道且角标正确；④杀进程：OPPO 无（预期）、WIKO 华为横幅；⑤同一消息角标只 +1。
