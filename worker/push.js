// 离线推送适配器（uniPush 1.0 / 个推 REST v2）
// Offline push adapter for uniPush 1.0 (Getui REST API v2)
// 设计原则：服务器是盲中继 —— 推送内容不含消息明文、不含房间名，只有房间哈希（与加入房间时上报的一致）
// Design principle: server is a blind relay - push body carries no message plaintext, no room name,
// only the room hash (the same value reported at room join).

const GETUI_REST_BASE = 'https://restapi.getui.com/v2';
const deviceRecordTtl = 30 * 24 * 60 * 60 * 1000;   // 设备注册记录 30 天有效 / device registration TTL
// 每个频道的离线推送设备注册上限（可用 env GETUI_MAX_CIDS_PER_CHANNEL 覆盖）
// 防重装重复通知靠 deviceRecordTtl（30 天）兜底；上限只是保险丝，不宜卡死，默认放宽到 32 人内房间无缺口
// Max registered push devices per channel (overridable via env GETUI_MAX_CIDS_PER_CHANNEL).
// Reinstall duplicate pushes are bounded by deviceRecordTtl (30 days); the cap is only a fuse.
const DEFAULT_MAX_CIDS_PER_CHANNEL = 32;
const tokenCacheKey = (appId) => `getui-token:${appId}`;

function sha256Hex(text) {
	try {
		return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then((buf) => {
			return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
		});
	} catch (error) {
		return Promise.resolve('');
	}
}

function isConfigured(env) {
	return Boolean(env && env.GETUI_APP_ID && env.GETUI_APP_KEY && env.GETUI_MASTER_SECRET);
}

function timestamp() {
	return Date.now().toString();
}

function requestId() {
	let id = Math.random().toString(36).substring(2);
	return `${id}${Date.now().toString(36)}`;
}

// 个推鉴权 token（缓存到 DO storage，避免每次请求重新签名）
// Getui auth token (cached in DO storage to avoid re-signing every push)
async function requestGetuiToken(env, storage) {
	try {
		const cached = await storage.get(tokenCacheKey(env.GETUI_APP_ID));
		if (cached && cached.token && cached.exp > Date.now()) {
			return { token: cached.token, code: 0, msg: 'cached' };
		}
		const ts = timestamp();
		const sign = await sha256Hex(`${env.GETUI_APP_KEY}${ts}${env.GETUI_MASTER_SECRET}`);
		const response = await fetch(`${GETUI_REST_BASE}/${env.GETUI_APP_ID}/auth`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sign: sign, timestamp: ts, appkey: env.GETUI_APP_KEY }),
			signal: AbortSignal.timeout(10000)
		});
		const json = await response.json();
		if (json && json.code === 0 && json.data && json.data.token) {
			// 个推 token 有效期约 24 小时，这里缓存 23 小时
			// Getui token lives ~24h; cache it for 23h
			await storage.put(tokenCacheKey(env.GETUI_APP_ID), {
				token: json.data.token,
				exp: Date.now() + 23 * 60 * 60 * 1000
			});
			return { token: json.data.token, code: 0, msg: null };
		}
		console.error('getui auth failed', json && json.msg);
		return { token: null, code: json ? json.code : response.status, msg: json ? json.msg : `http ${response.status}` };
	} catch (error) {
		console.error('getui auth error', error);
		return { token: null, code: null, msg: String(error && error.message || error) };
	}
}

async function getGetuiToken(env, storage) {
	const result = await requestGetuiToken(env, storage);
	return result.token;
}

// 列出指定频道离线设备（state.storage 持久化，键: devices:{channelHash}）
// List offline devices of a channel (persisted in DO storage, key: devices:{channelHash})
export async function listOfflineDevices(storage, channelHash) {
	try {
		const devices = (await storage.get(`devices:${channelHash}`)) || {};
		const now = Date.now();
		const tokens = [];
		for (const token in devices) {
			const record = devices[token];
			if (!record || record.online) continue;
			if (!record.seen || (now - record.seen > deviceRecordTtl)) continue;
			tokens.push(token);
		}
		return tokens;
	} catch (error) {
		console.error('listOfflineDevices error', error);
		return [];
	}
}

