// Room management logic for NodeCrypt web client
// NodeCrypt 网页客户端的房间管理逻辑

import {
	createAvatarSVG
} from './util.avatar.js';
import {
	renderChatArea,
	addSystemMsg,
	updateChatInputStyle
} from './chat.js';
import {
	renderMainHeader,
	renderUserList
} from './ui.js';
import {
	escapeHTML
} from './util.string.js';
import {
	$id,
	createElement
} from './util.dom.js';
import {
	t
} from './util.i18n.js';
import { VoiceChat } from './util.voice.js';
let roomsData = [];
let activeRoomIndex = -1;

// Get a new room data object
// 获取一个新的房间数据对象
export function 	getNewRoomData() {
	return {
		roomName: '',
		userList: [],
		userMap: {},
		myId: null,
		myUserName: '',
		chat: null,
		messages: [],
		prevUserList: [],
		knownUserIds: new Set(),
		unreadCount: 0,
		privateChatTargetId: null,
		privateChatTargetName: null
	}
}

// Switch to another room by index
// 切换到指定索引的房间
export function switchRoom(index) {
	if (index < 0 || index >= roomsData.length) return;
	// Leave voice call if switching away from an active call room
	if (window.voiceChat && window.voiceChat.isInCall) {
		window.voiceChat.leaveCall();
	}
	activeRoomIndex = index;
	const rd = roomsData[index];
	if (typeof rd.unreadCount === 'number') rd.unreadCount = 0;
	const sidebarUsername = document.getElementById('sidebar-username');
	if (sidebarUsername) sidebarUsername.textContent = rd.myUserName;
	setSidebarAvatar(rd.myUserName);
	renderRooms(index);
	renderMainHeader();
	renderUserList(false);
	renderChatArea();
	updateChatInputStyle()
}

// Set the sidebar avatar
// 设置侧边栏头像
export function setSidebarAvatar(userName) {
	if (!userName) return;
	const svg = createAvatarSVG(userName);
	const el = $id('sidebar-user-avatar');
	if (el) {
		const cleanSvg = svg.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
		el.innerHTML = cleanSvg
	}
}

// Render the room list
// 渲染房间列表
export function renderRooms(activeId = 0) {
	const roomList = $id('room-list');
	roomList.innerHTML = '';
	roomsData.forEach((rd, i) => {
		const div = createElement('div', {
			class: 'room' + (i === activeId ? ' active' : ''),
			onclick: () => switchRoom(i)
		});
		const safeRoomName = escapeHTML(rd.roomName);
		let unreadHtml = '';
		if (rd.unreadCount && i !== activeId) {
			unreadHtml = `<span class="room-unread-badge">${rd.unreadCount>99?'99+':rd.unreadCount}</span>`
		}
		div.innerHTML = `<div class="info"><div class="title">#${safeRoomName}</div></div>${unreadHtml}`;
		roomList.appendChild(div)
	})
}

