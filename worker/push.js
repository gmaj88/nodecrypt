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
async function getGetuiToken(env, storage) {
	try {
		const cached = await storage.get(tokenCacheKey(env.GETUI_APP_ID));
		if (cached && cached.token && cached.exp > Date.now()) {
			return cached.token;
		}
		const ts = timestamp();
		const sign = await sha256Hex(`${env.GETUI_APP_KEY}${ts}${env.GETUI_MASTER_SECRET}`);
		const response = await fetch(`${GETUI_REST_BASE}/${env.GETUI_APP_ID}/auth`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sign: sign, timestamp: ts, appkey: env.GETUI_APP_KEY })
		});
		const json = await response.json();
		if (json && json.code === 0 && json.data && json.data.token) {
			// 个推 token 有效期约 24 小时，这里缓存 23 小时
			// Getui token lives ~24h; cache it for 23h
			await storage.put(tokenCacheKey(env.GETUI_APP_ID), {
				token: json.data.token,
				exp: Date.now() + 23 * 60 * 60 * 1000
			});
			return json.data.token;
		}
		console.error('getui auth failed', json && json.msg);
		return null;
	} catch (error) {
		console.error('getui auth error', error);
		return null;
	}
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
		const payload = JSON.stringify({
			type: 'nodecrypt-msg',
			hash: channelHash
		});
		for (const cid of tokens) {
			try {
				const response = await fetch(`${GETUI_REST_BASE}/${env.GETUI_APP_ID}/push/single/cid`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'token': token
					},
					body: JSON.stringify({
						request_id: requestId(),
						settings: { ttl: 3600000 },
						push_message: {
							notification: {
								title: 'NodeCrypt',
								body: '您有新的加密消息 / You have a new encrypted message',
								click_type: 'startapp',
								payload: payload
							}
						}
					})
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
			pushResults: []
		};
		const token = await getGetuiToken(env, storage);
		if (!token) {
			result.auth = 'failed';
			return result;
		}
		result.auth = 'ok';
		const payload = JSON.stringify({ type: 'nodecrypt-msg', hash: channelHash });
		for (const cid of offlineTokens) {
			try {
				const response = await fetch(`${GETUI_REST_BASE}/${env.GETUI_APP_ID}/push/single/cid`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'token': token },
					body: JSON.stringify({
						request_id: requestId(),
						settings: { ttl: 3600000 },
						push_message: {
							notification: {
								title: 'NodeCrypt',
								body: '您有新的加密消息 / You have a new encrypted message',
								click_type: 'startapp',
								payload: payload
							}
						}
					})
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