// 注册/更新设备（由加密通道内的 a:'dr' 动作触发；env 用于读取 CID 上限覆盖）
// Register or update a device row (triggered by encrypted a:'dr' action; env for cap override)
export async function upsertDevice(storage, channelHash, pushToken, clientId, env) {
	try {
		const key = `devices:${channelHash}`;
		const devices = (await storage.get(key)) || {};
		const now = Date.now();
		const cleaned = {};
		for (const token in devices) {
			const record = devices[token];
			if (record.seen && (now - record.seen <= deviceRecordTtl)) {
				cleaned[token] = record;
			}
		}
		if (cleaned[pushToken] && cleaned[pushToken].link && cleaned[pushToken].link !== clientId && cleaned[pushToken].online) {
			// 同一设备旧连接仍标记在线时，避免错把旧链路关闭，仅更新 link
			// Old link of the same device is still online; keep online flag, just relink
		}
		cleaned[pushToken] = {
			online: 1,
			link: clientId,
			seen: now
		};
		// 同一频道最多保留最近 N 个 cid（env GETUI_MAX_CIDS_PER_CHANNEL 可覆盖，默认 32）：
		// 重装 APP 会产生新 cid，旧的在 TTL 内仍可能有效 → 一条消息推多次（老设备补投），
		// 按 seen 淘汰最旧的，防重装污染与恶意/异常海量注册。
		// Keep at most the newest N cids per channel (default 32, env-overridable):
		// reinstalls mint new cids while old ones may stay valid within TTL, causing
		// duplicate pushes; evict the oldest by seen (also guards against abuse).
		const maxCids = Number(env && env.GETUI_MAX_CIDS_PER_CHANNEL) || DEFAULT_MAX_CIDS_PER_CHANNEL;
		const cidKeys = Object.keys(cleaned);
		if (cidKeys.length > maxCids) {
			cidKeys.sort((a, b) => (cleaned[b].seen || 0) - (cleaned[a].seen || 0));
			for (const stale of cidKeys.slice(maxCids)) {
				delete cleaned[stale];
			}
		}
		await storage.put(key, cleaned);
		return true;
	} catch (error) {
		console.error('upsertDevice error', error);
		return false;
	}
}

// 连接断开时，把该 clientId 关联的设备标记为离线
// Mark devices linked to the clientId as offline when the WS connection closes
export async function markDeviceOffline(storage, channelHash, clientId) {
	try {
		const key = `devices:${channelHash}`;
		const devices = (await storage.get(key)) || {};
		const now = Date.now();
		let changed = false;
		for (const token in devices) {
			const record = devices[token];
			if (record.link === clientId && record.online) {
				record.online = 0;
				record.seen = now;
				changed = true;
			}
		}
		if (changed) {
			await storage.put(key, devices);
		}
	} catch (error) {
		console.error('markDeviceOffline error', error);
	}
}