// Join a room
// 加入一个房间
export function joinRoom(userName, roomName, password, modal = null, onResult) {
	const newRd = getNewRoomData();
	newRd.roomName = roomName;
	newRd.myUserName = userName;
	newRd.password = password;
	roomsData.push(newRd);
	const idx = roomsData.length - 1;
	switchRoom(idx);
	const sidebarUsername = $id('sidebar-username');
	if (sidebarUsername) sidebarUsername.textContent = userName;
	setSidebarAvatar(userName);
	let closed = false;
	let chatInst = null;
	const callbacks = {
		onServerClosed: () => {
			setStatus(t('status.disconnected', 'Node connection closed'));
			// Leave voice call on disconnect
			if (window.voiceChat && window.voiceChat.isInCall) {
				window.voiceChat.leaveCall();
			}
			// Hide voice button
			const voiceBtn = $id('chat-voice-btn');
			if (voiceBtn) voiceBtn.style.display = 'none';
			if (onResult && !closed) {
				closed = true;
				onResult(false)
			}
		},		onServerSecured: () => {
			if (modal) modal.remove();
			else {
				const loginContainer = $id('login-container');
				if (loginContainer) loginContainer.style.display = 'none';
				const chatContainer = $id('chat-container');
				if (chatContainer) chatContainer.style.display = '';
			}
			// Show voice button when chat is active
			const voiceBtn = $id('chat-voice-btn');
			if (voiceBtn && VoiceChat && VoiceChat.isSupported()) {
				voiceBtn.style.display = 'flex';
			}
			// 通知 uniapp 原生层：已加入房间（含房间哈希，用于离线推送与频道路由）
			// Notify the native layer: room joined (with room hash for offline push and channel routing)
			if (window.__postToNative && chatInst && chatInst.credentials) {
				window.__postToNative({
					type: 'nodecrypt-joined',
					room: roomName,
					hash: chatInst.credentials.channel
				});
			}
			if (onResult && !closed) {
				closed = true;
				onResult(true)
			}
			addSystemMsg(t('system.secured', 'connection secured'))
		},
		onClientSecured: (user) => handleClientSecured(idx, user),
		onClientPending: (info) => handleClientPending(idx, info),
		onClientList: (list, selfId, explicitLeft) => handleClientList(idx, list, selfId, explicitLeft),
		onClientLeft: (clientId) => handleClientLeft(idx, clientId),
		onClientMessage: (msg) => handleClientMessage(idx, msg)
	};
	chatInst = new window.NodeCrypt(window.config, callbacks);
	chatInst.setCredentials(userName, roomName, password);
	chatInst.connect();
	roomsData[idx].chat = chatInst
}

// Handle the client list update
// selfId：服务端回传的本端 clientId（修复此前 myId 恒为 undefined）；
// explicitLeft：主动离开的成员 id 列表（这些离开立即提示，其余延迟判定）
// Handle the client list update. selfId: our own clientId echoed by the server (fixes
// myId always being undefined); explicitLeft: ids that left explicitly (instant notice,
// the rest go through the delayed judgment)
export function handleClientList(idx, list, selfId, explicitLeft) {
	const rd = roomsData[idx];
	if (!rd) return;
	const oldUserIds = new Set((rd.userList || []).map(u => u.clientId));
	const newUserIds = new Set(list.map(u => u.clientId));
	for (const oldId of oldUserIds) {
		if (!newUserIds.has(oldId)) {
			handleClientLeft(idx, oldId, Array.isArray(explicitLeft) && explicitLeft.indexOf(oldId) >= 0)
		}
	}
	rd.userList = list;
	rd.userMap = {};
	list.forEach(u => {
		rd.userMap[u.clientId] = u
	});
	if (selfId) rd.myId = selfId;
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
	rd.initCount = (rd.initCount || 0) + 1;
	if (rd.initCount === 2) {
		rd.isInitialized = true;
		rd.knownUserIds = new Set(list.map(u => u.clientId))
	}
}

// Handle client secured event
// 处理客户端安全连接事件
export function handleClientSecured(idx, user) {
	const rd = roomsData[idx];
	if (!rd) return;
	rd.userMap[user.clientId] = user;
	const existingUserIndex = rd.userList.findIndex(u => u.clientId === user.clientId);
	if (existingUserIndex === -1) {
		rd.userList.push(user)
	} else {
		rd.userList[existingUserIndex] = user
	}
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
		if (window.voiceChat && window.voiceChat.isInCall) {
			window.voiceChat.onNewPeerJoined(user.clientId);
		}
	}
	if (!rd.isInitialized) {
		return
	}
	const name = user.userName || user.username || user.name || t('ui.anonymous', 'Anonymous');
	// 延迟判定中的同名离开：取消挂起并静默恢复（不提示"加入"，避免断线重连的噪音）。
	// 主动离开（已立即提示过"离开"）不产生挂起项，重进会正常提示"加入"。
	// A held leave for the same name: cancel it and resume silently (no join notice).
	// Explicit leaves (already announced instantly) leave no hold, so rejoining shows normally.
	rd.pendingLeaves = rd.pendingLeaves || {};
	let resumed = false;
	for (const pendingId of Object.keys(rd.pendingLeaves)) {
		if (rd.pendingLeaves[pendingId].name === name) {
			clearTimeout(rd.pendingLeaves[pendingId].timer);
			delete rd.pendingLeaves[pendingId];
			resumed = true;
		}
	}
	const isNew = !rd.knownUserIds.has(user.clientId);
	if (isNew) {
		rd.knownUserIds.add(user.clientId);
		if (!resumed) {
			const msg = `${name} ${t('system.joined', 'joined the conversation')}`;
			rd.messages.push({
				type: 'system',
				text: msg
			});
			if (activeRoomIndex === idx) addSystemMsg(msg, true);
			if (window.notifyMessage) {
				window.notifyMessage(rd.roomName, 'system', msg)
			}
		}
	}
}

