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
- `GETUI_HW_CATEGORY`（可选，默认 `IM`）
- `GETUI_TEST_MODE`（可选；`1`=所有正式推送走华为测试通道——绕营销额度的临时开关）

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
