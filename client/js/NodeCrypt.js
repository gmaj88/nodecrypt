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
			pendingHandshakeTimeout: config.pendingHandshakeTimeout || 8000,
			debug: config.debug || false,
		};
		this.callbacks = {
			onServerClosed: callbacks.onServerClosed || null,
			onServerSecured: callbacks.onServerSecured || null,
			onClientSecured: callbacks.onClientSecured || null,
			onClientList: callbacks.onClientList || null,
			onClientMessage: callbacks.onClientMessage || null,
			onClientPending: callbacks.onClientPending || null,
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
		// 每个尚未完成握手的 peer 的延时检查器（8s 后仍未 secured → onClientPending）
		// Deferred checkers for peers that never finish the handshake (8s → onClientPending)
		this.pendingPeerTimers = {};
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
		try {
			this.connection = new WebSocket(this.config.wsAddress);
			this.connection.onopen = this.onOpen;
			this.connection.onmessage = this.onMessage;
			this.connection.onerror = this.onError;
			this.connection.onclose = this.onClose
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
		this.reconnect = null;
		this.ping = null;
		this.config = {
			rsaPublic: '',
			wsAddress: '',
			reconnectDelay: 3000,
			pingInterval: 10000,
			pongTimeout: 25000,
			pendingHandshakeTimeout: 8000,
			debug: false,
		};
		this.callbacks.onServerClosed = null;
		this.callbacks.onServerSecured = null;
		this.callbacks.onClientSecured = null;
		this.callbacks.onClientList = null;
		this.callbacks.onClientMessage = null;
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
					const entry = this.channel[clientId];
					if (!entry) {
						this.channel[clientId] = {
							username: null,
							keys: this.clientEc.genKeyPair(),
							shared: null,
						};
						payloads[clientId] = this.channel[clientId].keys.getPublic('hex')
					} else if (!entry.shared || !entry.username) {
						// 之前条目存在但握手未完成（断链丢包/被冻结）：复用旧密钥对重发公钥，
						// 让服务端的成员表重播能真正触发重新握手；否则只能整条重连才能恢复。
						// Entry exists but the handshake never completed (dropped messages /
						// suspended page): resend the same public key so server member-list
						// rebroadcasts actually retrigger negotiation.
						logListResend += 1;
						payloads[clientId] = entry.keys.getPublic('hex')
					}
					if (entry && !entry.username) {
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
				let clients = [];
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						clients.push({
							clientId: clientId,
							username: this.channel[clientId].username
						})
					}
				}
				try {
					this.callbacks.onClientList(clients)
				} catch (error) {
					this.logEvent('onMessage-client-list-callback', error, 'error')
				}
			}
			return
		}
		if (!this.isString(serverDecrypted.p) || !this.isString(serverDecrypted.c)) {
			return
		}
		if (serverDecrypted.a === 'c' && (!this.channel[serverDecrypted.c] || !this.channel[serverDecrypted.c].shared)) {
			try {
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
		if (this.credentials) {
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
			if (this.lastPongAt && now - this.lastPongAt > this.config.pongTimeout) {
				this.forceReconnect(why + ': stale (no pong ' + (now - this.lastPongAt) + 'ms)');
				return
			}
			if (now - (this.lastPongAt || 0) > this.config.pingInterval) {
				this.lastPingSentAt = now;
				this.sendMessage('ping');
				if (this.probeTimer) {
					clearTimeout(this.probeTimer)
				}
				this.probeTimer = setTimeout(() => {
					this.probeTimer = null;
					const stale = this.lastPongAt && (Date.now() - this.lastPongAt) > this.config.pongTimeout;
					if (this.credentials && stale && this.isOpen()) {
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
		window.addEventListener('online', () => refresh('online'));
	}

	// 清理所有未握手 peer 的延时检查器
	// Clear deferred checkers for pending peer handshakes
	clearPendingPeerTimers() {
		for (const peerId in this.pendingPeerTimers) {
			clearTimeout(this.pendingPeerTimers[peerId])
		}
		this.pendingPeerTimers = {}
	}

	// 某 peer 的 username 尚未到达时挂一个 8s 检查：到点仍未 secured → onClientPending。
	// 这把"密码不一致/链路丢包导致的静默隐身"变成可见的系统提示。
	// Schedule an 8s check when a peer has no username yet; if still unsecured →
	// onClientPending. Turns silent invisibility (password mismatch / lost handshake)
	// into a visible system notice.
	armPendingPeerCheck(peerId) {
		if (this.pendingPeerTimers[peerId]) {
			return
		}
		this.pendingPeerTimers[peerId] = setTimeout(() => {
			delete this.pendingPeerTimers[peerId];
			const entry = this.channel[peerId];
			if (!entry || entry.username) {
				return
			}
			this.logEvent('pending-handshake', peerId, 'warn');
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

	// Send a message to all channels
	// 向所有频道发送消息
	sendChannelMessage(type, data) {
		if (this.serverShared) {
			try {
				let payloads = {};
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						payloads[clientId] = this.encryptClientMessage({
							a: 'm',
							t: type,
							d: data
						}, this.channel[clientId].shared);
						if (payloads[clientId].length === 0) {
							return (false)
						}
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
				if (!this.isOpen() || payload.length === 0 || payload.length > (8 * 1024 * 1024)) {
					return (false)
				}
				this.connection.send(payload)
			return (true)
			} catch (error) {
				this.logEvent('sendChannelMessage', error, 'error')
			}
		}
		return (false)
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