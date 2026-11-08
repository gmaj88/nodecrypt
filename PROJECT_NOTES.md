# NodeCrypt 维护者手册（PROJECT_NOTES）

> 更新：2026-11-07。供换设备 / 他人接手使用。

## 1. 架构速览
- `worker/`：Cloudflare Worker（Durable Object `ChatRoom` 承载 WS 房间；静态资源 `dist/`）。
- `client/`：网页前端（Vite 构建 → `dist/`）。
- `uniapp/`：APP 壳（gitignore，不入库）。内嵌 webview 打开站点；`uniapp/utils/push.js` 注册 uniPush 1.0。
- 部署：`npm run build && npm run deploy`（wrangler）。生产域名 `https://ai.aiui.de5.net`（浏览器/APP 默认）。

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
- `GETUI_APP_ID/AppKey/MasterSecret`（个推凭据）
- `GETUI_ANDROID_PACKAGE`=`uni.app.UNI8357253`
- `GETUI_HW_CATEGORY`（可选，默认 `IM`；**注意 2026-11-07 实测后台存着 `MARKETING`，需改回 `IM`，否则华为正式通道吃 2 条/日额度**）
- `GETUI_TEST_MODE`（可选；`1`=所有正式推送走华为测试通道——绕营销额度的临时开关。**实测 OPPO/无厂商通道机在测试模式下也能走个推离线库补投**）
- `GETUI_MAX_CIDS_PER_CHANNEL`（可选，默认 32）：每频道离线推送设备注册上限。防重装重复靠 30 天 TTL 兜底，上限只是保险丝（2026-11-07 从硬编码 2 上调；此前 3 台手机进同一房间只显示 2 台即因 cap=2）。

### 4.1 推送常见现象备忘
- **打开 APP 一次性弹出多条旧通知** = 个推离线库历史积压批量补投（服务端零存储，离线期间内容唯一载体就是通知），一次性消化后恢复正常；"有人进房又收到 N 条"时序巧合，服务端没有任何 join 推送路径。
- **前台静默消失 bug（2026-11-07 修复）**：App.vue 原逻辑"APP 可见就跳过未读计数"，导致手机停在首页时收推送零提示、角标从不出现。修复后：仅当"该消息对应房间正由 webview 前台渲染"（`globalData.activeRoomHash` 比对，chat.vue 桥接上报）才跳过；否则计未读 + 刷新角标 + `plus.push.createMessage` 本地通知（标题 Channel / 有新消息，payload=频道 hash，点击直达房间）。

## 5. 诊断端点
- `GET /api/push-test`：全频道设备列表
- `?hash=<hash>`：单频道；`&push=1` 实推一条（返回全过程 raw/body）；`&test=1` 走测试通道
- `&purge=1`：清设备注册（重装残留 cid）
- `?report=1&cid=<cid>&taskid=<taskId>`：查个推任务明细/报表（单推 detail 需向个推动态申请权限，可能 `no permission`）
- DO 热部署坑：聊天页 WS 不断开时 DO 滞留旧代码——关掉所有聊天页等 10 秒再测。新版判定：不带 push 参数返回 `{channelHash,note}` 简短格式。

## 6. 客户端（uniapp 壳）注意
- `manifest.json`：`"unipush": {"version": "1", "offline": true}`——**offline:true 不可丢**（决定云打包是否集成厂商组件）。
- 通知点击：click 事件 + `checkLaunchMessage`（冷启动兜底）双路；hash 提取失败时仅调试开关（`uni.setStorageSync('@nodecrypt/debug',1)`）下弹诊断窗。
- 频道列表顶角"删除"图标已按用户要求移除（保留长按菜单）。

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
  - APP：`uniapp/pages/index/index.vue` 各输入点 `replace(/\s+/g,'')`；APP 添加频道的"房间名[空格]密码"写法中，空格仅作分隔符，房间名/密码内部不得含空白符。
- **特殊字符（ASCII 标点/符号）已放开**：`!@#$%^&*()-_+=[]{}<>.,;:|\/?` 等均可输入（旧版 web 曾禁 `preventSpaceInput` 内的 ASCII 标点，2026-11-07 放开）。
- 撇号 `'`、中文、emoji、**全角标点（（）！等）**均合法。
- 服务端零校验（盲中继，房间名仅参与 sha256 派生；消息内容另有 DOMPurify 防注入：`util.string.js` 只放行 `<br>`）。
- 消息正文（聊天输入框）无上述限制，任意字符均可。

## 10. i18n 约定（避免"新增文案变英文"的坑）
- 所有面向用户的文案必须走 `client/js/util.i18n.js` 的 `t(key, fallback)`，**en 与 zh 两本词典都要补键**（历史上两本常只补一边 → fallback 英文直出）。
- 禁止模块内自造本地 `t()`（曾致图片过大弹窗英文，已改为全局 i18n `image.too_large`）。

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