// Handle a member that never completes the E2E handshake (8s→20s after appearing in
// the member list). No longer rendered: since hashes derive from the password, a
// password mismatch cannot share a channel, so this was almost always a weak-network /
// throttled-page false alarm. NodeCrypt logs it and the member-list rebroadcast retries
// the handshake automatically.
// 某成员握手未完成：不再在聊天区显示提示（hash 含密码后同频道不可能密码不一致，
// 该提示基本只剩弱网/后台节流误报）。NodeCrypt 侧仍有日志，名单重播会自动重试握手。
export function handleClientPending(idx, info) {
	// 仅保留调用点（调试日志见 NodeCrypt 'pending-handshake'），聊天区不渲染任何内容
	// Kept as a callback stub only (see NodeCrypt 'pending-handshake' debug log); nothing rendered
}

// Handle client left event
// explicit=true：主动离开（关标签/退出房间/APP 后台，服务端带 x 标记）→ 立即提示；
// 否则（断网/息屏/杀进程等无操作断线）→ 挂起 45s 延迟判定：
// 到期时同名成员已在房间（断线重连）则静默取消，否则才显示"离开对话"。
// Handle client left event. explicit=true: intentional leave (tab close / room exit /
// APP background; server sent the x marker) → instant notice. Otherwise (network loss /
// screen off / process kill) → hold for 45s: silently cancel if a same-name member is
// present by then (reconnect), otherwise show the "left" message.
const LEAVE_CONFIRM_MS = 45000;

export function handleClientLeft(idx, clientId, explicit = false) {
	const rd = roomsData[idx];
	if (!rd) return;
	if (rd.privateChatTargetId === clientId) {
		rd.privateChatTargetId = null;
		rd.privateChatTargetName = null;
		if (activeRoomIndex === idx) {
			updateChatInputStyle()
		}
	}
	const user = rd.userMap[clientId];
	const name = user ? (user.userName || user.username || user.name || 'Anonymous') : 'Anonymous';
	const msg = `${name} ${t('system.left', 'left the conversation')}`;
	const pushLeftMessage = () => {
		rd.messages.push({
			type: 'system',
			text: msg
		});
		if (activeRoomIndex === idx) addSystemMsg(msg, true);
	};
	if (explicit) {
		pushLeftMessage();
	} else {
		// 无主动离开信号：挂起延迟判定（同 clientId 重复事件先清旧计时器）
		// No explicit signal: hold for delayed judgment (clear a stale timer on duplicate events)
		rd.pendingLeaves = rd.pendingLeaves || {};
		if (rd.pendingLeaves[clientId]) {
			clearTimeout(rd.pendingLeaves[clientId].timer);
		}
		rd.pendingLeaves[clientId] = {
			name,
			timer: setTimeout(() => {
				// 到期时房间可能已销毁/切换：按 rd 身份守卫
				// The room may be destroyed/switched by the time this fires: guard by rd identity
				if (roomsData[idx] !== rd || !rd.pendingLeaves || !rd.pendingLeaves[clientId]) {
					return
				}
				delete rd.pendingLeaves[clientId];
				// 同名成员已在房间（断线重连，未走离开广播）：视为没离开，静默跳过
				// Same-name member present (reconnected without a leave broadcast): treat as never left
				const present = (rd.userList || []).some((u) => (u.userName || u.username || u.name || 'Anonymous') === name);
				if (!present) {
					pushLeftMessage();
				}
			}, LEAVE_CONFIRM_MS)
		};
	}
	rd.userList = rd.userList.filter(u => u.clientId !== clientId);
	delete rd.userMap[clientId];
	if (window.voiceChat) {
		window.voiceChat.cleanupPeer(clientId);
	}
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
		if (window.voiceChat) window.voiceChat.updateCallIndicator();
	}
}

