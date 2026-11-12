// NodeCrypt core cryptographic client for secure chat
// NodeCrypt 安全聊天的核心加密客户端

import {
	sha256
} from 'js-sha256';
import {
	ec as elliptic
} from 'elliptic';
import {
	ModeOfOperation
} from 'aes-js';
import chacha from 'js-chacha20';
import {
	Buffer
} from 'buffer';
window.Buffer = Buffer;

// Main NodeCrypt class for secure communication
// 用于安全通信的 NodeCrypt 主类
class NodeCrypt {
	// Initialize NodeCrypt instance
	// 初始化 NodeCrypt 实例
	constructor(config = {}, callbacks = {}) {
		this.config = {
			rsaPublic: config.rsaPublic || '',
			wsAddress: config.wsAddress || '',
			reconnectDelay: config.reconnectDelay || 3000,
			// 心跳 10s + pong 看门狗 25s：半开/静默断链最多 ~25s 即被检测并强制重连
			// （修复"手机新进房约 1 分钟才互相可见"：此前 pong 被忽略，只能等 OS TCP 超时）
			// Heartbeat 10s + pong watchdog 25s: half-open/silently broken sockets are detected
			// within ~25s and force-reconnected (previously pong was ignored and recovery
			// waited for the OS TCP timeout, ~1 minute)
			pingInterval: config.pingInterval || 10000,
			pongTimeout: config.pongTimeout || 25000,
			pendingHandshakeTimeout: config.pendingHandshakeTimeout || 20000,
			debug: config.debug || false,
		};
		this.callbacks = {
			onServerClosed: callbacks.onServerClosed || null,
			onServerSecured: callbacks.onServerSecured || null,
			onClientSecured: callbacks.onClientSecured || null,
			onClientList: callbacks.onClientList || null,
			onClientMessage: callbacks.onClientMessage || null,
			onClientPending: callbacks.onClientPending || null,
			// 发件箱状态变化回调（UI 据此更新气泡"发送中/重连后已发送/未送达"）
			// Outbox state callback (the UI updates bubble delivery status from it)
			onOutbox: callbacks.onOutbox || null,
		};
		this.SERVER_KEY_STORAGE = 'nodecrypt_server_key';
		try {
			this.clientEc = new elliptic('curve25519')
		} catch (error) {
			this.logEvent('constructor', error, 'error')
		}
		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection = null;
		this.reconnect = null;
		this.ping = null;
		this.channel = {};
		// 传输时间线与看门狗状态（debug 日志 + 重连判定）
		// Transport timeline & watchdog state (debug logs + reconnect decisions)
		this.lastPongAt = 0;
		this.lastPingSentAt = 0;
		this.probeTimer = null;
		this.connectStartedAt = 0;
		// 服务端名单回传的本端 clientId（l.i）；主动离开暂停标志
		// Our own clientId echoed by the server (l.i); explicit-leave pause flag
		this.selfId = null;
		this.paused = false;
		// 每个尚未完成握手的 peer 的延时检查器（8s 后仍未 secured → onClientPending）
		// Deferred checkers for peers that never finish the handshake (8s → onClientPending)
		this.pendingPeerTimers = {};
		// 按人投递发件箱：掉线/对方未完成握手时排队，就绪后自动补发（去重、30s 超时标红）
		// Per-recipient outbox: queue while offline or a peer is still syncing; auto-flush
		// when ready (per-recipient, deduped, 30s timeout → marked failed)
		this.outbox = [];
		this.outboxTimer = null;
		this.outboxSeq = 0;
		this.onOutbox = null;
		this.setCredentials = this.setCredentials.bind(this);
		this.connect = this.connect.bind(this);
		this.destruct = this.destruct.bind(this);
		this.onOpen = this.onOpen.bind(this);
		this.onMessage = this.onMessage.bind(this);
		this.onError = this.onError.bind(this);
		this.onClose = this.onClose.bind(this);
		this.logEvent = this.logEvent.bind(this);
		this.isOpen = this.isOpen.bind(this);
		this.isClosed = this.isClosed.bind(this);
		this.startReconnect = this.startReconnect.bind(this);
		this.stopReconnect = this.stopReconnect.bind(this);
		this.startPing = this.startPing.bind(this);
		this.stopPing = this.stopPing.bind(this);
		this.disconnect = this.disconnect.bind(this);
		this.sendMessage = this.sendMessage.bind(this);
		this.sendChannelMessage = this.sendChannelMessage.bind(this);
		this.armLifecycleWatchdog = this.armLifecycleWatchdog.bind(this);
		this.encryptServerMessage = this.encryptServerMessage.bind(this);
		this.decryptServerMessage = this.decryptServerMessage.bind(this);
		this.encryptClientMessage = this.encryptClientMessage.bind(this);
		this.decryptClientMessage = this.decryptClientMessage.bind(this)
		// uniapp APP 外壳的推送设备标识（URL 传入,用于离线推送注册）
		// Push token of the uniapp APP shell (passed via URL, used for offline push registration)
		this.pushToken = (typeof window !== 'undefined' && typeof window.nativePushToken === 'string' && window.nativePushToken) || null;
		// 每次连接会话的注册状态与 cid 迟到重试计时器（cid 可能晚于页面加载到来）
		// Per-session registration state and late-cid retry timer (cid may arrive after page load)
		this.pushTokenRegistered = null;
		this.pushTokenRetryTimer = null;
		// 前台恢复/网络切换时的连通性看门狗（只在浏览器环境生效）
		// Connectivity watchdog on resume/network events (browser environments only)
		this.armLifecycleWatchdog();
	}

	// 注册离线推送设备：cid 已知且加密通道就绪时上送，幂等；返回是否执行了一次注册
	// Register offline push device: upload when both cid and secure channel ready; idempotent
	registerPushToken() {
		const token = (typeof window !== 'undefined' && typeof window.nativePushToken === 'string' && window.nativePushToken) || null;
		if (!token || !this.serverShared || this.pushTokenRegistered === token) {
			return false;
		}
		this.pushToken = token;
		this.pushTokenRegistered = token;
		try {
			this.sendMessage(this.encryptServerMessage({
				a: 'dr',
				p: token
			}, this.serverShared));
		} catch (error) {
			this.logEvent('push-token-register', error, 'error');
			this.pushTokenRegistered = null;
			return false;
		}
		return true;
	}

