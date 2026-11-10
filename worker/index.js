import { generateClientId, encryptMessage, decryptMessage, logEvent, isString, isObject, getTime } from './utils.js';
import { upsertDevice, markDeviceOffline, notifyOfflineDevices, readNotifyLog, removeDevice, listAllDevices, purgeDevices, debugPush, debugTaskDetail } from './push.js';
import { getVoiceTurnIceServers } from './voiceTurn.js';

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
    
    this.config = {
      seenTimeout: 60000,
      // 周期清理 alarm 间隔：不再依赖"有人新连接"才触发 cleanupOldConnections，
      // 旧连接的超时清理与成员变化广播由 alarm 兜底
      // Periodic-cleanup alarm interval: cleanup no longer depends on new connections
      cleanupInterval: 15000,
      debug: false
    };
    
    // Initialize RSA key pair
    this.initRSAKeyPair();
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
    this.clients[clientId] = {
      connection: connection,
      seen: getTime(),
      key: null,
      shared: null,
      channel: null
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

      if (!isString(message) || !this.clients[clientId]) {
        return;
      }

      this.clients[clientId].seen = getTime();

      if (message === 'ping') {
        this.sendMessage(connection, 'pong');
        return;
      }
      logEvent('message', [clientId, message], 'debug');      // Handle key exchange
      if (!this.clients[clientId].shared && message.length < 2048) {
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
          this.clients[clientId].shared = new Uint8Array(sharedSecretBits).slice(8, 40);

          const response = Array.from(new Uint8Array(publicKeyBuffer))
            .map(b => b.toString(16).padStart(2, '0')).join('') + 
            '|' + btoa(String.fromCharCode(...new Uint8Array(signature)));
          
          this.sendMessage(connection, response);

        } catch (error) {
          logEvent('message-key', [clientId, error], 'error');
          this.closeConnection(connection);
        }

        return;
      }

      // Handle encrypted messages
      if (this.clients[clientId].shared && message.length <= (8 * 1024 * 1024)) {
        this.processEncryptedMessage(clientId, message);
      }
    });    // Handle connection close
    connection.addEventListener('close', async (event) => {
      logEvent('close', [clientId, event], 'debug');

      // cleanupOldConnections 可能已删除该客户端，需要防御缺失
      // cleanupOldConnections may have already deleted this client; guard against it
      const clientInfo = this.clients[clientId];
      const channel = clientInfo ? (clientInfo.channel || null) : null;

      if (channel && this.channels[channel]) {
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
            try {
              const members = this.channels[channel];

              for (const member of members) {
                const client = this.clients[member];              if (this.isClientInChannel(client, channel)) {
                  this.sendMessage(client.connection, encryptMessage({
                    a: 'l',
                    p: members.filter((value) => {
                      return (value !== member ? true : false);
                    })
                  }, client.shared));
                }
              }

            } catch (error) {
              logEvent('close-list', [clientId, error], 'error');
            }
          }
        }
      }

      // 将该连接关联的推送设备标记为离线，使其成为离线推送的目标
      // Mark push devices linked to this connection offline so they become offline push targets
      if (channel) {
        try {
          await markDeviceOffline(this.state.storage, channel, clientId);
        } catch (error) {
          logEvent('close-device-offline', [clientId, error], 'error');
        }
      }

      if (this.clients[clientId]) {
        delete(this.clients[clientId]);
      }
    });
  }
  // Process encrypted messages
  async processEncryptedMessage(clientId, message) {
    let decrypted = null;

    try {
      decrypted = decryptMessage(message, this.clients[clientId].shared);

      logEvent('message-decrypted', [clientId, decrypted], 'debug');

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

      this.clients[clientId].channel = channel;

      if (!this.channels[channel]) {
        this.channels[channel] = [clientId];
      } else {
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

        // 私聊消息转发后，对本频道离线注册设备触发通知（不包含任何明文）
        // After relaying a private message, notify offline registered devices of the channel (no plaintext)
        await notifyOfflineDevices(this.env, this.state.storage, channel, 'private');
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
      const validMembers = Object.keys(decrypted.p).filter(member => {
        const targetClient = this.clients[member];
        return isString(decrypted.p[member]) && this.isClientInChannel(targetClient, channel);
      });

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

      // 房间消息转发后，对本频道离线注册设备触发通知（不包含任何明文）
      // After relaying a channel message, notify offline registered devices of the channel (no plaintext)
      await notifyOfflineDevices(this.env, this.state.storage, channel, 'channel');

    } catch (error) {
      logEvent('message-channel', [clientId, error], 'error');
    }
  }
  // Broadcast member list to channel
  broadcastMemberList(channel) {
    try {
      const members = this.channels[channel];

      for (const member of members) {
        const client = this.clients[member];

        if (this.isClientInChannel(client, channel)) {
          const messageObj = {
            a: 'l',
            p: members.filter((value) => {
              return (value !== member ? true : false);
            })
          };

          const encrypted = encryptMessage(messageObj, client.shared);
          this.sendMessage(client.connection, encrypted);

          messageObj.p = null;
        }
      }
    } catch (error) {
      logEvent('broadcast-member-list', error, 'error');
    }
  }  // Check if client is in channel
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
    const seenThreshold = getTime() - this.config.seenTimeout;
    const clientsToRemove = [];

    // 先收集需要移除的客户端，避免在迭代时修改对象
    for (const clientId in this.clients) {
      if (this.clients[clientId].seen < seenThreshold) {
        clientsToRemove.push(clientId);
      }
    }

    // 发生成员变化的频道集合：循环结束后统一补播一次成员表
    // Channels with membership changes: rebroadcast once after the loop
    const affectedChannels = new Set();

    // 然后一次性移除所有过期客户端
    for (const clientId of clientsToRemove) {
      try {
        logEvent('connection-seen', clientId, 'debug');
        // close 时 clients 已被删除，这里统一补齐设备离线标记
        // close event won't find the client anymore, so mark push devices offline here
        const removed = this.clients[clientId];
        const removedChannel = removed ? removed.channel : null;
        // 必须先从频道成员表同步摘除：若只删 clients 而不摘 channels，
        // close 事件回调会查不到 client，该 ID 将永久残留为僵尸成员
        // Must splice from channels synchronously: the close handler looks up
        // this.clients[clientId], which is gone by then, so without a splice the
        // stale ID would linger in channels[] forever as a ghost member
        if (removedChannel && this.channels[removedChannel]) {
          const remaining = this.channels[removedChannel].filter((id) => id !== clientId);
          if (remaining.length === 0) {
            delete this.channels[removedChannel];
          } else if (remaining.length !== this.channels[removedChannel].length) {
            this.channels[removedChannel] = remaining;
            affectedChannels.add(removedChannel);
          }
        }
        if (removedChannel) {
          try {
            await markDeviceOffline(this.state.storage, removedChannel, clientId);
          } catch (error) {
            logEvent('cleanup-device-offline', [clientId, error], 'error');
          }
        }
        if (removed && removed.connection) {
          try {
            removed.connection.close();
          } catch (error) {
            logEvent('close-stale-connection', [clientId, error], 'error');
          }
        }
        delete this.clients[clientId];
      } catch (error) {
        logEvent('connection-seen', error, 'error');
      }
    }

    // 对每个发生成员变化的频道补播成员表 —— 等待中的新成员靠这条恢复握手，
    // 否则要等下一个 join/close 事件才会再广播
    // Rebroadcast for each changed channel — pending joiners rely on this to
    // resume their handshake instead of waiting for the next join/close event
    for (const channel of affectedChannels) {
      this.broadcastMemberList(channel);
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

    // 仍有客户端 → 续约周期清理 alarm；全部清空 → 取消 alarm 让 DO 真正空闲
    // Clients remain → renew the periodic cleanup alarm; empty → cancel it so the DO can idle
    try {
      if (Object.keys(this.clients).length === 0) {
        await this.state.storage.deleteAlarm();
      } else if (clientsToRemove.length > 0) {
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

  // DO alarm 回调：周期执行清理，保证仅在 join/close 触发清理时不会被漏掉的
  // 半开连接最终也能被摘除并广播
  // DO alarm callback: run cleanup periodically so half-open sockets that no
  // join/close event would surface still get reaped and members rebroadcast
  async alarm() {
    try {
      await this.cleanupOldConnections();
    } catch (error) {
      logEvent('alarm-cleanup', error, 'error');
    }
  }
}