// Handle client message event
// 处理客户端消息事件
export function handleClientMessage(idx, msg) {
	const newRd = roomsData[idx];
	if (!newRd) return;

	// 通知 uniapp 原生层收到新消息（用于未读角标；语音信令不计入）
	// Notify the native layer of a new message (for unread badge; voice signaling excluded)
	if (window.__postToNative && !String(msg.type || '').startsWith('voice-')) {
		window.__postToNative({
			type: 'nodecrypt-msg',
			room: newRd.roomName,
			hash: newRd.chat && newRd.chat.credentials ? newRd.chat.credentials.channel : '',
			msgType: msg.type || 'text',
			private: String(msg.type || '').includes('_private'),
			ts: Date.now()
		});
	}

	// Prevent processing own messages unless it's a private message sent to oneself
	if (msg.clientId === newRd.myId && msg.userName === newRd.myUserName && !msg.type.includes('_private')) {
		return;
	}

	let msgType = msg.type || 'text';

	// Handle voice signaling messages
	if (msgType.startsWith('voice-')) {
		if (activeRoomIndex === idx && window.voiceChat) {
			window.voiceChat.handleSignalingMessage(msg);
		}
		return;
	}

	// Handle file messages
	if (msgType.startsWith('file_')) {
		// Part 1: Update message history and send notifications (for 'file_start' type)
		if (msgType === 'file_start' || msgType === 'file_start_private') {
			let realUserName = msg.userName;
			if (!realUserName && msg.clientId && newRd.userMap[msg.clientId]) {
				realUserName = newRd.userMap[msg.clientId].userName || newRd.userMap[msg.clientId].username || newRd.userMap[msg.clientId].name;
			}
			const historyMsgType = msgType === 'file_start_private' ? 'file_private' : 'file';
			
			const fileId = msg.data && msg.data.fileId;
			if (fileId) { // Only proceed if we have a fileId
				const messageAlreadyInHistory = newRd.messages.some(
					m => m.msgType === historyMsgType && m.text && m.text.fileId === fileId && m.userName === realUserName
				);

				if (!messageAlreadyInHistory) {
					newRd.messages.push({
						type: 'other',
						text: msg.data, // This is the file metadata object
						userName: realUserName,
						avatar: realUserName,
						msgType: historyMsgType,
						timestamp: (msg.data && msg.data.timestamp) || Date.now() 
					});
				}
			}

			const notificationMsgType = msgType.includes('_private') ? 'private file' : 'file';
			if (window.notifyMessage && msg.data && msg.data.fileName) {
				window.notifyMessage(newRd.roomName, notificationMsgType, `${msg.data.fileName}`, realUserName);
			}
		}

		// Part 2: Handle UI interaction (rendering in active room, or unread count in inactive room)
		if (activeRoomIndex === idx) {
			// If it's the active room, delegate to util.file.js to handle UI and file transfer state.
			// This applies to all file-related messages (file_start, file_volume, file_end, etc.)
			if (window.handleFileMessage) {
				window.handleFileMessage(msg.data, msgType.includes('_private'));
			}
		} else {
			// If it's not the active room, only increment unread count for 'file_start' messages.
			if (msgType === 'file_start' || msgType === 'file_start_private') {
				newRd.unreadCount = (newRd.unreadCount || 0) + 1;
				renderRooms(activeRoomIndex);
			}
		}
		return; // File messages are fully handled.
	}

	// Handle image messages (both new and legacy formats)
	if (msgType === 'image' || msgType === 'image_private') {
		// Already has correct type
	} else if (!msgType.includes('_private')) {
		// Handle legacy image detection
		if (msg.data && typeof msg.data === 'string' && msg.data.startsWith('data:image/')) {
			msgType = 'image';
		} else if (msg.data && typeof msg.data === 'object' && msg.data.image) {
			msgType = 'image';
		}
	}
	let realUserName = msg.userName;
	if (!realUserName && msg.clientId && newRd.userMap[msg.clientId]) {
		realUserName = newRd.userMap[msg.clientId].userName || newRd.userMap[msg.clientId].username || newRd.userMap[msg.clientId].name;
	}

	// Add message to messages array for chat history
	roomsData[idx].messages.push({
		type: 'other',
		text: msg.data,
		userName: realUserName,
		avatar: realUserName,
		msgType: msgType,
		timestamp: Date.now()
	});

	// Only add message to chat display if it's for the active room
	if (activeRoomIndex === idx) {
		if (window.addOtherMsg) {
			window.addOtherMsg(msg.data, realUserName, realUserName, false, msgType);
		}
	} else {
		roomsData[idx].unreadCount = (roomsData[idx].unreadCount || 0) + 1;
		renderRooms(activeRoomIndex);
	}

	const notificationMsgType = msgType.includes('_private') ? `private ${msgType.split('_')[0]}` : msgType;
	if (window.notifyMessage) {
		window.notifyMessage(newRd.roomName, notificationMsgType, msg.data, realUserName);
	}
}