	// cid 迟到补注册：加入服务器后轮询 window.nativePushToken 最多 30 秒
	// Late-cid registration: poll window.nativePushToken for up to 30s after joining
	armPushTokenRetry() {
		if (this.pushTokenRetryTimer) {
			return;
		}
		const startedAt = Date.now();
		this.pushTokenRetryTimer = setInterval(() => {
			try {
				this.registerPushToken();
				const tokenNow = (typeof window !== 'undefined' && typeof window.nativePushToken === 'string' && window.nativePushToken) || null;
				const registered = tokenNow && this.pushTokenRegistered === tokenNow;
				if (registered || Date.now() - startedAt > 30000) {
					clearInterval(this.pushTokenRetryTimer);
					this.pushTokenRetryTimer = null;
				}
			} catch (error) {
				this.logEvent('push-token-retry', error, 'error');
			}
		}, 2000);
	}

	// 服务器通道建立时调用：先重置会话级注册状态（保证重连后重新上送），再注册
	// Called when the secure channel is established: reset session state (re-register after reconnects)
	initPushTokenRegistration() {
		this.pushTokenRegistered = null;
		if (this.registerPushToken() && this.pushTokenRetryTimer) {
			clearInterval(this.pushTokenRetryTimer);
			this.pushTokenRetryTimer = null;
		}
		this.armPushTokenRetry();
	}

	// Set user credentials (username, channel, password)
	// 设置用户凭证（用户名、频道、密码）
	setCredentials(username, channel, password) {
		this.logEvent('setCredentials');
		try {
			this.credentials = {
				// 服务器频道/推送桶 = sha256(房间名 + NUL + 密码)：同名+不同密码的房间
				// 彻底隔离（WS 频道、设备注册、离线推送互不串扰，修复 §13.14 同名串频）。
				// 密码不单独上送；hash 仍是 64 位 hex，正文 [hash12] 标记长度不变。
				// Server channel/push bucket = sha256(roomName + NUL + password): same-name
				// rooms with different passwords are now fully isolated (WS channel, device
				// registry, offline push). Output stays 64-hex so [hash12] keeps its length.
				username: username,
				channel: sha256(String(channel) + '\u0000' + String(password || '')),
				password: sha256(password)
			}
		} catch (error) {
			this.logEvent('setCredentials', error, 'error');
			return (false)
		}
		return (true)
	}

	// Connect to the server
	// 连接到服务器
	connect() {
		if (!this.credentials) {
			return (false)
		}
		this.logEvent('connect', this.config.wsAddress);
		this.stopReconnect();
		this.stopPing();
		this.serverKeys = null;
		this.serverShared = null;
		this.channel = {};
		this.clearPendingPeerTimers();
		this.connectStartedAt = Date.now();
		this.lastPongAt = 0;
		// 静默丢弃旧连接：其迟到事件不再影响新连接（见下方代次守卫）
		// Silently drop any previous socket; its late events are guarded below
		if (this.connection) {
			try {
				this.connection.onopen = null;
				this.connection.onmessage = null;
				this.connection.onerror = null;
				this.connection.onclose = null;
				this.connection.close()
			} catch (error) {
				this.logEvent('connect-drop-old', error, 'error')
			}
			this.connection = null
		}
		try {
			const socket = new WebSocket(this.config.wsAddress);
			this.connection = socket;
			// 连接代次守卫：事件回调先确认来自当前 socket，否则忽略。
			// 旧连接的 close/error 迟到时不再误杀新连接、不再触发重连风暴
			// Generation guard: handlers ignore events from any socket other than the
			// current one, so a stale close/error can no longer kill a fresh connection
			// or trigger reconnect storms
			socket.onopen = (event) => {
				if (this.connection === socket) this.onOpen(event)
			};
			socket.onmessage = (event) => {
				if (this.connection === socket) this.onMessage(event)
			};
			socket.onerror = (event) => {
				if (this.connection === socket) this.onError(event)
			};
			socket.onclose = (event) => {
				if (this.connection === socket) this.onClose(event)
			}
		} catch (error) {
			this.logEvent('connect', error, 'error');
			return (false)
		}
		return (true)
	}

	// Clean up and disconnect
	// 清理并断开连接
	destruct() {
		this.logEvent('destruct');
		this.stopReconnect();
		this.stopPing();
		this.clearPendingPeerTimers();
		if (this.outboxTimer) {
			clearInterval(this.outboxTimer);
			this.outboxTimer = null
		}
		this.outbox = [];
		this.reconnect = null;
		this.ping = null;
		this.config = {
			rsaPublic: '',
			wsAddress: '',
			reconnectDelay: 3000,
			pingInterval: 10000,
			pongTimeout: 25000,
			pendingHandshakeTimeout: 20000,
			debug: false,
		};
		this.callbacks.onServerClosed = null;
		this.callbacks.onServerSecured = null;
		this.callbacks.onClientSecured = null;
		this.callbacks.onClientList = null;
		this.callbacks.onClientMessage = null;
		this.callbacks.onClientPending = null;
		this.callbacks.onOutbox = null;
		this.onOutbox = null;
		this.clientEc = null;
		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection.onopen = null;
		this.connection.onmessage = null;
		this.connection.onerror = null;
		this.connection.onclose = null;
		try {
			this.connection.removeAllListeners()
		} catch (error) {
			this.logEvent('destruct', error, 'error')
		}
		try {
			this.connection.close()
		} catch (error) {
			this.logEvent('destruct', error, 'error')
		}
		this.connection = null;
		this.channel = {};
		return (true)
	}

	// WebSocket open event handler
	// WebSocket 连接打开事件处理
	async onOpen() {
		this.logEvent('onOpen', this.connectStartedAt ? ('connect→open ' + (Date.now() - this.connectStartedAt) + 'ms') : '');
		this.lastPongAt = Date.now();
		this.startPing();
		try {
			this.serverKeys = await crypto.subtle.generateKey({
				name: 'ECDH',
				namedCurve: 'P-384'
			}, false, ['deriveKey', 'deriveBits']);
			this.serverShared = null;
			this.sendMessage(Buffer.from(await crypto.subtle.exportKey('raw', this.serverKeys.publicKey)).toString('hex'))
		} catch (error) {
			this.logEvent('onOpen', error, 'error')
		}
	}