// 离线厂商通知体：标题/内容 + 点击跳转行为
// Offline vendor notification: title/body + click behaviour
// 离线送达必须带 push_channel（厂商通道）：只写 push_message 时消息仅存个推离线库，
// 要等 APP 打开（CID 上线）才补投 —— 正是"杀进程收不到、打开 APP 才收到"的原因。
// click_type:'intent' 是厂商离线点击携带 payload 的唯一可靠方式（DCloud 固定格式），
// S.payload 原样交给 5+ Push 的 payload（这里是房间 hash，零明文）。
// Offline delivery REQUIRES push_channel: with push_message only, the message sits in
// Getui's offline store and is redelivered after the app opens - exactly the
// "not received when killed, arrives on open" symptom. click_type:'intent' (DCloud
// fixed format) is the only reliable way to carry payload through vendor clicks;
// S.payload feeds the 5+ Push payload verbatim (the room hash - zero plaintext).
// 通知标题：默认 NodeCrypt，可通过环境变量 GETUI_APP_NAME 覆盖（APP 改名后服务端标题需同步）。
// Notification title: defaults to NodeCrypt, overridable via env GETUI_APP_NAME
// (must follow the app's display name change).
function notifyTitle(env) {
	return (typeof (env && env.GETUI_APP_NAME) === 'string' && env.GETUI_APP_NAME.trim()) || 'NodeCrypt';
}
const NOTIFY_BODY = '有新消息';
// 点击进房兜底标记：非华为（个推离线库补投）路径的 click payload 会被个推/DCloud
// 重组成 title/content 而丢失自定义 payload（实测），所以把房间 hash 的前 8 位放进
// 正文 [xxxxxxxx] —— 客户端从 content 提取做前缀匹配即可进房。服务器仍不知房间名
// （截断 hash 无明文，碰撞概率对个位数频道可忽略），保持盲中继设计。
// Routing fallback tag: the Getui-store redelivery path rebuilds the click payload
// as title/content and drops our custom payload (observed on-device), so embed the
// first 8 hex chars of the room hash into the body as [xxxxxxxx]; the client
// prefix-matches it against registered channels. The server still never learns the
// room name (truncated hash, collision negligible for single-digit channel counts),
// preserving the blind-relay design.
function notifyBody(channelHash) {
	// 正文尾缀加发送时刻 HH:MM：手机上可一眼区分“本轮新消息”与“离线队列/通知栏残留”
	// （残留 payload 没有时间戳或时间已过），判代不再依赖猜测。
	// Append the dispatch time HH:MM so any notification self-identifies whether it is
	// a fresh message or a stale queue/tray leftover — no more guessing epochs.
	const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16);
	return `${NOTIFY_BODY} [${String(channelHash || '').slice(0, 8)}] ${stamp}`;
}
// 环境变量 GETUI_ANDROID_PACKAGE 必须与云打包设置的 Android 包名一致（intent 依赖它）
// Env GETUI_ANDROID_PACKAGE must equal the Android package name set in cloud packaging
function buildVendorNotification(env, payloadText, bodyText) {
	try {
		const pkg = String(env.GETUI_ANDROID_PACKAGE || '').trim();
		if (!pkg) {
			// 未配置包名：退化为打开应用首页（点击后 payload 可能丢失，仅能进 APP）
			// Package name missing: fall back to launch home (payload may be lost on click)
			return { click_type: 'startapp' };
		}
		return {
			click_type: 'intent',
			intent:
				`intent://io.dcloud.unipush/?#Intent;scheme=unipush;launchFlags=0x4000000;` +
				`component=${pkg}/io.dcloud.PandoraEntry;S.UP-OL-SU=true;` +
				`S.title=${notifyTitle(env)};S.content=${bodyText};S.payload=${payloadText};end`
		};
	} catch (error) {
		return { click_type: 'startapp' };
	}
}

