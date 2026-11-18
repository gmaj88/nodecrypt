import { generateClientId, encryptMessage, decryptMessage, logEvent, isString, isObject, getTime } from './utils.js';
import { upsertDevice, markDeviceOffline, notifyOfflineDevices, readNotifyLog, removeDevice, listAllDevices, purgeDevices, debugPush, debugTaskDetail } from './push.js';
import { getVoiceTurnIceServers } from './voiceTurn.js';
import { APP_VERSION } from './appVersion.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理WebSocket请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader === 'websocket') {
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 语音 TURN 凭据端点：返回短时 ICE 服务器配置（失败时客户端降级纯 STUN）
    // Voice TURN endpoint: short-lived ICE config; clients fall back to STUN-only on failure
    if (url.pathname === '/voice-turn') {
      const iceServers = await getVoiceTurnIceServers();
      return new Response(JSON.stringify({ iceServers }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    // 推送诊断端点：把请求转交给 ChatRoom DO（设备与推送记录都在它这里）
    // Push diagnostic endpoint: forward requests to the ChatRoom DO (devices & push records live there)
    if (url.pathname === '/api/push-test') {
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 断线取证端点：转交 ChatRoom DO（连接/清理/alarm/驱逐计数）
    // Idle-drop forensics endpoint: forwarded to the ChatRoom DO (connect/reap/alarm/eviction counters)
    if (url.pathname === '/api/diag') {
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 主动离开上报：页面销毁时 WS 消息可能来不及发出，sendBeacon 走这里转发进 DO
    // Explicit leave report: WS messages may not flush during page teardown; beacons come through here
    if (url.pathname === '/api/leave') {
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // APP 自动更新版本检查：返回最新 APK 版本信息（mirror 为构建用内部字段，不返回）
    // APP auto-update check: latest APK version info (the internal build-only mirror field is excluded)
    // 必须放在通用 /api/ stub 之前；no-store 防止任何缓存层滞留旧版本
    // Must sit before the generic /api/ stub; no-store keeps every cache layer off stale versions
    if (url.pathname === '/api/app-version') {
      return new Response(JSON.stringify({
        versionCode: APP_VERSION.versionCode,
        versionName: APP_VERSION.versionName,
        url: APP_VERSION.url,
        size: APP_VERSION.size,
        sha256: APP_VERSION.sha256,
        note: APP_VERSION.note,
        force: APP_VERSION.force
      }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    // 处理API请求
    if (url.pathname.startsWith('/api/')) {
      // ...API 逻辑...
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    // 其余全部交给 ASSETS 处理（自动支持 hash 文件名和 SPA fallback）
    return env.ASSETS.fetch(request);
  }
};

export class ChatRoom {  constructor(state, env) {
    this.state = state;
    this.env = env;
    
    // Use objects like original server.js instead of Maps
    this.clients = {};
    this.channels = {};
    // 每连接的串行处理队列：加密中继含多次 await，并发处理会把后续消息先转发
    // （如"公钥"晚于其后的加密 u 到达接收端），造成握手竞态永久卡死
    // Per-connection serial queues: relays involve several awaits; concurrent
    // processing can reorder deliveries (a key arriving after a later encrypted u)
    // and permanently wedge handshakes
    this.clientQueues = {};

    // 诊断：内存环形事件 + 计数（/api/diag 拉取），用于区分空闲断线的真因
    // （DO 驱逐 / 服务端 reaping / 客户端自杀重连）
    // Diagnostics: in-memory ring + counters (via /api/diag) to tell idle-drop causes
    // apart (DO eviction / server-side reaping / client-initiated reconnects)
    this.diag = {
      ring: [],
      counts: {
        connects: 0,
        closes: 0,
        reaped: 0,
        alarms: 0,
        heartbeats: 0,
        uidReplaced: 0,
        notifySkipped: 0,
        notifyPushed: 0,
        relayDropped: 0
      }
    };
    this.notifyAt = {}; // 频道级推送节流时间戳 / per-channel push throttle timestamps
    // 客户端上报的断线原因（bye:why）与服务端主动杀连接的标记，close 事件并入 detail
    // Client-reported close reasons (bye:why) and server-side kill tags, merged into
    // the close event detail
    this.closeReasons = {};
    // 非主动断开的宽限登记：clientId → {channel, uid, closedAt, reason}。
    // 宽限期内同 uid 重连则接管旧 clientId（名单零变化），期满才真正摘除并广播。
    // Grace registry for non-explicit disconnects: clientId → {...}. A same-uid
    // rejoin within the grace takes over the old clientId (roster unchanged);
    // expiry finally removes and broadcasts.
    this.pendingLeave = {};
    // 连接 → 当前 clientId 的动态映射：uid 接管/恢复会把新连接绑到旧 id 上，
    // 消息与 close 监听必须按当前绑定解析，否则会路由到已删除的临时 id
    // connection → current clientId map: uid takeover/rebind attaches a new socket
    // to the old id; message/close listeners must resolve the live binding or they
    // would route to a deleted provisional id
    this.connIds = new WeakMap();

    this.config = {
      // 180s：客户端心跳在后台标签/省电模式会被节流到分钟级，90s 会把还活着的
      // 连接误清理并制造僵尸名单；被动断开的半开连接由 close 事件与 alarm 兜底
      // 180s: client heartbeats are throttled to ~1/min in background tabs / power
      // saving; 90s reaped live connections and polluted rosters with ghosts.
      // Half-open sockets are bounded by close events and the periodic alarm.
      seenTimeout: 180000,
      // 周期清理 alarm 间隔：不再依赖"有人新连接"才触发 cleanupOldConnections，
      // 旧连接的超时清理与成员变化广播由 alarm 兜底
      // Periodic-cleanup alarm interval: cleanup no longer depends on new connections
      cleanupInterval: 15000,
      // 同频道离线推送最小间隔：逐帧推送会造成轰炸 + DO 串行队列堵塞
      // Min interval between offline pushes per channel: per-frame pushes caused
      // notification storms and stalled the DO serial queue
      notifyThrottle: 60000, // 频道级推送节流 60s：离线期间密集聊天/文件分卷最多 1 条/分钟
      // 非主动断开的宽限期：网络抖动几秒~十几秒落在宽限期内，名单不广播不闪；
      // 期满（实际摘除受 15s alarm 粒度影响，最坏 +15s）才广播带 x 的"已离开"
      // Grace period for non-explicit disconnects: jitter of a few to tens of
      // seconds stays invisible to rosters; expiry (alarm granularity may add up
      // to 15s) finally broadcasts the x-marked "left"
      pendingLeaveGrace: 30000,
      debug: false
    };

    // Initialize RSA key pair
    this.initRSAKeyPair();
  }

  // 记录一条诊断事件（内存环形，最多 60 条）
  // Append a diagnostic event (in-memory ring, max 60)
  noteDiag(event, detail) {
    const ring = this.diag.ring;
    ring.push({ ts: Date.now(), event: event, detail: detail === undefined ? null : detail });
    if (ring.length > 60) {
      ring.splice(0, ring.length - 60);
    }
    if (this.diag.counts[event] !== undefined) {
      this.diag.counts[event] += 1;
    }
  }

  async initRSAKeyPair() {
    try {
      let stored = await this.state.storage.get('rsaKeyPair');
      if (!stored) {
        console.log('Generating new RSA keypair...');
          const keyPair = await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
          },
          true,
          ['sign', 'verify']
        );

        // 并行导出公钥和私钥以提高性能
        const [publicKeyBuffer, privateKeyBuffer] = await Promise.all([
          crypto.subtle.exportKey('spki', keyPair.publicKey),
          crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
        ]);
        
        stored = {
          rsaPublic: btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer))),
          rsaPrivateData: Array.from(new Uint8Array(privateKeyBuffer)),
          createdAt: Date.now() // 记录密钥创建时间，用于后续判断是否需要轮换
        };
        
        await this.state.storage.put('rsaKeyPair', stored);
        console.log('RSA key pair generated and stored');
      }
      
      // Reconstruct the private key
      if (stored.rsaPrivateData) {
        const privateKeyBuffer = new Uint8Array(stored.rsaPrivateData);
        
        stored.rsaPrivate = await crypto.subtle.importKey(
          'pkcs8',
          privateKeyBuffer,
          {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256'
          },
          false,
          ['sign']
        );      }
        this.keyPair = stored;
      
      // 检查密钥是否需要轮换（如果已创建超过24小时）
      if (stored.createdAt && (Date.now() - stored.createdAt > 24 * 60 * 60 * 1000)) {
        // 如果没有任何客户端，则执行密钥轮换
        if (Object.keys(this.clients).length === 0) {
          console.log('密钥已使用24小时，进行轮换...');
          await this.state.storage.delete('rsaKeyPair');
          this.keyPair = null;
          await this.initRSAKeyPair();
        } else {
          // 否则标记需要在客户端全部断开后进行轮换
          await this.state.storage.put('pendingKeyRotation', true);
        }
      }
    } catch (error) {
      console.error('Error initializing RSA key pair:', error);
      throw error;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 诊断端点：内存环形事件 + 计数 + DO 实例启动次数（持久化）
    // → 空闲断线取证：doStarts 持续增长且 clients:0 ⇒ DO 被驱逐/重置；
    //   reaped 增长 ⇒ 服务端 reaping；两者都不动 ⇒ 客户端自杀重连
    // Diagnostics endpoint: in-memory ring + counters + DO instance starts (persisted)
    // → idle-drop forensics: growing doStarts with clients:0 ⇒ DO eviction/reset;
    //   growing reaped ⇒ server-side reaping; neither ⇒ client-initiated reconnect
    if (url.pathname === '/api/diag') {
      try {
        if (!this.doStartsCounted) {
          this.doStartsCounted = true;
          const starts = ((await this.state.storage.get('diag:do-starts')) || 0) + 1;
          await this.state.storage.put('diag:do-starts', starts);
          this.doStarts = starts;
        }
        return new Response(JSON.stringify({
          doStarts: this.doStarts || ((await this.state.storage.get('diag:do-starts')) || 0),
          counts: this.diag.counts,
          clients: Object.keys(this.clients).length,
          // 每个连接的详情：id / uid 前 8 位 / 服务端握手（shared）是否完成 /
          // 频道 / 多久没活动——配合成员"正在加入"定位是哪个端卡住、卡在哪一步
          // Per-connection details: id / first 8 of uid / whether the server-side
          // handshake (shared) completed / channel / idle time — pairs with the
          // member "joining" view to pinpoint which terminal is stuck and where
          clientDetails: Object.keys(this.clients).map((id) => {
            const c = this.clients[id];
            return {
              id: id,
              uid: c.uid ? c.uid.slice(0, 8) : null,
              shared: c.shared ? true : false,
              channel: c.channel ? c.channel.slice(0, 8) : null,
              seenAgoMs: c.seen ? (Date.now() - c.seen) : null
            };
          }),
          channels: Object.keys(this.channels).length,
          events: this.diag.ring
        }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error && error.message || error) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 主动离开端点：sendBeacon / APP 原生桥的 HTTP 兜底（WS q 之外的第二通道，幂等）
    // Explicit leave endpoint: HTTP fallback for sendBeacon / native APP bridge (second channel
    // alongside the WS q action, idempotent)
    // 仅当 cid 存在且其频道与 hash 一致才执行，防止误踢他人
    // Only acts when the cid exists and its channel matches the hash (anti-miskick guard)
    if (url.pathname === '/api/leave') {
      try {
        const hash = url.searchParams.get('hash') || '';
        const cid = url.searchParams.get('cid') || '';
        const client = this.clients[cid];
        if (client && hash && client.channel === hash) {
          await this.leaveChannel(cid, true);
        }
        return new Response(null, { status: 204 });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error && error.message || error) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 推送诊断端点（临时排查用）：不带 hash 仅列出设备；?hash=x&push=1 实际下发一条推送并返回全过程
    // Push diagnostic endpoint (temporary): without hash lists devices; with ?hash=x&push=1 sends a test push
    if (url.pathname === '/api/push-test') {
      try {
        const params = url.searchParams;
        const hash = params.get('hash');
        if (params.get('purge') === '1') {
          // 测试期辅助：清空指定（或全部）hash 的设备注册，清除重装残留 cid
          // Test aid: wipe device registrations for a hash (or all) to clear stale reinstall cids
          const deleted = await purgeDevices(this.state.storage, hash);
          return new Response(JSON.stringify({ purged: true, hash: hash || 'all', removed: deleted }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        if (hash && params.get('forget')) {
          // 手动移出单个失效 cid（重装残留 20001 场景）
          // Manually drop one invalid cid (stale reinstall residue returning 20001)
          const cid = params.get('forget');
          const removed = await removeDevice(this.state.storage, hash, cid);
          return new Response(JSON.stringify({ forgot: cid, removed, hash }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        if (params.get('report') === '1') {
          const taskid = params.get('taskid') || '';
          const cid = params.get('cid') || '';
          if (!taskid || !cid) {
            return new Response(JSON.stringify({ error: 'taskid & cid required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
          }
          const data = await debugTaskDetail(this.env, this.state.storage, cid, taskid);
          return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        if (hash) {
          if (params.get('notifylog') === '1') {
            // 通知日志：notifyOfflineDevices 的逐次触发与逐 cid 个推返回（服务器侧取证）
            // Notify log: per-call triggers and per-cid Getui responses (server-side evidence)
            const log = params.get('push') === '1'
              ? { notifyLog: await readNotifyLog(this.state.storage, hash), push: await debugPush(this.env, this.state.storage, hash, params.get('test') === '1', params.get('cid')) }
              : { notifyLog: await readNotifyLog(this.state.storage, hash) };
            return new Response(JSON.stringify(log), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
          }
          const data = params.get('push') === '1'
            ? await debugPush(this.env, this.state.storage, hash, params.get('test') === '1', params.get('cid'))
            : { channelHash: hash, note: 'add &push=1 to send a test push' };
          return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        const devices = await listAllDevices(this.state.storage);
        return new Response(JSON.stringify({ note: 'add ?hash=<hash>&push=1 to send a test push', keys: devices }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error && error.message || error) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    // Ensure RSA keys are initialized
    if (!this.keyPair) {
      await this.initRSAKeyPair();
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket connection
    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }  // WebSocket connection event handler
  async handleSession(connection) {    connection.accept();

    // 清理旧连接
    await this.cleanupOldConnections();

    const clientId = generateClientId();

    if (!clientId || this.clients[clientId]) {
      this.closeConnection(connection);
      return;
    }

    logEvent('connection', clientId, 'debug');    // Store client information
    this.noteDiag('connects', clientId);
    this.clients[clientId] = {
      connection: connection,
      seen: getTime(),
      key: null,
      shared: null,
      channel: null,
      uid: null
    };

    // 新连接确保周期清理 alarm 在位（空转时由 cleanup 取消）
    // New connection: make sure the periodic cleanup alarm is scheduled
    // (cleanup cancels it when no clients remain)
    await this.scheduleCleanupAlarm();

    // Send RSA public key
    try {
      logEvent('sending-public-key', clientId, 'debug');
      this.sendMessage(connection, JSON.stringify({
        type: 'server-key',
        key: this.keyPair.rsaPublic
      }));
    } catch (error) {
      logEvent('sending-public-key', error, 'error');
    }    // Handle messages
    connection.addEventListener('message', async (event) => {
      const message = event.data;

      // 动态解析当前绑定：uid 接管/恢复会把新连接挂到旧 clientId 下，
      // 按临时 id 找条目会扑空导致消息全部丢失
      // Resolve the live binding: uid takeover/rebind attaches a new socket to the
      // old clientId; looking up by the provisional id would find nothing and drop
      // every subsequent message
      const cid = this.connIds.get(connection) || clientId;
      const entry = this.clients[cid];

      if (!isString(message) || !entry || entry.connection !== connection) {
        return;
      }

      entry.seen = getTime();

      if (message === 'ping') {
        this.sendMessage(connection, 'pong');
        return;
      }
      // 客户端自杀重连前的告别帧（bye:ping-watchdog / bye:lifecycle-probe）：
      // 原因并入随后的 close 事件，diag 一眼看出断线路径
      // Farewell frame before a client-initiated reconnect (bye:ping-watchdog /
      // bye:lifecycle-probe): the reason is merged into the close event so the diag
      // shows which path closed the socket
      if (message.startsWith('bye:')) {
        this.closeReasons[cid] = message.slice(4) || 'client-bye';
        entry.seen = getTime();
        return;
      }
      logEvent('message', [cid, message.length], 'debug');      // Handle key exchange
      if (!entry.shared && message.length < 2048) {
        try {
          // Generate ECDH key pair using P-384 curve (equivalent to secp384r1)
          const keys = await crypto.subtle.generateKey(
            {
              name: 'ECDH',
              namedCurve: 'P-384'
            },
            true,
            ['deriveBits', 'deriveKey']
          );

          const publicKeyBuffer = await crypto.subtle.exportKey('raw', keys.publicKey);
          
          // Sign the public key using PKCS1 padding (compatible with original)
          const signature = await crypto.subtle.sign(
            {
              name: 'RSASSA-PKCS1-v1_5'
            },
            this.keyPair.rsaPrivate,
            publicKeyBuffer
          );

          // Convert hex string to Uint8Array for client public key
          const clientPublicKeyHex = message;
          const clientPublicKeyBytes = new Uint8Array(clientPublicKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          
          // Import client's public key
          const clientPublicKey = await crypto.subtle.importKey(
            'raw',
            clientPublicKeyBytes,
            { name: 'ECDH', namedCurve: 'P-384' },
            false,
            []
          );

          // Derive shared secret bits (equivalent to computeSecret in Node.js)
          const sharedSecretBits = await crypto.subtle.deriveBits(
            {
              name: 'ECDH',
              public: clientPublicKey
            },
            keys.privateKey,
            384 // P-384 produces 48 bytes (384 bits)
          );          // Take bytes 8-40 (32 bytes) for AES-256 key
          entry.shared = new Uint8Array(sharedSecretBits).slice(8, 40);

          const response = Array.from(new Uint8Array(publicKeyBuffer))
            .map(b => b.toString(16).padStart(2, '0')).join('') + 
            '|' + btoa(String.fromCharCode(...new Uint8Array(signature)));
          
          this.sendMessage(connection, response);

        } catch (error) {
          logEvent('message-key', [cid, error], 'error');
          this.closeReasons[cid] = 'key-error';
          this.closeConnection(connection);
        }

        return;
      }

      // Handle encrypted messages (serialized per connection — see clientQueues)
      if (entry.shared && message.length <= (8 * 1024 * 1024)) {
        const previous = this.clientQueues[cid] || Promise.resolve();
        this.clientQueues[cid] = previous
          .catch(() => {})
          .then(() => this.processEncryptedMessage(cid, message));
      }
    });    // Handle connection close
    connection.addEventListener('close', async (event) => {
      logEvent('close', [clientId, event && event.code, event && event.wasClean], 'debug');
      // 断线取证：close code/是否主动（wasClean）+ 断线原因（客户端 bye 上报或
      // 服务端主动杀标记）是区分"服务端杀"与"客户端走"的关键
      // Idle-drop forensics: close code / wasClean + reason (client bye report or
      // server-side kill tag) distinguishes server-side kills from client exits
      const cid = this.connIds.get(connection) || clientId;
      const closeReason = this.closeReasons[cid] || null;
      delete(this.closeReasons[cid]);
      this.noteDiag('closes', [cid, event ? event.code : null, event ? event.wasClean : null, closeReason]);

      // 陈旧连接守卫：uid-replace 接管后旧连接的迟到 close 不得影响新连接
      // Stale-connection guard: a replaced socket's late close event must not touch
      // the connection that took over its identity
      const entry = this.clients[cid];
      if (!entry || entry.connection !== connection) {
        return;
      }

      delete(this.clientQueues[cid]);
      // 非主动断开进入宽限期：有 uid 挂 pendingLeave（名单不广播不变化），
      // 无 uid 退化为立即摘除广播；主动退出（q）在 leaveChannel(true) 已摘除，
      // 此时 channel 为 null，只做条目清理
      // Non-explicit disconnect enters the grace period: with a uid, register
      // pendingLeave (roster stays put); without a uid, fall back to immediate
      // removal+broadcast. Explicit leaves were already handled by
      // leaveChannel(true) — channel is null here, just clean up the entry
      await this.markPendingLeave(cid, closeReason || 'abrupt-close');

      // cleanupOldConnections 可能已删除该客户端，需要防御缺失
      // cleanupOldConnections may have already deleted this client; guard against it
      if (this.clients[clientId]) {
        delete(this.clients[clientId]);
      }
    });
  }
  // 统一离开出口：摘除成员、广播名单、设备转离线。
  // explicit=true 表示主动离开（WS q / /api/leave）：名单带 x 标记 → 其他端立即提示，并关闭连接；
  // explicit=false 现在只作为无 uid 旧客户端的兜底（有 uid 的非主动断开走 markPendingLeave 宽限）
  // Unified leave path: remove member, broadcast list, mark device offline.
  // explicit=true = intentional leave (WS q / /api/leave): list carries the x marker so
  // peers notify instantly, and the connection is closed; explicit=false is now only
  // the fallback for legacy uid-less clients (uid-carrying abrupt disconnects go
  // through the markPendingLeave grace path)
  async leaveChannel(clientId, explicit) {
    const clientInfo = this.clients[clientId];
    const channel = clientInfo ? (clientInfo.channel || null) : null;
    if (!channel) {
      return;
    }
    clientInfo.channel = null;
    if (this.channels[channel]) {
      // 用 filter 摘除成员：旧实现用 indexOf+splice，若 indexOf 为 -1
      // 会误删数组最后一个成员；且仅在确实发生变化时广播
      // Remove via filter: the old indexOf+splice dropped the wrong member on -1;
      // broadcast only when membership actually changed
      const remaining = this.channels[channel].filter((id) => id !== clientId);
      if (remaining.length !== this.channels[channel].length) {
        this.channels[channel] = remaining;

        if (remaining.length === 0) {
          delete(this.channels[channel]);
        } else {
          this.broadcastMemberList(channel, explicit ? [clientId] : null);
        }
      }
    }

    // 将该连接关联的推送设备标记为离线，使其成为离线推送的目标
    // Mark push devices linked to this connection offline so they become offline push targets
    try {
      await markDeviceOffline(this.state.storage, channel, clientId);
    } catch (error) {
      logEvent('leave-device-offline', [clientId, error], 'error');
    }

    if (explicit && clientInfo.connection) {
      this.closeReasons[clientId] = this.closeReasons[clientId] || 'explicit-leave';
      try {
        clientInfo.connection.close();
      } catch (error) {
        logEvent('leave-close', [clientId, error], 'error');
      }
    }
  }
  // 非主动断开：宽限登记。有 uid → 从 clients/clientQueues 删除条目但**保留
  // channels 成员位**，名单不广播不变化；宽限期内同 uid 重连由 join 接管旧 id
  // 静默恢复；无 uid → 退化为旧的立即摘除广播。幂等：重复调用（close 事件与
  // reap 并发）只登记一次。
  // Non-explicit disconnect: register the grace. With a uid → drop the clients/
  // clientQueues entries but KEEP the channels slot; the roster is neither
  // broadcast nor changed; a same-uid rejoin within grace takes over the old id
  // silently via join. Without a uid → legacy immediate removal+broadcast.
  // Idempotent: concurrent close-event/reap calls register only once.
  async markPendingLeave(clientId, reason) {
    const entry = this.clients[clientId];
    const channel = entry ? (entry.channel || null) : null;
    delete(this.clientQueues[clientId]);
    if (!channel) {
      // 主动离开（channel 已被 leaveChannel 清空）或从未入频道：只清条目
      // Explicit leave (channel already cleared) or never joined: entry cleanup only
      if (entry) {
        delete this.clients[clientId];
      }
      return;
    }
    const uid = entry.uid || null;
    entry.channel = null;
    // 断开立即转离线：离线推送不因宽限期而延迟
    // Mark devices offline right away: offline push is not delayed by the grace
    try {
      await markDeviceOffline(this.state.storage, channel, clientId);
    } catch (error) {
      logEvent('pending-device-offline', [clientId, error], 'error');
    }
    if (!uid) {
      // 无 uid 无法按身份归并重连：保持旧行为（立即摘除并广播，无 x）
      // Without a uid there is nothing to match a rejoin against: keep the legacy
      // behavior (immediate removal + broadcast, no x)
      const members = this.channels[channel];
      if (members) {
        const remaining = members.filter((id) => id !== clientId);
        if (remaining.length === 0) {
          delete this.channels[channel];
        } else {
          this.channels[channel] = remaining;
        }
      }
      delete this.clients[clientId];
      this.broadcastMemberList(channel);
      return;
    }
    if (this.pendingLeave[clientId]) {
      // 已登记：保留首次时间，不刷新宽限（参考实现要点）
      // Already registered: keep the first timestamp, never refresh the grace
      return;
    }
    this.pendingLeave[clientId] = {
      channel: channel,
      uid: uid,
      closedAt: Date.now(),
      reason: reason || 'close'
    };
    delete this.clients[clientId];
    this.noteDiag('pendingLeave', [clientId, reason || 'close']);
    // 确保 alarm 在跑：若这是最后一名成员，alarm 不会被取消，宽限到期有人终结名单
    // Keep the alarm alive: if this was the last client the alarm must not be
    // canceled, someone still has to finalize the roster when grace expires
    await this.scheduleCleanupAlarm();
  }
  // 宽限期满终结：从 channels 真正摘除，带 x 广播（服务端已等过宽限，
  // 客户端应立即显示"已离开"）。由 cleanupOldConnections（15s alarm）驱动。
  // Grace expiry finalizer: actually remove from channels and broadcast with the
  // x marker (the server already waited out the grace, so clients should show
  // "left" immediately). Driven by cleanupOldConnections (15s alarm).
  async finalizePendingLeave() {
    const now = Date.now();
    const expired = [];
    for (const clientId in this.pendingLeave) {
      if (now - this.pendingLeave[clientId].closedAt >= this.config.pendingLeaveGrace) {
        expired.push(clientId);
      }
    }
    if (!expired.length) {
      return;
    }
    const leftIdsByChannel = {};
    for (const clientId of expired) {
      const rec = this.pendingLeave[clientId];
      delete this.pendingLeave[clientId];
      if (this.clients[clientId]) {
        // 异常防御：条目复活（正常路径接管时已删记录）
        // Defensive: entry resurrected (the takeover path already deleted the record)
        continue;
      }
      const members = this.channels[rec.channel];
      if (members) {
        const remaining = members.filter((id) => id !== clientId);
        if (remaining.length === 0) {
          delete this.channels[rec.channel];
        } else {
          this.channels[rec.channel] = remaining;
        }
        (leftIdsByChannel[rec.channel] = leftIdsByChannel[rec.channel] || []).push(clientId);
      }
      this.noteDiag('leaveFinalized', [clientId, Math.round((now - rec.closedAt) / 1000) + 's']);
    }
    for (const channel in leftIdsByChannel) {
      this.broadcastMemberList(channel, leftIdsByChannel[channel]);
    }
  }
  // Process encrypted messages
  async processEncryptedMessage(clientId, message) {
    let decrypted = null;

    try {
      decrypted = decryptMessage(message, this.clients[clientId].shared);

      // 只记动作/标记/成员数/长度，绝不打印整卷密文（几百 KB×成员数的日志会拖垮 DO）
      // Log action/flag/member-count/length only; never dump full ciphertext payloads
      logEvent('message-decrypted', [clientId, {
        a: decrypted ? decrypted.a : null,
        n: decrypted ? decrypted.n : null,
        members: decrypted && isObject(decrypted.p) ? Object.keys(decrypted.p).length : null,
        len: message.length
      }], 'debug');

      if (!isObject(decrypted) || !isString(decrypted.a)) {
        return;
      }

      const action = decrypted.a;

      if (action === 'j') {
        this.handleJoinChannel(clientId, decrypted);
      } else if (action === 'c') {
        await this.handleClientMessage(clientId, decrypted);
      } else if (action === 'w') {
        await this.handleChannelMessage(clientId, decrypted);
      } else if (action === 'dr') {
        await this.handleDeviceRegistration(clientId, decrypted);
      } else if (action === 'q') {
        // 主动辞别：立即摘除并广播（带 x 标记），其他端马上提示"离开对话"
        // Explicit goodbye: remove and broadcast at once (x marker) so peers see "left" instantly
        await this.leaveChannel(clientId, true);
      }

    } catch (error) {
      logEvent('process-encrypted-message', [clientId, error], 'error');
    } finally {
      decrypted = null;
    }
  }
  // Handle channel join requests
  handleJoinChannel(clientId, decrypted) {
    if (!isString(decrypted.p) || this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = decrypted.p;

      // 同身份去重：同一 (频道, uid) 的旧连接被新连接顶替。uid = sha256(密码哈希+频道+用户名)
      // 由客户端在加入时上报（密码永不上送，服务端无法反推），同名重连/同名多设备
      // 不再产生幽灵成员，任何时刻名单人数 = 服务端名单人数，三端一致。
      // Same-identity dedupe: a new connection replaces the older one with the same
      // (channel, uid). uid = sha256(password-hash + channel + username), reported by
      // the client at join (the password itself is never sent, so the server cannot
      // reverse it). Same-name reconnects / multi-device joins no longer leave ghost
      // members; roster size equals the server roster at any moment on all terminals.
      const uid = isString(decrypted.uid) && decrypted.uid.length <= 64 ? decrypted.uid : null;

      // ① 宽限期内同 uid 重连：新连接接管旧 clientId（名单字节级不变、零广播）。
      // 对端缓存的用户名/密钥继续有效（客户端用户名只在未设置时写入），
      // 网络抖动几秒~十几秒对其他成员完全不可见
      // ① Same-uid rejoin within grace: the new connection takes over the old
      // clientId (roster stays byte-identical, zero broadcasts). Peers' cached
      // usernames/keys stay valid (client usernames are only written once), so a
      // few-second network blip is completely invisible to other members
      let restored = false;
      if (uid) {
        for (const oldId in this.pendingLeave) {
          const rec = this.pendingLeave[oldId];
          if (rec && rec.channel === channel && rec.uid === uid && !this.clients[oldId]) {
            delete this.pendingLeave[oldId];
            const provisional = this.clients[clientId];
            this.clients[oldId] = {
              connection: provisional.connection,
              seen: provisional.seen,
              key: provisional.key,
              shared: provisional.shared,
              channel: channel,
              uid: uid
            };
            delete this.clients[clientId];
            if (this.clientQueues[clientId]) {
              this.clientQueues[oldId] = this.clientQueues[clientId];
            }
            delete this.clientQueues[clientId];
            this.connIds.set(provisional.connection, oldId);
            this.noteDiag('pendingRestored', [clientId, oldId]);
            logEvent('pending-restore', [clientId, oldId], 'info');
            clientId = oldId;
            restored = true;
            break;
          }
        }
      }

      // ② 同 uid 活连接接管（多设备/重复登录）：同样接管旧 id，名单零变化；
      // 旧 socket 关闭，其迟到 close 由陈旧连接守卫拦下（只记 diag 不动状态）
      // ② Live same-uid takeover (multi-device / duplicate sign-in): take over the
      // old id too, roster unchanged; the old socket is closed and its late close
      // event is intercepted by the stale-connection guard (diag only)
      if (uid && !restored) {
        for (const otherId in this.clients) {
          const other = this.clients[otherId];
          if (otherId !== clientId && other.uid === uid && other.channel === channel) {
            const oldConn = other.connection;
            const provisional = this.clients[clientId];
            other.connection = provisional.connection;
            other.seen = provisional.seen;
            other.key = provisional.key;
            other.shared = provisional.shared;
            delete this.clients[clientId];
            if (this.clientQueues[clientId]) {
              this.clientQueues[otherId] = this.clientQueues[clientId];
            }
            delete this.clientQueues[clientId];
            delete this.closeReasons[clientId];
            this.connIds.set(provisional.connection, otherId);
            if (oldConn) {
              this.closeReasons[otherId] = 'uid-replace';
              try {
                // 4000 = 应用自定义码「账号已在其他设备登录」：旧设备据此停止自动
                // 重连并提示重新登录。此前用默认 1005，旧设备 3s 后自动重连又把新
                // 设备顶掉，同账号两端无限互踢。
                // 4000 = app-defined "signed in elsewhere": the old device stops
                // auto-reconnecting. Default 1005 made it reconnect in 3s and kick the
                // new device back — endless dueling between two sessions of one account.
                oldConn.close(4000, 'account-taken-over');
              } catch (error) {
                logEvent('uid-replace-close', [otherId, error], 'error');
              }
            }
            this.noteDiag('uidReplaced', [clientId, otherId]);
            logEvent('uid-replace', [clientId, otherId], 'info');
            clientId = otherId;
            break;
          }
        }
      }

      this.clients[clientId].channel = channel;
      if (uid) {
        this.clients[clientId].uid = uid;
      }

      // 双重保险：同一 clientId 重复 join 不产生重复成员
      // Double safety: a duplicate join of the same clientId never duplicates membership
      if (!this.channels[channel]) {
        this.channels[channel] = [clientId];
      } else if (this.channels[channel].indexOf(clientId) < 0) {
        this.channels[channel].push(clientId);
      }

      this.broadcastMemberList(channel);

    } catch (error) {
      logEvent('message-join', [clientId, error], 'error');
    }
  }
  // Handle offline push device registration (channel known from this connection's join)
  // 处理离线推送设备注册（频道取自该连接加入过的房间）
  async handleDeviceRegistration(clientId, decrypted) {
    if (!isString(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }
    const pushToken = decrypted.p;
    if (pushToken.length > 128) {
      return;
    }
    try {
      await upsertDevice(this.state.storage, this.clients[clientId].channel, pushToken, clientId, this.env);
    } catch (error) {
      logEvent('device-register', [clientId, error], 'error');
    }
  }
  // Handle client messages
  async handleClientMessage(clientId, decrypted) {
    if (!isString(decrypted.p) || !isString(decrypted.c) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;
      const targetClient = this.clients[decrypted.c];

      if (this.isClientInChannel(targetClient, channel)) {
        const messageObj = {
          a: 'c',
          p: decrypted.p,
          c: clientId
        };
        // 握手自愈标记透传：k:1 = "我缺少你的公钥，请重发"（客户端协议，见 NodeCrypt）
        // Pass through the handshake-heal flag: k:1 = "I lack your public key, resend"
        if (decrypted.k === 1) {
          messageObj.k = 1;
        }

        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;

        // 幽灵通知根治：控制类封装（握手/密钥交换/语音信令）带 n:0 标记——只转发不推送。
        // 只有未标记的内容类封装（私聊/频道消息）才触发离线设备通知。
        // Ghost-notification fix: control wrappers (handshake / key exchange / voice
        // signaling) carry n:0 - relay only, no push. Unmarked (content) wrappers
        // (private / channel messages) still notify offline devices.
        if (decrypted.n === 0) {
          return;
        }

        // 私聊消息转发后，对本频道离线注册设备触发通知（不包含任何明文；20s 节流）
        // After relaying a private message, notify offline devices (no plaintext; 20s throttle)
        await this.notifyChannelOffline(channel, 'private');
      } else {
        // 目标成员不在线/未入频道/未握手：定向中继静默丢弃。握手回复正走这条
        // 路——计数让"对方密钥发来但回复丢在这里"可见
        // Target offline/not-in-channel/no-shared: the targeted relay drops silently.
        // Handshake replies travel this path — counting makes "peer key arrived but
        // the reply was dropped here" visible
        this.noteDiag('relayDropped', ['c', clientId, decrypted.c]);
      }

    } catch (error) {
      logEvent('message-client', [clientId, error], 'error');
    }
  }  // Handle channel messages
  async handleChannelMessage(clientId, decrypted) {
    if (!isObject(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;
      // 过滤有效的目标成员
      const invalidMembers = [];
      const validMembers = Object.keys(decrypted.p).filter(member => {
        const targetClient = this.clients[member];
        const ok = isString(decrypted.p[member]) && this.isClientInChannel(targetClient, channel);
        if (!ok) {
          invalidMembers.push(member);
        }
        return ok;
      });
      // 频道广播的无效目标：计数 + 记录（进房公钥广播走 'w'，成员未握手/
      // 已被顶替时它的密钥会丢在这里——"正在加入"卡死的候选真因）
      // Invalid targets of a channel broadcast: count + record. The join key
      // broadcast travels 'w'; keys dropped here for not-yet-handshaked / replaced
      // members are a prime suspect for stuck "joining" states
      if (invalidMembers.length) {
        this.noteDiag('relayDropped', ['w', clientId, invalidMembers.length]);
      }

      // 处理所有有效的目标成员
      for (const member of validMembers) {
        const targetClient = this.clients[member];
        const messageObj = {
          a: 'c',
          p: decrypted.p[member],
          c: clientId
        };        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;
      }

      // 幽灵通知根治：控制类封装（进房公钥广播）带 n:0 标记——只转发不推送。
      // Ghost-notification fix: control wrappers (join key broadcast) carry n:0 - relay only.
      if (decrypted.n === 0) {
        return;
      }

      // 房间消息转发后，对本频道离线注册设备触发通知（不包含任何明文；20s 节流）
      // After relaying a channel message, notify offline devices (no plaintext; 20s throttle)
      await this.notifyChannelOffline(channel, 'channel');

    } catch (error) {
      logEvent('message-channel', [clientId, error], 'error');
    }
  }
  // Broadcast member list to channel
  // explicitLeftIds：主动离开的成员 id（客户端据此立即提示）；i：接收者自己的 clientId
  // （客户端此前不知道自己的 id，beacon 离线上报与"我"的判定都需要它）
  // Broadcast member list; explicitLeftIds marks explicit leavers (clients notify instantly);
  // i echoes the recipient's own clientId (previously unknown to clients; needed for the
  // beacon leave report and correct self identification)
  broadcastMemberList(channel, explicitLeftIds) {
    try {
      const members = this.channels[channel];
      if (!members) {
        return;
      }

      for (const member of members) {
        const client = this.clients[member];

        if (!this.isClientInChannel(client, channel)) {
          continue;
        }
        try {
          const messageObj = {
            a: 'l',
            i: member,
            p: members.filter((value) => {
              return (value !== member ? true : false);
            })
          };
          if (explicitLeftIds && explicitLeftIds.length) {
            messageObj.x = explicitLeftIds;
          }
          // 附带成员身份映射（uid）：客户端据此合并同名重连、迁移待投递目标
          // Member identity map (uid): clients merge same-name reconnects and
          // retarget pending outbox deliveries through it
          const uidMap = {};
          let hasUid = false;
          for (const id of messageObj.p) {
            const entry = this.clients[id];
            if (entry && entry.uid) {
              uidMap[id] = entry.uid;
              hasUid = true;
            } else {
              // 宽限期成员条目已从 clients 删除：从 pendingLeave 登记补 uid，
              // 新加入者至少能按 uid 归并身份、迁移待投递
              // Grace-period members have no clients entry: fill the uid from the
              // pendingLeave registry so newcomers can still merge identities and
              // retarget pending deliveries
              const pendingRec = this.pendingLeave[id];
              if (pendingRec) {
                uidMap[id] = pendingRec.uid;
                hasUid = true;
              }
            }
          }
          if (hasUid) {
            messageObj.u = uidMap;
          }

          const encrypted = encryptMessage(messageObj, client.shared);
          this.sendMessage(client.connection, encrypted);
        } catch (error) {
          // 单个成员失败只跳过该成员，绝不中断其余成员的名单下发
          // One failing member is skipped; never abort the roster for the others
          logEvent('broadcast-member-list', [member, error], 'error');
        }
      }
    } catch (error) {
      logEvent('broadcast-member-list', error, 'error');
    }
  }  // 频道级离线推送节流：逐帧推送曾造成通知轰炸 + DO 串行队列堵塞（文件传输卡死的
  // 根因之一）。20s 内的后续消息只转发不推送；是否真的有离线设备由 push 层判定。
  // Per-channel offline-push throttle: per-frame pushes caused notification storms
  // and stalled the DO serial queue (a root cause of mid-transfer stalls). Within
  // 20s the relay-only path is taken; the offline-device check stays in push.js.
  async notifyChannelOffline(channel, source) {
    const now = getTime();
    if (now - (this.notifyAt[channel] || 0) < this.config.notifyThrottle) {
      this.noteDiag('notifySkipped', source);
      return;
    }
    this.notifyAt[channel] = now;
    try {
      const status = await notifyOfflineDevices(this.env, this.state.storage, channel, source);
      if (status === 'pushed') {
        this.noteDiag('notifyPushed', source);
      } else {
        this.noteDiag('notifySkipped', source + ':' + status);
      }
    } catch (error) {
      logEvent('notify-channel-offline', [channel, error], 'error');
      this.noteDiag('notifySkipped', source + ':error');
    }
  }
  // Check if client is in channel
  isClientInChannel(client, channel) {
    return (
      client &&
      client.connection &&
      client.shared &&
      client.channel &&
      client.channel === channel ?
      true :
      false
    );
  }
  // Send message helper
  sendMessage(connection, message) {
    try {
      // In Cloudflare Workers, WebSocket.READY_STATE_OPEN is 1
      if (connection.readyState === 1) {
        connection.send(message);
      }
    } catch (error) {
      logEvent('sendMessage', error, 'error');
    }
  }  // Close connection helper
  closeConnection(connection) {
    try {
      connection.close();    } catch (error) {
      logEvent('closeConnection', error, 'error');
    }
  }
  // 连接清理方法
  async cleanupOldConnections() {
    // 先终结宽限期满的成员（带 x 广播），再处理 seen 超时
    // Finalize grace-expired members (x-marked broadcast) before handling seen timeouts
    await this.finalizePendingLeave();

    const seenThreshold = getTime() - this.config.seenTimeout;
    const clientsToRemove = [];

    // 先收集需要移除的客户端，避免在迭代时修改对象
    for (const clientId in this.clients) {
      if (this.clients[clientId].seen < seenThreshold) {
        clientsToRemove.push(clientId);
      }
    }

    // 然后一次性处理所有过期客户端：转 pendingLeave（名单保持不动），
    // 关闭死连接；close 事件随后到达时条目已删，只会记 diag 不会重复处理
    for (const clientId of clientsToRemove) {
      try {
        logEvent('connection-seen', clientId, 'debug');
        // 断线取证：reap 携带 seen 空窗秒数，便于区分"节流中的活连接被误杀"
        // Idle-drop forensics: the seen gap tells throttled-but-alive connections apart
        this.noteDiag('reaped', [clientId, Math.round((getTime() - this.clients[clientId].seen) / 1000) + 's']);
        const removed = this.clients[clientId];
        const removedConn = removed ? removed.connection : null;
        this.closeReasons[clientId] = 'seen-timeout';
        await this.markPendingLeave(clientId, 'seen-timeout');
        if (removedConn) {
          try {
            removedConn.close();
          } catch (error) {
            logEvent('close-stale-connection', [clientId, error], 'error');
          }
        }
      } catch (error) {
        logEvent('connection-seen', error, 'error');
      }
    }

    // 如果没有任何客户端和房间，检查是否需要轮换密钥
    if (Object.keys(this.clients).length === 0 && Object.keys(this.channels).length === 0) {
      const pendingRotation = await this.state.storage.get('pendingKeyRotation');
      if (pendingRotation) {
        console.log('没有活跃客户端或房间，执行密钥轮换...');
        await this.state.storage.delete('rsaKeyPair');
        await this.state.storage.delete('pendingKeyRotation');
        this.keyPair = null;
        await this.initRSAKeyPair();
      }
    }

    // 仍有客户端 → 无条件续约周期清理 alarm；全部清空 → 取消 alarm 让 DO 真正空闲。
    // 旧实现只在"本次有清理"时重排：alarm 空跑一次后周期清理静默停止，
    // 僵尸连接与名单重播都失去兜底，单向"同步中"从此无人修复。
    // Clients remain → always renew the periodic cleanup alarm; empty → cancel it so
    // the DO can idle. The old code only rescheduled when something was reaped, so a
    // single idle pass silently stopped periodic cleanup — ghost members and one-sided
    // "syncing" states then had no fallback to recover from.
    try {
      // 取消条件必须包含 pendingLeave：否则最后一名成员掉线时 alarm 被取消，
      // 宽限记录永远无人终结，幽灵 id 永久残留名单
      // The cancel condition must include pendingLeave: otherwise when the last
      // member disconnects the alarm is canceled, grace records are never finalized
      // and ghost ids linger in rosters forever
      if (Object.keys(this.clients).length === 0 && Object.keys(this.pendingLeave).length === 0) {
        await this.state.storage.deleteAlarm();
      } else {
        await this.scheduleCleanupAlarm();
      }
    } catch (error) {
      logEvent('cleanup-alarm', error, 'error');
    }

    return clientsToRemove.length; // 返回清理的连接数量
  }

  // 预约下一次周期清理（DO alarm）：无活跃客户端时也可被 alarm()/handleSession 调用
  // Schedule the next periodic cleanup (DO alarm)
  async scheduleCleanupAlarm() {
    try {
      await this.state.storage.setAlarm(Date.now() + this.config.cleanupInterval);
    } catch (error) {
      logEvent('schedule-cleanup-alarm', error, 'error');
    }
  }

  // DO alarm 回调：周期执行清理 + 名单重播，保证仅在 join/close 触发时会被漏掉的
  // 半开连接最终被摘除；任何端丢一次名单广播最多 15s 自动收敛，
  // 未完成握手的成员也会因重播重新触发密钥交换
  // DO alarm callback: periodic cleanup + roster rebroadcast so half-open sockets
  // that no join/close event would surface still get reaped; a missed roster
  // broadcast converges within 15s and re-triggers key exchange for unfinished
  // handshakes
  async alarm() {
    try {
      this.noteDiag('alarms');
      await this.cleanupOldConnections();
      // 名单重播（所有非空频道）：客户端人数以此保持三端一致
      // Roster rebroadcast (all non-empty channels): keeps member counts consistent
      for (const channel of Object.keys(this.channels)) {
        this.broadcastMemberList(channel);
      }
      // 服务端心跳：给每个连接推一帧 'pong'。客户端把任意入站帧当活证刷新
      // lastPongAt（零客户端改动），后台页即使定时器被系统节流到分钟级，
      // 看门狗也不会再把活连接误判成半开而自杀重连；Cloudflare ~100s 空闲
      // 回收窗口也被这帧流量彻底喂饱。
      // Server-side heartbeat: push one 'pong' frame per connection. Clients treat
      // any inbound frame as proof of life and refresh lastPongAt (zero client
      // changes), so background pages with timer throttling at ~1/min no longer get
      // misjudged as half-open by their own watchdog; Cloudflare's ~100s idle
      // WebSocket window is fed as well.
      for (const clientId of Object.keys(this.clients)) {
        const clientInfo = this.clients[clientId];
        if (clientInfo && clientInfo.connection) {
          this.sendMessage(clientInfo.connection, 'pong');
        }
      }
      this.noteDiag('heartbeats');
    } catch (error) {
      logEvent('alarm-cleanup', error, 'error');
    }
  }
}