	// WebSocket message event handler
	// WebSocket 消息事件处理
	async onMessage(event) {
		if (!event || !this.isString(event.data)) {
			return
		}
		if (event.data === 'pong') {
			// pong 是唯一可信的连通证据：更新看门狗时间戳（此前被直接忽略，
			// 半开连接要等 OS TCP 超时 ~1 分钟才被发现）
			// pong is the only trustworthy liveness proof: refresh the watchdog timestamp
			// (previously it was ignored, so half-open sockets were only detected after
			// the OS TCP timeout, ~1 minute)
			const rtt = this.lastPingSentAt ? (Date.now() - this.lastPingSentAt) : null;
			this.lastPongAt = Date.now();
			this.logEvent('pong', rtt !== null ? (rtt + 'ms') : '');
			return
		}
		this.logEvent('onMessage', event.data);
		try {
			const data = JSON.parse(event.data);
			if (data.type === 'server-key') {
				const result = await this.handleServerKey(data.key);
				if (!result) {
					return
				}
			}
		} catch (e) {}
		if (!this.serverShared) {
			const parts = event.data.split('|');
			if (!parts[0] || !parts[1]) {
				return
			}
			try {
				if (await crypto.subtle.verify({
						name: 'RSASSA-PKCS1-v1_5'
					}, await crypto.subtle.importKey('spki', Buffer.from(this.config.rsaPublic, 'base64'), {
						name: 'RSASSA-PKCS1-v1_5',
						hash: {
							name: 'SHA-256'
						}
					}, false, ['verify']), Buffer.from(parts[1], 'base64'), Buffer.from(parts[0], 'hex')) === true) {
					this.serverShared = Buffer.from(await crypto.subtle.deriveBits({
						name: 'ECDH',
						namedCurve: 'P-384',
						public: await crypto.subtle.importKey('raw', Buffer.from(parts[0], 'hex'), {
							name: 'ECDH',
							namedCurve: 'P-384'
						}, true, [])
					}, this.serverKeys.privateKey, 384)).slice(8, 40);
					this.sendMessage(this.encryptServerMessage({
						a: 'j',
						p: this.credentials.channel
					}, this.serverShared));
					// 向服务器注册离线推送设备（加密通道内,服务器只知道房间哈希）
					// Register offline push device (inside the encrypted channel, server only knows the room hash)
					this.initPushTokenRegistration();
					if (this.callbacks.onServerSecured) {
						try {
							this.callbacks.onServerSecured()
						} catch (error) {
							this.logEvent('onMessage-server-secured-callback', error, 'error')
						}
					}
				}
			} catch (error) {
				this.logEvent('onMessage', error, 'error')
			}
			return
		}
		const serverDecrypted = this.decryptServerMessage(event.data, this.serverShared);
		this.logEvent('onMessage-server-decrypted', serverDecrypted);
		if (!this.isObject(serverDecrypted) || !this.isString(serverDecrypted.a)) {
			return
		}
		if (serverDecrypted.a === 'l' && this.isArray(serverDecrypted.p)) {
			// 服务端在名单中带回本端 clientId（i）与主动离开标记（x）
			// Server echoes our own clientId (i) and explicit-leave markers (x) in the list
			if (this.isString(serverDecrypted.i)) {
				this.selfId = serverDecrypted.i;
			}
			const explicitLeftIds = this.isArray(serverDecrypted.x) ? serverDecrypted.x.filter((value) => this.isString(value)) : null;
			let logListResend = 0;
			try {
				for (const clientId in this.channel) {
					if (serverDecrypted.p.indexOf(clientId) < 0) {
						if (this.pendingPeerTimers[clientId]) {
							clearTimeout(this.pendingPeerTimers[clientId]);
							delete this.pendingPeerTimers[clientId]
						}
						delete(this.channel[clientId])
					}
				}
				let payloads = {};
				for (const clientId of serverDecrypted.p) {
					let entry = this.channel[clientId];
					if (!entry) {
						entry = this.channel[clientId] = {
							username: null,
							keys: this.clientEc.genKeyPair(),
							shared: null,
						};
						payloads[clientId] = entry.keys.getPublic('hex')
					} else if (!entry.shared || !entry.username) {
						// 之前条目存在但握手未完成（断链丢包/被冻结）：复用旧密钥对重发公钥，
						// 让服务端的成员表重播能真正触发重新握手；否则只能整条重连才能恢复。
						// Entry exists but the handshake never completed (dropped messages /
						// suspended page): resend the same public key so server member-list
						// rebroadcasts actually retrigger negotiation.
						logListResend += 1;
						payloads[clientId] = entry.keys.getPublic('hex')
					}
					// 新建条目也要挂未握手检查（此前 entry 为 undefined 时漏挂，
					// 单独新建的成员永不进入重发兜底）
					// Newly created entries must be armed too (the old code skipped them
					// because `entry` was still undefined at that point)
					if (!entry.username) {
						this.armPendingPeerCheck(clientId)
					}
				}
				if (Object.keys(payloads).length > 0) {
					// n:0 = 控制类封装：服务器只转发，不触发离线设备推送（防幽灵通知）
					// n:0 = control wrapper: server relays only, no offline-device push
					this.logEvent('onMessage-list', 'peers=' + serverDecrypted.p.length + ' resend=' + logListResend);
					this.sendMessage(this.encryptServerMessage({
						a: 'w',
						n: 0,
						p: payloads,
					}, this.serverShared))
				} else {
					this.logEvent('onMessage-list', 'peers=' + serverDecrypted.p.length + ' resend=0')
				}
			} catch (error) {
				this.logEvent('onMessage-list', error, 'error')
			}
			if (this.callbacks.onClientList) {
				// 名单以服务器 roster 为准：未完成握手的成员也下发（username 为 null），
				// UI 显示"同步中"，人数在各端保持一致；握手完成后名字自动回填
				// The server roster is authoritative: members without a finished handshake
				// are included too (username null, rendered as "syncing"), keeping member
				// counts identical across terminals; names fill in once secured
				let clients = [];
				for (const clientId in this.channel) {
					const entry = this.channel[clientId];
					clients.push({
						clientId: clientId,
						username: (entry.shared && entry.username) ? entry.username : null
					})
				}
				try {
					this.callbacks.onClientList(clients, this.selfId, explicitLeftIds)
				} catch (error) {
					this.logEvent('onMessage-client-list-callback', error, 'error')
				}
			}
			// roster 变化是补发时机：重连入房/新成员就绪都可能让排队消息可投递
			// Roster changes are flush opportunities: a reconnect/rejoin or a newly
			// ready peer can make queued messages deliverable
			try {
				this.flushAndNotifyOutbox()
			} catch (error) {
				this.logEvent('outbox-flush-list', error, 'error')
			}
			return
		}
		if (!this.isString(serverDecrypted.p) || !this.isString(serverDecrypted.c)) {
			return
		}
		if (serverDecrypted.a === 'c' && (!this.channel[serverDecrypted.c] || !this.channel[serverDecrypted.c].shared)) {
			try {
				// 收到的是密文（"iv|counter|ct"）而非 64 位 hex 公钥，且我方尚未建立 shared：
				// 说明对方的公钥在传输中丢失/乱序（服务器并发转发可能重排），我方无法解密。
				// 发 k:1 请求对方重发公钥（同时确保我方公钥已发出），绝不把密文当公钥解析——
				// 旧实现此处抛异常后握手即永久卡死。
				// Incoming payload is ciphertext ("iv|counter|ct"), not a 64-hex public key,
				// while we have no shared key yet: their key was lost/reordered (the server
				// relays concurrently and can reorder). Request it with the k:1 flag (and
				// make sure ours is out) instead of throwing — the old code wedged the
				// handshake permanently right here.
				if (!(this.isString(serverDecrypted.p) && /^[0-9a-f]{64}$/.test(serverDecrypted.p))) {
					if (!this.channel[serverDecrypted.c]) {
						this.channel[serverDecrypted.c] = {
							username: null,
							keys: this.clientEc.genKeyPair(),
							shared: null,
						};
						// n:0 = 控制类封装：服务器只转发，不触发离线设备推送（防幽灵通知）
						// n:0 = control wrapper: server relays only, no offline-device push
						this.sendMessage(this.encryptServerMessage({
							a: 'c',
							n: 0,
							p: this.channel[serverDecrypted.c].keys.getPublic('hex'),
							c: serverDecrypted.c
						}, this.serverShared))
					}
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						n: 0,
						k: 1,
						c: serverDecrypted.c
					}, this.serverShared));
					this.armPendingPeerCheck(serverDecrypted.c);
					return
				}
				if (!this.channel[serverDecrypted.c]) {
					this.channel[serverDecrypted.c] = {
						username: null,
						keys: this.clientEc.genKeyPair(),
						shared: null,
					};
					// n:0 = 控制类封装：服务器只转发，不触发离线设备推送（防幽灵通知）
					// n:0 = control wrapper: server relays only, no offline-device push
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						n: 0,
						p: this.channel[serverDecrypted.c].keys.getPublic('hex'),
						c: serverDecrypted.c
					}, this.serverShared))
				}
				this.channel[serverDecrypted.c].shared = Buffer.from(this.xorHex(this.channel[serverDecrypted.c].keys.derive(this.clientEc.keyFromPublic(serverDecrypted.p, 'hex').getPublic()).toString('hex').padEnd(64, '8').substr(0, 64), this.credentials.password), 'hex');
				this.sendMessage(this.encryptServerMessage({
					a: 'c',
					n: 0,
					p: this.encryptClientMessage({
						a: 'u',
						p: this.credentials.username
					}, this.channel[serverDecrypted.c].shared),
					c: serverDecrypted.c
				}, this.serverShared))
			} catch (error) {
				this.logEvent('onMessage-client', error, 'error')
			}
			return
		}
		if (serverDecrypted.a === 'c' && this.channel[serverDecrypted.c] && this.channel[serverDecrypted.c].shared) {
			// 对方重发公钥（64hex 明文，与密文 "iv|counter|ct" 格式可区分）：说明对方的
			// 重握手在等我们的 u——复用既有 shared 补发 u，双方凭服务端成员表重播完成自愈
			// The peer re-sent its pubkey (64-hex, distinguishable from "iv|counter|ct"
			// ciphertext): their renegotiation is waiting for our u — reply using the
			// already-established shared key so both sides heal via server rebroadcasts
			const resendEntry = this.channel[serverDecrypted.c];
			if (serverDecrypted.k === 1) {
				// 对方缺少我方公钥（其 shared 未建立，见第一分支的 k:1 请求）：
				// 重发我方公钥；若用户名已知，紧随其后补发 u——对方拿到公钥 derive 后
				// 立即可解，双向握手一次恢复（同 socket 顺序传输保证公钥先于 u 到达）
				// The peer lacks our public key (their shared is unset, see the k:1 request
				// in the first branch): re-send our key; if the username is known, follow
				// with u — once they derive, they can decrypt immediately and the handshake
				// heals in one round trip (same-socket ordering guarantees key-before-u)
				try {
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						n: 0,
						p: resendEntry.keys.getPublic('hex'),
						c: serverDecrypted.c
					}, this.serverShared));
					if (resendEntry.username) {
						this.sendMessage(this.encryptServerMessage({
							a: 'c',
							n: 0,
							p: this.encryptClientMessage({
								a: 'u',
								p: resendEntry.username
							}, resendEntry.shared),
							c: serverDecrypted.c
						}, this.serverShared))
					}
				} catch (error) {
					this.logEvent('onMessage-client', error, 'error')
				}
				return
			}
			if (this.isString(serverDecrypted.p) && /^[0-9a-f]{64}$/.test(serverDecrypted.p)) {
				try {
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						n: 0,
						p: this.encryptClientMessage({
							a: 'u',
							p: this.credentials.username
						}, resendEntry.shared),
						c: serverDecrypted.c
					}, this.serverShared))
				} catch (error) {
					this.logEvent('onMessage-client', error, 'error')
				}
				return
			}
			const clientDecrypted = this.decryptClientMessage(serverDecrypted.p, this.channel[serverDecrypted.c].shared);
			this.logEvent('onMessage-client-decrypted', clientDecrypted);
			if (!this.isObject(clientDecrypted) || !this.isString(clientDecrypted.a)) {
				return
			}
			if (clientDecrypted.a === 'u' && this.isString(clientDecrypted.p) && clientDecrypted.p.match(/\S+/) && !this.channel[serverDecrypted.c].username) {
				this.channel[serverDecrypted.c].username = clientDecrypted.p.replace(/^\s+/, '').replace(/\s+$/, '');
				// 该 peer 已完成握手：撤销 8s 未握手提示检查
				// Peer secured: cancel the 8s pending-handshake check
				if (this.pendingPeerTimers[serverDecrypted.c]) {
					clearTimeout(this.pendingPeerTimers[serverDecrypted.c]);
					delete this.pendingPeerTimers[serverDecrypted.c]
				}
				if (this.callbacks.onClientSecured) {
					try {
						this.callbacks.onClientSecured({
							clientId: serverDecrypted.c,
							username: this.channel[serverDecrypted.c].username
						})
					} catch (error) {
						this.logEvent('onMessage-client-secured-callback', error, 'error')
					}
				}
				// 成员就绪是补发时机：此前为 TA 排队的消息现在可以送达
				// A ready peer is a flush opportunity: messages queued for them can deliver now
				try {
					this.flushAndNotifyOutbox()
				} catch (error) {
					this.logEvent('outbox-flush-secured', error, 'error')
				}
				return
			}			if (!this.channel[serverDecrypted.c].username) {
				return
			}
			if (clientDecrypted.a === 'm' && this.isString(clientDecrypted.t) && (this.isString(clientDecrypted.d) || this.isObject(clientDecrypted.d))) {
				if (this.callbacks.onClientMessage) {
					try {
						this.callbacks.onClientMessage({
							clientId: serverDecrypted.c,
							username: this.channel[serverDecrypted.c].username,
							type: clientDecrypted.t,
							data: clientDecrypted.d
						})
					} catch (error) {
						this.logEvent('onMessage-client-message-callback', error, 'error')
					}
				}
				return
			}
		}
	}

	// WebSocket error event handler
	// WebSocket 错误事件处理
	async onError(event) {
		this.logEvent('onError', event, 'error');
		this.disconnect();
		if (this.credentials && !this.paused) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onError-server-closed-callback', error, 'error')
			}
		}
	}

	// WebSocket close event handler
	// WebSocket 关闭事件处理
	async onClose(event) {
		this.logEvent('onClose', event);
		// 主动离开期间（paused）不自动重连，等待 resumePresence
		// No auto-reconnect while intentionally away (paused); wait for resumePresence
		if (this.paused) {
			return
		}
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onClose-server-closed-callback', error, 'error')
			}
		}
	}

	// Log events for debugging
	// 记录事件日志用于调试
	logEvent(source, message, level) {
		if (this.config.debug) {
			const date = new Date(),
				dateString = date.getFullYear() + '-' + ('0' + (date.getMonth() + 1)).slice(-2) + '-' + ('0' + date.getDate()).slice(-2) + ' ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2) + ':' + ('0' + date.getSeconds()).slice(-2);
			console.log('[' + dateString + ']', (level ? level.toUpperCase() : 'INFO'), source + (message ? ':' : ''), (message ? message : ''))
		}
	}

	// Check if connection is open
	// 检查连接是否已打开
	isOpen() {
		return (this.connection && this.connection.readyState && this.connection.readyState === WebSocket.OPEN ? true : false)
	}

	// Check if connection is closed
	// 检查连接是否已关闭
	isClosed() {
		return (!this.connection || !this.connection.readyState || this.connection.readyState === WebSocket.CLOSED ? true : false)
	}

	// Start reconnect timer
	// 启动重连定时器
	startReconnect() {
		this.stopReconnect();
		this.logEvent('startReconnect');
		this.reconnect = setTimeout(() => {
			this.reconnect = null;
			this.connect()
		}, this.config.reconnectDelay)
	}

	// Stop reconnect timer
	// 停止重连定时器
	stopReconnect() {
		if (this.reconnect) {
			this.logEvent('stopReconnect');
			clearTimeout(this.reconnect);
			this.reconnect = null
		}
	}

	// Start ping timer (10s 心跳 + 25s pong 看门狗)
	// 心跳只发不判时，半开连接要等 OS TCP 超时才能恢复（实测 ~1 分钟）。
	// Start ping timer (10s heartbeat + 25s pong watchdog; a half-open socket would
	// otherwise only be detected via the OS TCP timeout, ~1 minute)
	startPing() {
		this.stopPing();
		this.logEvent('startPing');
		this.ping = setInterval(() => {
			if (!this.isOpen()) {
				return
			}
			const now = Date.now();
			if (this.lastPongAt && now - this.lastPongAt > this.config.pongTimeout) {
				this.logEvent('ping-watchdog', 'no pong for ' + (now - this.lastPongAt) + 'ms, forcing reconnect', 'warn');
				this.forceReconnect('ping-watchdog');
				return
			}
			this.lastPingSentAt = now;
			this.sendMessage('ping')
		}, this.config.pingInterval)
	}

	// 主动断开以触发既有 onclose→3s 重连路径；close 失败时回退到 disconnect
	// Force-close to trigger the existing onclose→3s reconnect path; fall back to disconnect
	forceReconnect(why) {
		this.logEvent('forceReconnect', why, 'warn');
		try {
			this.connection.close()
		} catch (error) {
			this.logEvent('forceReconnect', error, 'error');
			this.disconnect();
			if (this.credentials) {
				this.startReconnect()
			}
		}
	}

	// 前台恢复/网络恢复时的连通性检查：socket 不通立即重连；连通但长时间无 pong
	// 先发一次探测 ping，3s 内无回包则强制重连（失败连接借用了挂起的 TCP 缓冲/被
	// 冻结的 webview 都会在这一步被识别）。
	// Connectivity check on visibility/online/focus: reconnect immediately if the socket
	// isn't open; otherwise probe with a ping and force-reconnect if no pong within 3s
	armLifecycleWatchdog() {
		if (typeof window === 'undefined' || typeof document === 'undefined' || this.lifecycleArmed) {
			return
		}
		this.lifecycleArmed = true;
		const refresh = (why) => {
			if (!this.credentials) {
				return
			}
			this.logEvent('lifecycle', why);
			if (this.paused) {
				// 主动离开中（APP 后台/退出房间/页面卸载）：回到可见状态即恢复在线
				// While intentionally away (APP background / room exit / page unload): visibility resumes presence
				this.resumePresence();
				return
			}
			if (!this.connection) {
				this.connect();
				return
			}
			const state = this.connection.readyState;
			if (state === WebSocket.CONNECTING) {
				// 正在握手的连接不该被中断（避免 while-connecting 双重 connect 导致重连风暴）
				// Don't interrupt a connecting socket (avoids double-connect churn)
				this.logEvent('lifecycle', why + ': connecting, keep waiting');
				return
			}
			if (state !== WebSocket.OPEN) {
				this.logEvent('lifecycle', why + ': socket not open, reconnecting now');
				this.stopReconnect();
				this.connect();
				return
			}
			const now = Date.now();
			// 恢复时一律先探测：连接多半还活着，直接强断会在对方端制造"离开/加入"假事件；
			// 3 秒内没有 pong 才真正重连（僵尸 TCP/半开连接场景）
			// Always probe on resume: the socket is usually still alive; force-closing it creates
			// phantom left/joined events on the other side. Reconnect only if no pong in 3s
			// (zombie TCP / half-open socket).
			if (now - (this.lastPongAt || 0) > this.config.pingInterval) {
				this.lastPingSentAt = now;
				this.sendMessage('ping');
				if (this.probeTimer) {
					clearTimeout(this.probeTimer)
				}
				this.probeTimer = setTimeout(() => {
					this.probeTimer = null;
					const stale = this.lastPongAt && (Date.now() - this.lastPongAt) > this.config.pongTimeout;
					if (this.credentials && !this.paused && stale && this.isOpen()) {
						this.forceReconnect('lifecycle-probe')
					}
				}, 3000)
			}
		};
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				refresh('visibility-change')
			}
		});
		window.addEventListener('focus', () => refresh('focus'));
		window.addEventListener('online', () => {
			// 主动离开期间网络恢复不上线（否则 APP 在后台会被错误拉回"在线"）
			// Don't come back online while intentionally away (a backgrounded APP would
			// otherwise reconnect and appear online against the explicit leave)
			if (!this.paused) {
				refresh('online');
			}
		});
		// 关标签/页面卸载：尽力发出主动离开（WS q + sendBeacon 兜底）
		// Tab close / page unload: best-effort explicit leave (WS q + sendBeacon fallback)
		window.addEventListener('pagehide', () => {
			if (this.credentials) {
				this.leavePresence('pagehide');
			}
		});
		// bfcache 恢复（前进/后退缓存复用页面）时需要恢复在线
		// bfcache restore reuses the page; presence must resume
		window.addEventListener('pageshow', (event) => {
			if (this.credentials && event && event.persisted) {
				this.resumePresence();
			}
		});
	}

	// 清理所有未握手 peer 的延时检查器
	// Clear deferred checkers for pending peer handshakes
	clearPendingPeerTimers() {
		for (const peerId in this.pendingPeerTimers) {
			clearTimeout(this.pendingPeerTimers[peerId])
		}
		this.pendingPeerTimers = {}
	}

	// 某 peer 的 username 尚未到达时挂一个 20s 检查：到点仍未 secured → 主动重发我方
	// 公钥触发对方响应并重新挂检查（最多 3 次）；配合服务器 15s 名单重播保证最终收敛。
	//（此前 8s 只打日志不补救，弱网/丢包下握手可永久卡死）
	// When a peer has no username yet, arm a 20s check: on timeout re-send our public
	// key to trigger the peer and re-arm (up to 3 attempts); together with the 15s
	// server roster rebroadcast this guarantees convergence. (Previously it only
	// logged and gave up, so a lost packet could wedge the handshake forever.)
	armPendingPeerCheck(peerId, attempt = 0) {
		if (this.pendingPeerTimers[peerId]) {
			return
		}
		this.pendingPeerTimers[peerId] = setTimeout(() => {
			delete this.pendingPeerTimers[peerId];
			const entry = this.channel[peerId];
			if (!entry || entry.username) {
				return
			}
			this.logEvent('pending-handshake', [peerId, attempt], 'warn');
			// 主动重发我方公钥：对方 shared 未建立则 derive 后回 u；已建立则回 u。
			// 我方连对方公钥都没有时，对方回的 u 会让第一分支走 k:1 请求，链式自愈
			// Re-send our public key: the peer derives (if their shared is unset) and
			// replies u. If we lack THEIR key, their u hits the k:1 heal in our first
			// branch — the whole chain recovers automatically
			if (attempt < 3 && this.isOpen() && this.serverShared) {
				try {
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						n: 0,
						p: entry.keys.getPublic('hex'),
						c: peerId
					}, this.serverShared));
					if (entry.shared) {
						this.sendMessage(this.encryptServerMessage({
							a: 'c',
							n: 0,
							p: this.encryptClientMessage({
								a: 'u',
								p: this.credentials.username
							}, entry.shared),
							c: peerId
						}, this.serverShared))
					}
				} catch (error) {
					this.logEvent('pending-handshake-resend', error, 'error')
				}
				this.armPendingPeerCheck(peerId, attempt + 1)
			}
			if (this.callbacks.onClientPending) {
				try {
					this.callbacks.onClientPending({ clientId: peerId })
				} catch (error) {
					this.logEvent('onClientPending-callback', error, 'error')
				}
			}
		}, this.config.pendingHandshakeTimeout)
	}

	// Stop ping timer
	// 停止心跳定时器
	stopPing() {
		if (this.ping) {
			this.logEvent('stopPing');
			clearInterval(this.ping);
			this.ping = null
		}
		if (this.probeTimer) {
			clearTimeout(this.probeTimer);
			this.probeTimer = null
		}
		this.lastPingSentAt = 0
	}

	// Disconnect from server
	// 从服务器断开连接
	disconnect() {
		this.stopReconnect();
		this.stopPing();
		if (!this.isClosed()) {
			try {
				this.logEvent('disconnect');
				this.connection.close()
			} catch (error) {
				this.logEvent('disconnect', error, 'error')
			}
		}
	}

	// 主动离开：让服务端立即摘除本端（其他成员马上看到"离开对话"），并暂停自动重连。
	// 触发源：APP 切后台/返回首页（uni 桥 evalJS）、浏览器 pagehide（关标签）、退出房间按钮。
	// Explicit leave: the server drops us at once (others see "left" instantly) and auto-reconnect
	// is paused. Sources: APP background/home (uni bridge evalJS), browser pagehide (tab close),
	// and the exit-room button.
	leavePresence(reason) {
		if (this.paused) {
			return
		}
		this.paused = true;
		this.logEvent('leavePresence', reason || '');
		this.stopPing();
		this.stopReconnect();
		try {
			if (this.isOpen() && this.serverShared) {
				// q = 主动辞别：服务端摘除成员并广播（带 x 标记），随后会关闭本连接
				// q = explicit goodbye: the server removes us and broadcasts (x marker), then closes
				this.sendMessage(this.encryptServerMessage({ a: 'q' }, this.serverShared));
			}
		} catch (error) {
			this.logEvent('leavePresence', error, 'error');
		}
		try {
			// sendBeacon 兜底：页面销毁时 WS 消息可能来不及发出；/api/leave 幂等
			// sendBeacon fallback: the WS message may not flush during page teardown; /api/leave is idempotent
			if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' &&
				this.credentials && this.credentials.channel && this.selfId) {
				const beaconUrl = window.location.origin + '/api/leave?hash=' + encodeURIComponent(this.credentials.channel) +
					'&cid=' + encodeURIComponent(this.selfId);
				navigator.sendBeacon(beaconUrl, new Blob([]));
			}
		} catch (error) {
			this.logEvent('leavePresence-beacon', error, 'error');
		}
		try {
			// 主动关闭本地连接：确保 resumePresence 一定走全新连接重新进房
			// （排队的 q 会先于关闭帧发出；即便丢失也有 sendBeacon 兜底）
			// Close the local socket so resumePresence always reconnects fresh (full handshake +
			// rejoin). Queued messages flush before the close frame; even if lost, the beacon covers it.
			if (!this.isClosed()) {
				this.connection.close();
			}
		} catch (error) {
			this.logEvent('leavePresence-close', error, 'error');
		}
	}

	// 恢复在线：清除 paused 并无条件新建连接（APP 回前台 / 页面重新可见 / bfcache 恢复）
	// Resume presence: clear paused and ALWAYS establish a fresh connection
	// (app foreground / page visible / bfcache restore)
	resumePresence() {
		if (!this.paused) {
			return
		}
		this.paused = false;
		this.logEvent('resumePresence');
		if (!this.credentials) {
			return
		}
		// 无条件新建连接：后台/冻结期间 close 事件可能从未派发，readyState 停留在
		// OPEN/CLOSING；此前"仅在 CLOSED 时重连"会让连接变成僵尸（无心跳、无重连、
		// 无重新入房，对端永远看不到回归）。connect() 的代次守卫保证旧 socket 的
		// 迟到事件被完全忽略。
		// Always reconnect: while frozen the close event may never dispatch, leaving
		// readyState OPEN/CLOSING; "reconnect only when CLOSED" created zombie sockets
		// (no ping, no reconnect, no rejoin — peers never see the return). connect()'s
		// generation guard makes stale socket events harmless.
		this.stopReconnect();
		this.stopPing();
		this.connect()
	}

	// Send a message to the server
	// 向服务器发送消息
	sendMessage(message) {
		try {
			if (this.isOpen()) {
				this.connection.send(message);
				return (true)
			}
		} catch (error) {
			this.logEvent('sendMessage', error, 'error')
		}
		return (false)
	}

	// ---------- 发件箱：按人投递 ----------
	// ---------- Per-recipient outbox ----------

	// 入队一条待补发消息。missingIds=null 表示掉线场景（全部 roster 待发）；
	// private=true 走定向 a:'c' 中继，否则走 a:'w' 频道封装
	// Queue a message for later delivery. missingIds=null = offline (whole roster
	// pending); private=true relays via targeted a:'c', otherwise via a:'w'
	queueOutbox(type, data, missingIds, offline, isPrivate) {
		this.outboxSeq += 1;
		const entry = {
			mid: 'ob' + this.outboxSeq + '_' + Date.now(),
			type: type,
			data: data,
			ts: Date.now(),
			pending: missingIds,
			failedFor: null,
			isPrivate: !!isPrivate,
			offline: !!offline,
			done: false
		};
		this.outbox.push(entry);
		// 上限保护：超过 50 条丢弃最旧的（正常交互不可能触达）
		// Cap: drop oldest beyond 50 entries (unreachable in normal use)
		if (this.outbox.length > 50) {
			this.outbox.splice(0, this.outbox.length - 50)
		}
		this.armOutboxTimer();
		return entry
	}

	// 5s 周期兜底：超时（30s）标记失败；期间持续尝试补发
	// 5s safety tick: mark entries failed after 30s; keeps retrying meanwhile
	armOutboxTimer() {
		if (this.outboxTimer) {
			return
		}
		this.outboxTimer = setInterval(() => {
			try {
				this.flushAndNotifyOutbox()
			} catch (error) {
				this.logEvent('outbox-tick', error, 'error')
			}
		}, 5000)
	}

	// 补发 + 状态通知。就绪成员单独重加密补发（只发给缺失者，绝不重复投递）；
	// 缺失者已不在 roster → 标记失败；30s 超时 → 剩余者标记失败
	// Flush + notify. Ready peers are re-encrypted and sent individually (only the
	// missing ones, never duplicating delivered recipients); a missing peer no longer
	// in the roster → failed; after 30s the remainder → failed
	flushAndNotifyOutbox() {
		if (!this.outbox.length) {
			if (this.outboxTimer) {
				clearInterval(this.outboxTimer);
				this.outboxTimer = null
			}
			return
		}
		const now = Date.now();
		for (const entry of this.outbox) {
			if (!entry.done && !(entry.failedFor && entry.failedFor.length) &&
				entry.pending && entry.pending.length && now - entry.ts > 30000) {
				// 超时：剩余未送达者标记失败
				// Timeout: mark the remaining recipients failed
				entry.failedFor = entry.pending.slice();
				entry.pending = []
			}
		}
		if (this.isOpen() && this.serverShared) {
			const rosterIds = Object.keys(this.channel);
			for (const entry of this.outbox) {
				if (entry.done || (entry.failedFor && entry.failedFor.length)) {
					continue
				}
				const pendingIds = entry.pending === null ? rosterIds : entry.pending;
				const stillMissing = [];
				let sentAny = false;
				for (const clientId of pendingIds) {
					const peerEntry = this.channel[clientId];
					if (peerEntry && peerEntry.shared && peerEntry.username) {
						try {
							const clientPayload = this.encryptClientMessage({
								a: 'm',
								t: entry.type,
								d: entry.data
							}, peerEntry.shared);
							if (entry.isPrivate) {
								// 定向私聊中继（与实时私聊同路径）
								// Targeted private relay (same path as realtime private messages)
								this.sendMessage(this.encryptServerMessage({
									a: 'c',
									p: clientPayload,
									c: clientId
								}, this.serverShared))
							} else {
								this.sendMessage(this.encryptServerMessage({
									a: 'w',
									p: {
										[clientId]: clientPayload
									}
								}, this.serverShared))
							}
							sentAny = true
						} catch (error) {
							this.logEvent('outbox-flush', error, 'error');
							stillMissing.push(clientId)
						}
					} else if (rosterIds.indexOf(clientId) < 0) {
						// 缺失者已离开频道：这条对 TA 永远无法送达
						// The missing peer left the channel: undeliverable for them
						entry.failedFor = entry.failedFor || [];
						entry.failedFor.push(clientId)
					} else {
						stillMissing.push(clientId)
					}
				}
				entry.pending = stillMissing;
				if (entry.pending.length === 0 && !(entry.failedFor && entry.failedFor.length)) {
					// 待投递集合清空且无失败者 → 完成（含"无人可投递"的空房间场景）
					// Pending set drained with no failures → done (covers the empty-room case)
					entry.done = true
				}
			}
		}
		if (this.callbacks.onOutbox) {
			try {
				this.callbacks.onOutbox(this.outbox.map((entry) => ({
					mid: entry.mid,
					pending: entry.pending ? entry.pending.length : 0,
					failed: entry.failedFor ? entry.failedFor.length : 0,
					done: !!entry.done,
					offline: !!entry.offline
				})))
			} catch (error) {
				this.logEvent('outbox-notify', error, 'error')
			}
		}
		// 终态条目（已送达/已失败）通知 UI 后移除
		// Terminal entries (done/failed) are removed after notifying the UI
		this.outbox = this.outbox.filter((entry) => !entry.done && !(entry.failedFor && entry.failedFor.length))
	}

	// Send a message to all channels
	// 向所有频道发送消息
	// 按人投递：已就绪成员立即发送；未就绪者进入发件箱，握手完成后自动补发。
	// 语音信令（voice-*）不排队（实时性优先，过期信令无意义）。
	// Per-recipient delivery: ready peers get the message now; unready ones go to the
	// outbox and are flushed once their handshake completes. Voice signaling
	// (voice-*) is never queued (realtime; stale signaling is meaningless).
	sendChannelMessage(type, data) {
		const rosterIds = Object.keys(this.channel);
		const isVoice = this.isString(type) && type.indexOf('voice-') === 0;
		if (!this.serverShared || !this.isOpen()) {
			if (isVoice) {
				return {
					queued: false,
					failed: true,
					delivered: 0,
					total: rosterIds.length
				}
			}
			// 掉线：整条排队，重连入房拿到 roster 后自动发出
			// Offline: queue the whole message; flushed after reconnect + roster
			const entry = this.queueOutbox(type, data, null, true, false);
			return {
				mid: entry.mid,
				queued: true,
				offline: true,
				delivered: 0,
				total: rosterIds.length
			}
		}
		try {
			let payloads = {};
			const missing = [];
			for (const clientId of rosterIds) {
				const entry = this.channel[clientId];
				if (entry.shared && entry.username) {
					payloads[clientId] = this.encryptClientMessage({
						a: 'm',
						t: type,
						d: data
					}, entry.shared);
					if (payloads[clientId].length === 0) {
						return (false)
					}
				} else {
					missing.push(clientId)
				}
			}
			// 无在线 E2E 成员（payloads 为空）也必须发送：服务器借此得知"频道有消息"，
			// 从而触发对离线注册设备的推送（杀进程/首页手机正依赖该路径接收通知）。
			// 空封装对在线成员零影响（relay 无对象）；握手类 'w' 带 n:0 不受波及。
			// MUST send even with an empty payloads map (no online E2E peers): the server
			// needs to learn "message happened in channel" to notify offline registered
			// devices (killed / home-screen phones depend on exactly this path).
			const payload = this.encryptServerMessage({
				a: 'w',
				p: payloads,
			}, this.serverShared);
			if (payload.length === 0 || payload.length > (8 * 1024 * 1024)) {
				return (false)
			}
			this.connection.send(payload);
			const delivered = Object.keys(payloads).length;
			if (missing.length > 0 && !isVoice) {
				// 部分成员未就绪（如"同步中"）：只为缺失者排队，就绪后单独补发
				// Some peers not ready (e.g. still syncing): queue for the missing ones only
				const outboxEntry = this.queueOutbox(type, data, missing, false, false);
				return {
					mid: outboxEntry.mid,
					queued: true,
					offline: false,
					delivered: delivered,
					total: rosterIds.length,
					missing: missing.length
				}
			}
			return {
				queued: false,
				delivered: delivered,
				total: rosterIds.length
			}
		} catch (error) {
			this.logEvent('sendChannelMessage', error, 'error');
			if (!isVoice) {
				const entry = this.queueOutbox(type, data, null, true, false);
				return {
					mid: entry.mid,
					queued: true,
					offline: true,
					delivered: 0,
					total: rosterIds.length
				}
			}
			return {
				queued: false,
				failed: true,
				delivered: 0,
				total: rosterIds.length
			}
		}
	}

	// 定向私聊发送（替代 main.js 手工加密的旧路径），同样支持按人排队补发
	// Targeted private send (replaces main.js manual encryption), with the same
	// per-recipient outbox support
	sendPrivateMessage(targetCid, type, data) {
		if (!this.serverShared || !this.isOpen()) {
			const entry = this.queueOutbox(type, data, [targetCid], true, true);
			return {
				mid: entry.mid,
				queued: true,
				offline: true,
				delivered: 0,
				total: 1
			}
		}
		const peerEntry = this.channel[targetCid];
		if (peerEntry && peerEntry.shared && peerEntry.username) {
			try {
				this.sendMessage(this.encryptServerMessage({
					a: 'c',
					p: this.encryptClientMessage({
						a: 'm',
						t: type,
						d: data
					}, peerEntry.shared),
					c: targetCid
				}, this.serverShared));
				return {
					queued: false,
					delivered: 1,
					total: 1
				}
			} catch (error) {
				this.logEvent('sendPrivateMessage', error, 'error')
			}
		}
		// 对方未就绪（同步中/握手未完成）：排队，就绪后定向补发
		// Peer not ready (syncing / handshake unfinished): queue, flush when ready
		const entry = this.queueOutbox(type, data, [targetCid], false, true);
		return {
			mid: entry.mid,
			queued: true,
			offline: false,
			delivered: 0,
			total: 1
		}
	}

	// Encrypt a message for the server
	// 加密发送给服务器的消息
	encryptServerMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				message = Buffer.from([...message, ...Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
			const cipher = new ModeOfOperation.cbc(key, iv);
			encrypted = iv.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptServerMessage', error, 'error')
		}
		return (encrypted)
	}

	// Decrypt a message from the server
	// 解密来自服务器的消息
	decryptServerMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new ModeOfOperation.cbc(key, Buffer.from(parts[0], 'base64'));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[1], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptServerMessage', error, 'error')
		}
		return (decrypted)
	}

	// Encrypt a message for a client
	// 加密发送给客户端的消息
	encryptClientMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				message = Buffer.from([...message, ...Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
			const counter = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
			const cipher = new chacha(key, iv, counter.reduce((a, b) => a * b));
			encrypted = iv.toString('base64') + '|' + counter.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptClientMessage', error, 'error')
		}
		return (encrypted)
	}

	// Decrypt a message from a client
	// 解密来自客户端的消息
	decryptClientMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new chacha(key, Buffer.from(parts[0], 'base64'), Buffer.from(parts[1], 'base64').reduce((a, b) => a * b));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[2], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptClientMessage', error, 'error')
		}
		return (decrypted)
	}

	// XOR two hex strings
	// 对两个十六进制字符串进行异或
	xorHex(a, b) {
		let result = '',
			hexLength = Math.min(a.length, b.length);
		for (let i = 0; i < hexLength; ++i) {
			result += (parseInt(a.charAt(i), 16) ^ parseInt(b.charAt(i), 16)).toString(16)
		}
		return (result)
	}

	// Check if value is a string
	// 检查值是否为字符串
	isString(value) {
		return (value && Object.prototype.toString.call(value) === '[object String]' ? true : false)
	}

	// Check if value is an array
	// 检查值是否为数组
	isArray(value) {
		return (value && Object.prototype.toString.call(value) === '[object Array]' ? true : false)
	}

	// Check if value is an object
	// 检查值是否为对象
	isObject(value) {
		return (value && Object.prototype.toString.call(value) === '[object Object]' ? true : false)
	}

	// Handle server public key
	// 处理服务器公钥
	async handleServerKey(serverKey) {
		this.logEvent('handleServerKey', 'Received server key');
		localStorage.removeItem(this.SERVER_KEY_STORAGE);
		localStorage.setItem(this.SERVER_KEY_STORAGE, serverKey);
		this.config.rsaPublic = serverKey;
		return true
	}
};

if (typeof window !== 'undefined') {
	window.NodeCrypt = NodeCrypt
}