// 组装一次 cid 单推的完整请求体（在线个推通道 + 离线厂商通道）
// Assemble one single-cid push body (online Getui channel + offline vendor channel)
// strategy.default = 4：厂商通道优先，失败自动回退个推通道（失败时的消息存个推离线库，
// APP 打开补投）——服务端原生完成失败兜底，单条消息不会重复下发。
// strategy 4 = prefer vendor channels, fall back to the Getui channel on failure
// (queued in Getui's offline store and redelivered when the app opens) - the failure
// fallback happens atomically inside Getui, one message is never double-sent.
function buildPushBody(env, channelHash, audienceCid, testMessage) {
	const payloadText = channelHash;
	const bodyText = notifyBody(channelHash);
	const titleText = notifyTitle(env);
	const vendorNotification = buildVendorNotification(env, payloadText, bodyText);
	const body = {
		request_id: requestId(),
		audience: { cid: [audienceCid] },
		settings: { ttl: 3600000, strategy: { default: 4 } },
		// 在线个推通道改用透传：APP 进程存活（前台/后台）即触发 receive，
		// 由客户端计数角标 + 弹本地通知 —— 修复"通知栏消息在线送达但前台不弹、
		// APP 进程死时被吞且个推视为成功不进离线库"的消息黑洞。
		// 杀进程场景：厂商离线通知（横幅可点直达）或离线库补投（APP 打开时 receive）。
		// Online Getui channel uses transmission: any live app process (foreground or
		// background) fires receive, so the client counts the badge and pops a local
		// notification itself — fixes the black hole where an online "notification"
		// message was counted delivered while the app process was dead/foreground.
		// Killed phones: vendor offline notification banner, or offline-store redelivery.
		// 透传 payload 统一为人话（有新消息 [hash8] HH:MM）——用户定稿格式；厂商通知
		// title/body 同源（notifyBody），所有链路正文口径一致。WIKO/OPPO 通知栏残留的
		// 长 JSON 已证实为时代快照回放（13.10），与本 payload 无关。
		// Transmission payload = the canonical human text (NOTIFY_BODY [hash8] HH:MM);
		// vendor notification shares notifyBody so every path speaks the same prose.
		push_message: {
			transmission: notifyBody(payloadText)
		},
		push_channel: {
			android: {
				ups: {
					notification: Object.assign({
						title: titleText,
						body: bodyText
					}, vendorNotification),
					// 华为通知自分类权益：服务端必须携带 category（"即时聊天"=IM）才会按
					// 服务与通讯类计（推送数量不受 2 条/日/设备 的资讯营销类频控）；
					// 权益审核通过但消息不带 category 时仍按营销类频控。
					// Huawei self-classification right: the message MUST carry category
					// ("im" scenario = IM), otherwise it falls back to the marketing class
					// with a 2/day/device rate limit even after the right is approved.
				options: {
					HW: {
						// category lives at the android level of the HMS message body
						// (per getui doc & Huawei FAQ sample: android.category = "IM").
						// The notification-level key was silently ignored by the vendor
						// pipeline, so the right was never honored and messages were
						// rate-limited as marketing class.
						'/message/android/category': hwCategory(env),
						'/message/android/notification/badge/class': 'io.dcloud.PandoraEntry',
						'/message/android/notification/badge/add_num': 1
					}
				}
				}
			},
			ios: {
				type: 'notify',
				payload: payloadText,
				aps: {
					alert: { title: titleText, body: bodyText },
					'content-available': 0
				},
				auto_badge: '+1'
			}
		}
	};
	// 测试通道标记：华为调测阶段每应用每日 1000 条测试消息，不占"营销类 2 条/日/设备"额度。
	// 触发来源：诊断端点（?push=1&test=1）或环境变量 GETUI_TEST_MODE=1（用户级开关，
	// 让正式推送整体走测试通道绕过 2 条额度的临时方案 —— 代价是走华为测试通道的特殊路径，稳定后建议关闭）。
	// Vendor test-message flag: Huawei allows 1000/day test messages in the debug phase,
	// bypassing the 2/day marketing quota. Driven by the diagnostic endpoint (?push=1&test=1)
	// or the env switch GETUI_TEST_MODE=1 (lets production pushes use the test channel
	// temporarily; turn it off once stable, since it rides Huawei's special test path).
	if (testMessage || String(env.GETUI_TEST_MODE || '').trim() === '1') {
		body.pushOptions = { testMessage: true };
	}
	return body;
}

// 华为自分类 category：默认 IM（即时聊天），可用环境变量 GETUI_HW_CATEGORY 覆盖
// Huawei self-classification category: default IM (instant chat), overridable via env
function hwCategory(env) {
	const value = String(env.GETUI_HW_CATEGORY || '').trim();
	return value || 'IM';
}

// 从个推返回 data 中提取指定 cid 的状态字符串（兼容二层/平铺结构）
// Extract the status string for a cid from the response data (nested or flat)
function vendorStatus(json, cid) {
	try {
		if (!json || !json.data || typeof json.data !== 'object') return null;
		if (Object.prototype.hasOwnProperty.call(json.data, cid)) {
			return typeof json.data[cid] === 'string' ? json.data[cid] : null;
		}
		for (const key in json.data) {
			const value = json.data[key];
			if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, cid)) {
				return typeof value[cid] === 'string' ? value[cid] : null;
			}
		}
		return null;
	} catch (error) {
		return null;
	}
}