// Toggle private chat with a user
// 切换与某用户的私聊
export function togglePrivateChat(targetId, targetName) {
	const rd = roomsData[activeRoomIndex];
	if (!rd) return;
	if (rd.privateChatTargetId === targetId) {
		rd.privateChatTargetId = null;
		rd.privateChatTargetName = null
	} else {
		rd.privateChatTargetId = targetId;
		rd.privateChatTargetName = targetName
	}
	renderUserList();
	updateChatInputStyle()
}


// Exit the current room
// 退出当前房间
export function exitRoom() {
	// Leave voice call if exiting room with active call
	if (window.voiceChat && window.voiceChat.isInCall) {
		window.voiceChat.leaveCall();
	}
	if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
		const rd = roomsData[activeRoomIndex];
		const chatInst = rd.chat;
		// 先发主动离开（WS q + sendBeacon 兜底）再销毁实例 → 其他端立即提示"离开"
		// Send the explicit leave (WS q + sendBeacon fallback) before tearing down → peers see "left" instantly
		if (chatInst && typeof chatInst.leavePresence === 'function') {
			try {
				chatInst.leavePresence('exit-room');
			} catch (error) { /* ignore */ }
		}
		if (chatInst && typeof chatInst.destruct === 'function') {
			chatInst.destruct()
		} else if (chatInst && typeof chatInst.disconnect === 'function') {
			chatInst.disconnect()
		}
		// 清掉该房间的延迟离开计时器
		// Clear held-leave timers for this room
		if (rd.pendingLeaves) {
			for (const pendingId of Object.keys(rd.pendingLeaves)) {
				clearTimeout(rd.pendingLeaves[pendingId].timer);
			}
			rd.pendingLeaves = {};
		}
		roomsData[activeRoomIndex].chat = null;
		roomsData.splice(activeRoomIndex, 1);
		if (roomsData.length > 0) {
			switchRoom(0);
			return true
		} else {
			return false
		}
	}
	return false
}

// APP webview 桥（chat.vue 经 evalJS 调用）：APP 切后台/返回首页时让所有房间实例
// 主动离开（对方立即看到"离开"）；回前台恢复在线（进入频道 → "加入"）。
// APP webview bridge (invoked from chat.vue via evalJS): on APP background/home, every
// room instance leaves explicitly (peers see "left" instantly); on foreground, resume
// (entering the channel shows "joined").
window.__ncPresenceLeave = (reason) => {
	for (const rd of roomsData) {
		const inst = rd && rd.chat;
		if (inst && typeof inst.leavePresence === 'function') {
			try {
				inst.leavePresence(reason || 'app');
			} catch (error) { /* ignore */ }
		}
	}
};
window.__ncPresenceResume = () => {
	for (const rd of roomsData) {
		const inst = rd && rd.chat;
		if (inst && typeof inst.resumePresence === 'function') {
			try {
				inst.resumePresence();
			} catch (error) { /* ignore */ }
		}
	}
};

export { roomsData, activeRoomIndex };

// Listen for sidebar username update event
// 监听侧边栏用户名更新事件
window.addEventListener('updateSidebarUsername', () => {
	if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
		const rd = roomsData[activeRoomIndex];
		const sidebarUsername = document.getElementById('sidebar-username');
		if (sidebarUsername && rd.myUserName) {
			sidebarUsername.textContent = rd.myUserName;
		}
		// Also update the avatar to ensure consistency
		if (rd.myUserName) {
			setSidebarAvatar(rd.myUserName);
		}
	}
});