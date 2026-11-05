// 离线推送适配器（uniPush 1.0 / 个推 REST v2）
// Offline push adapter for uniPush 1.0 (Getui REST API v2)
// 设计原则：服务器是盲中继 —— 推送内容不含消息明文、不含房间名，只有房间哈希（与加入房间时上报的一致）
// Design principle: server is a blind relay - push body carries no message plaintext, no room name,
// only the room hash (the same value reported at room join).

const GETUI_REST_BASE = 'https://restapi.getui.com/v2';
const deviceRecordTtl = 30 * 24 * 60 * 60 * 1000;   // 设备注册记录 30 天有效 / device registration TTL
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

// 注册/更新设备（由加密通道内的 a:'dr' 动作触发）
// Register or update a device row (triggered by encrypted a:'dr' action)
export async function upsertDevice(storage, channelHash, pushToken, clientId) {
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
		// 同一频道最多保留最近 2 个 cid：重装 APP 会产生新 cid，旧的仍有效会堆积，
		// 导致一条消息推多次（老设备补投）。按 seen 淘汰最旧的。
		// Keep at most the 2 newest cids per channel: reinstalls mint new cids while old
		// ones stay valid, causing duplicate pushes. Evict the oldest by seen.
		const cidKeys = Object.keys(cleaned);
		if (cidKeys.length > 2) {
			cidKeys.sort((a, b) => (cleaned[b].seen || 0) - (cleaned[a].seen || 0));
			for (const stale of cidKeys.slice(2)) {
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
const NOTIFY_TITLE = 'NodeCrypt';
const NOTIFY_BODY = '有新消息，点击查看';

// 环境变量 GETUI_ANDROID_PACKAGE 必须与云打包设置的 Android 包名一致（intent 依赖它）
// Env GETUI_ANDROID_PACKAGE must equal the Android package name set in cloud packaging
function buildVendorNotification(env, payloadText) {
	try {
		const pkg = String(env.GETUI_ANDROID_PACKAGE || '').trim();
		if (!pkg) {
			// 未配置包名：退化为打开应用首页（点击后 payload 可能丢失，仅能进 APP）
			// Package name missing: fall back to launch home (payload may be lost on click)
			return { click_type: 'startapp', payload: payloadText };
		}
		return {
			click_type: 'intent',
			intent:
				`intent://io.dcloud.unipush/?#Intent;scheme=unipush;launchFlags=0x4000000;` +
				`component=${pkg}/io.dcloud.PandoraEntry;S.UP-OL-SU=true;` +
				`S.title=${NOTIFY_TITLE};S.content=${NOTIFY_BODY};S.payload=${payloadText};end`
		};
	} catch (error) {
		return { click_type: 'startapp', payload: payloadText };
	}
}

// 组装一次 cid 单推的完整请求体（在线个推通道 + 离线厂商通道）
// Assemble one single-cid push body (online Getui channel + offline vendor channel)
function buildPushBody(env, channelHash, audienceCid) {
	const payloadText = channelHash;
	const vendorNotification = buildVendorNotification(env, payloadText);
	return {
		request_id: requestId(),
		audience: { cid: [audienceCid] },
		settings: { ttl: 3600000 },
		push_message: {
			notification: {
				title: NOTIFY_TITLE,
				body: NOTIFY_BODY,
				click_type: 'startapp',
				payload: payloadText
			}
		},
		push_channel: {
			android: {
				ups: {
					notification: Object.assign({
						title: NOTIFY_TITLE,
						body: NOTIFY_BODY
					}, vendorNotification),
					// 华为桌面角标 +1（客户端进房间/回首页时会清零或重算）
					// Huawei launcher badge +1 (client clears/recomputes it when entering a room / home)
					options: {
						HW: {
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
					alert: { title: NOTIFY_TITLE, body: NOTIFY_BODY },
					'content-available': 0
				},
				auto_badge: '+1'
			}
		}
	};
}

// 推送通知（不 await 结果也安全；由 DO 的 await 链路保证调度）
// Send push notifications (safe fire-and-forget; scheduled via DO await chain)
export async function notifyOfflineDevices(env, storage, channelHash) {
	if (!isConfigured(env)) {
		return;
	}
	try {
		const tokens = await listOfflineDevices(storage, channelHash);
		if (tokens.length === 0) {
			return;
		}
		const token = await getGetuiToken(env, storage);
		if (!token) {
			return;
		}
		for (const cid of tokens) {
			try {
				const response = await fetch(`${GETUI_REST_BASE}/${env.GETUI_APP_ID}/push/single/cid`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'token': token
					},
					body: JSON.stringify(buildPushBody(env, channelHash, cid)),
					signal: AbortSignal.timeout(10000)
				});
				const json = await response.json();
				if (json && json.code !== 0) {
					console.error('getui push failed', cid, json && json.msg);
				}
			} catch (error) {
				console.error('getui push error', cid, error);
			}
		}
	} catch (error) {
		console.error('notifyOfflineDevices error', error);
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
export async function debugPush(env, storage, channelHash) {
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
		const offlineTokens = await listOfflineDevices(storage, channelHash);
		const result = {
			channelHash,
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
		if (!tokenInfo.token) {
			result.auth = 'failed';
			result.authCode = tokenInfo.code;
			result.authMsg = tokenInfo.msg;
			return result;
		}
		result.auth = 'ok';
		for (const cid of offlineTokens) {
			try {
				const response = await fetch(`${GETUI_REST_BASE}/${env.GETUI_APP_ID}/push/single/cid`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'token': tokenInfo.token },
					body: JSON.stringify(buildPushBody(env, channelHash, cid)),
					signal: AbortSignal.timeout(10000)
				});
				let json = null;
				try { json = await response.json(); } catch (e) { /* non-JSON response */ }
				result.pushResults.push({ cid, http: response.status, code: json ? json.code : null, msg: json ? json.msg : null });
			} catch (error) {
				result.pushResults.push({ cid, error: String(error && error.message || error) });
			}
		}
		return result;
	} catch (error) {
		return { error: String(error && error.message || error) };
	}
}