// 个推单推返回的 data 实际为 { taskId: { cid: 状态 } } 二层结构，
// successed_offline=厂商/离线下发成功，successed_online=个推通道在线送达；
// 兼容文档中历史的平铺 { cid: 状态 } 形态。successed_ignore=90 天不活跃未下发（ cid 已失效）。
// Getui returns data as { taskId: { cid: status } } (docs), with a legacy flat
// { cid: status } shape also handled. ignore = cid inactive for 90 days (stale).
function vendorDelivered(json, cid) {
	try {
		if (!json || json.code !== 0 || !json.data) return false;
		if (typeof json.data === 'string') return json.data.length > 0;
		for (const key in json.data) {
			const value = json.data[key];
			if (Object.prototype.hasOwnProperty.call(value, cid)) {
				const status = value[cid];
				return status === 'successed_offline' || status === 'successed_online';
			}
			if (key === cid) {
				return value === 'successed_offline' || value === 'successed_online';
			}
		}
		return false;
	} catch (error) {
		return false;
	}
}

async function postGetui(env, token, cid, body) {
	const response = await fetch(`${GETUI_REST_BASE}/${env.GETUI_APP_ID}/push/single/cid`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'token': token
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10000)
	});
	let json = null;
	try { json = await response.json(); } catch (error) { /* non-JSON response */ }
	return json;
}

// 通知日志：滚动记录每次 notifyOfflineDevices 的触发、跳过原因与逐 cid 个推返回
// （服务器侧留痕替代被网络封禁的 wrangler tail，用 /api/push-test?hash=x&notifylog=1 拉取）
// Notify log: ring buffer of every notifyOfflineDevices invocation (skip reasons and
// per-cid Getui responses). Server-side evidence in place of wrangler tail;
// fetch via /api/push-test?hash=x&notifylog=1
const NOTIFY_LOG_LIMIT = 30;

async function appendNotifyLog(storage, channelHash, entry) {
	try {
		const key = `notify-log:${channelHash}`;
		const log = (await storage.get(key)) || [];
		log.unshift(Object.assign({ ts: Date.now() }, entry));
		await storage.put(key, log.slice(0, NOTIFY_LOG_LIMIT));
	} catch (error) {
		console.error('appendNotifyLog error', error);
	}
}

// 拉取通知日志（调试端点用；无 hash 返回 null）
// Fetch the notify log (debug endpoint; null without hash)
export async function readNotifyLog(storage, channelHash) {
	try {
		if (!channelHash) return null;
		return (await storage.get(`notify-log:${channelHash}`)) || [];
	} catch (error) {
		console.error('readNotifyLog error', error);
		return [];
	}
}

// 从注册表移除失效 cid（个推 20001 invalid / 手动 &forget=<cid>）
// Drop an invalid cid from the registry (Getui 20001 invalid / manual &forget>)
export async function removeDevice(storage, channelHash, cid) {
	try {
		const key = `devices:${channelHash}`;
		const devices = (await storage.get(key)) || {};
		if (!devices || !Object.prototype.hasOwnProperty.call(devices, cid)) return false;
		delete devices[cid];
		await storage.put(key, devices);
		return true;
	} catch (error) {
		console.error('removeDevice error', error);
		return false;
	}
}

// 推送通知（不 await 结果也安全；由 DO 的 await 链路保证调度）
// Send push notifications (safe fire-and-forget; scheduled via DO await chain)
// source: 调用来源（'private'=私聊转发 / 'channel'=频道消息转发），仅用于日志归因
// source: call origin ('private' / 'channel'), used only for log attribution
export async function notifyOfflineDevices(env, storage, channelHash, source) {
	if (!isConfigured(env)) {
		return;
	}
	const sourceLabel = source || 'unknown';
	try {
		const tokens = await listOfflineDevices(storage, channelHash);
		if (tokens.length === 0) {
			await appendNotifyLog(storage, channelHash, { source: sourceLabel, skip: 'no-offline-devices' });
			return;
		}
		const token = await getGetuiToken(env, storage);
		if (!token) {
			await appendNotifyLog(storage, channelHash, { source: sourceLabel, skip: 'auth-failed', devices: tokens });
			return;
		}
		const results = [];
		for (const cid of tokens) {
			try {
				// 策略 4：厂商离线通道优先，失败由个推自动落回个推离线库（打开 APP 补投）
				// Strategy 4: vendor channel first, Getui auto-falls back to its offline
				// store (redelivered when the app opens) if the vendor send fails.
				const json = await postGetui(env, token, cid, buildPushBody(env, channelHash, cid));
				const delivered = vendorDelivered(json, cid);
				const status = vendorStatus(json, cid);
				const entry = { cid, ok: delivered, code: json ? json.code : null, msg: json ? json.msg : null, status };
				// 死 cid 自动净化：个推 20001（用户无效=已卸载/重装残留）即时移出注册表
				// Auto-purge dead cids: Getui 20001 (invalid user = uninstalled/stale) removed at once
				if (json && json.code === 20001) {
					entry.removed = true;
					await removeDevice(storage, channelHash, cid);
				}
				results.push(entry);
				if (!delivered) {
					console.error('getui push not confirmed', cid, json && json.msg, json && JSON.stringify(json.data || json));
				}
			} catch (error) {
				results.push({ cid, ok: false, error: String(error && error.message || error) });
				console.error('getui push error', cid, error);
			}
		}
		await appendNotifyLog(storage, channelHash, { source: sourceLabel, devices: tokens.length, results });
	} catch (error) {
		console.error('notifyOfflineDevices error', error);
		await appendNotifyLog(storage, channelHash, { source: sourceLabel, error: String(error && error.message || error) });
	}
}

// 列出 DO 中全部已注册设备（调试端点用）
// List every registered device in DO storage (used by the debug endpoint)
export async function listAllDevices(storage) {
	const result = [];
	const entries = await storage.list({ prefix: 'devices:' });
	const now = Date.now();
	for (const [key, devices] of entries) {
		const deviceList = [];
		for (const cid in devices) {
			const record = devices[cid];
			deviceList.push({ cid, online: record.online ? true : false, seenAt: record.seen || null, fresh: Boolean(record.seen && now - record.seen <= deviceRecordTtl) });
		}
		result.push({ hash: key.slice('devices:'.length), devices: deviceList });
	}
	return result;
}

// 测试期辅助：清空设备注册（指定 hash 或全部），返回清除的 cid 数
// Test aid: wipe device registrations (one hash or all), returns removed cid count
export async function purgeDevices(storage, channelHash) {
	try {
		if (channelHash) {
			const key = `devices:${channelHash}`;
			const devices = await storage.get(key);
			if (!devices) return 0;
			await storage.delete(key);
			return Object.keys(devices).length;
		}
		const entries = await storage.list({ prefix: 'devices:' });
		let removed = 0;
		const keys = [];
		for (const [k, devices] of entries) {
			removed += Object.keys(devices || {}).length;
			keys.push(k);
		}
		if (keys.length > 0) {
			await storage.delete(keys);
		}
		return removed;
	} catch (error) {
		console.error('purgeDevices error', error);
		return 0;
	}
}

// 推送调试变体：返回完整过程数据（设备清单/鉴权结果/每个 cid 的个推响应原文）
// Debug variant of push: full process data (device list / auth result / per-cid Getui response)
// targetCid: 可选，仅推送该 cid（单机取证，如真华为杀进程横幅对照）
// targetCid: optional, push to one cid only (single-device diagnosis)
export async function debugPush(env, storage, channelHash, testMessage, targetCid) {
	try {
		if (!isConfigured(env)) {
			const bindings = {
				GETUI_APP_ID: typeof env.GETUI_APP_ID === 'string' && env.GETUI_APP_ID.length > 0,
				GETUI_APP_KEY: typeof env.GETUI_APP_KEY === 'string' && env.GETUI_APP_KEY.length > 0,
				GETUI_MASTER_SECRET: typeof env.GETUI_MASTER_SECRET === 'string' && env.GETUI_MASTER_SECRET.length > 0
			};
			return { error: 'GETUI secrets not configured', bindings };
		}
		const key = `devices:${channelHash}`;
		const devices = (await storage.get(key)) || {};
		const now = Date.now();
		const deviceList = [];
		for (const cid in devices) {
			const record = devices[cid];
			deviceList.push({ cid, online: record.online ? true : false, seenAt: record.seen || null, fresh: Boolean(record.seen && now - record.seen <= deviceRecordTtl) });
		}
		const offlineTokensAll = await listOfflineDevices(storage, channelHash);
		const offlineTokens = targetCid
			? offlineTokensAll.filter((t) => t === targetCid)
			: offlineTokensAll;
		const result = {
			channelHash,
			targetedCid: targetCid || null,
			deviceCount: deviceList.length,
			devices: deviceList,
			offlineTokens: offlineTokens.length,
			auth: 'pending',
			authCode: null,
			authMsg: null,
			pushResults: []
		};
		const tokenInfo = await requestGetuiToken(env, storage);
		result.fingerprints = {
			appId: await sha256Hex(env.GETUI_APP_ID || ''),
			appKey: await sha256Hex(env.GETUI_APP_KEY || ''),
			masterSecret: await sha256Hex(env.GETUI_MASTER_SECRET || '')
		};
		result.androidPackage = String(env.GETUI_ANDROID_PACKAGE || '').trim() || '(unset)';
		result.hwCategory = hwCategory(env);
		// testMessage 与 GETUI_TEST_MODE=1 任一命中都会走测试通道，这里展示实际生效值
		// Effective test-channel flag (explicit ?test=1 or GETUI_TEST_MODE=1)
		result.testMessage = testMessage ? true : String(env.GETUI_TEST_MODE || '').trim() === '1';
		result.vendorBody = buildVendorNotification(env, channelHash, notifyBody(channelHash));
		if (!tokenInfo.token) {
			result.auth = 'failed';
			result.authCode = tokenInfo.code;
			result.authMsg = tokenInfo.msg;
			return result;
		}
		result.auth = 'ok';
		for (const cid of offlineTokens) {
			try {
				const vendorBody = buildPushBody(env, channelHash, cid, testMessage);
				const json = await postGetui(env, tokenInfo.token, cid, vendorBody);
				const delivered = vendorDelivered(json, cid);
				result.pushResults.push({
					cid,
					code: json ? json.code : null,
					msg: json ? json.msg : null,
					status: vendorStatus(json, cid),
					delivered,
					raw: json ? JSON.stringify(json).slice(0, 600) : null,
					body: JSON.stringify(vendorBody).slice(0, 600)
				});
			} catch (error) {
				result.pushResults.push({ cid, error: String(error && error.message || error) });
			}
		}
		return result;
	} catch (error) {
		return { error: String(error && error.message || error) };
	}
}

// 查询个推任务级厂商通道真实回执：?report=1&taskid=<id>&cid=<cid>
export async function debugTaskDetail(env, storage, cid, taskid) {
	try {
		if (!isConfigured(env)) return { error: 'GETUI secrets not configured' };
		const tokenInfo = await requestGetuiToken(env, storage);
		if (!tokenInfo.token) return { error: 'auth failed', code: tokenInfo.code, msg: tokenInfo.msg };
		const token = tokenInfo.token;
		const base = `${GETUI_REST_BASE}/${env.GETUI_APP_ID}`;
		const headers = { token };
		const results = { cid, taskid };
		try {
			const response = await fetch(`${base}/task/detail/${cid}/${taskid}`, { headers, signal: AbortSignal.timeout(10000) });
			results.detail = await response.json();
		} catch (error) {
			results.detailError = String(error && error.message || error);
		}
		try {
			const response = await fetch(`${base}/report/push/task/${taskid}`, { headers, signal: AbortSignal.timeout(10000) });
			results.report = await response.json();
		} catch (error) {
			results.reportError = String(error && error.message || error);
		}
		return results;
	} catch (error) {
		return { error: String(error && error.message || error) };
	}
}
