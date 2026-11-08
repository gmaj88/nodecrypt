import { roomsData, activeRoomIndex } from './room.js';
import { addSystemMsg } from './chat.js';
import { t } from './util.i18n.js';
import { $id } from './util.dom.js';

const ICE_SERVERS = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun1.l.google.com:19302' }
];

// 远端音频无声时的兜底提示（8 秒后仍未播放）
// Recovery hint when remote audio stays silent after 8 seconds
const SOUND_HINT_DELAY_MS = 8000;

export class VoiceChat {
	constructor() {
		this.localStream = null;
		this.peerConnections = new Map();
		this.audioElements = new Map();
		this.isMuted = false;
		this.isInCall = false;
		// 无麦克风时置 true：仅听模式，仍接收他人音频
		// true when mic is unavailable: listen-only mode, still receive others' audio
		this.listenOnly = false;
		this.callStartTime = null;
		this.timerInterval = null;
		this.pendingCandidates = new Map();
		this.activeCallers = new Set();
		// 一对一通话目标成员；null = 群呼模式（全房间 mesh）
		// One-on-one call target; null = group call (whole-room mesh)
		this.directPeerId = null;
		this.audioCtx = null;
		// WebAudio 兜底路由：WebView 中 <audio> 播放可能被自动播放策略拦截，
		// 远端流经 WebAudio 输出可绕开该限制（走媒体音量流）
		// WebAudio fallback route: <audio> may be autoplay-blocked in WebView;
		// routing the remote stream through WebAudio bypasses that (media volume stream)
		this.audioSources = new Map();
		this.hintTimers = new Map();
		this.audioUnlockBound = null;
		// 播放增益：Android WebView 的 WebRTC 音频走"通话音量"通道，链路偏小；
		// 提供 ×1/×1.8/×3 三档软件增益（WebAudio 输出路径），通话中点按钮循环
		// Playback boost: Android WebView WebRTC audio uses the call-volume stream which
		// runs low; offer ×1/×1.8/×3 software gain (WebAudio output), toggled in-call
		this.playbackBoost = 0;
		this.playbackGain = null;
		// ICE 服务器：默认 STUN，通话开始时尝试加载 TURN（蜂窝 NAT 兜底）
		// ICE servers: STUN by default; TURN loaded at call start when available (cellular NAT fallback)
		this.iceServers = ICE_SERVERS.slice();
		this.turnLoaded = false;
		this.turnPromise = null;

		this.handleSignalingMessage = this.handleSignalingMessage.bind(this);
		this.destroy = this.destroy.bind(this);
		this.ensureAudioUnlocked = this.ensureAudioUnlocked.bind(this);
	}

	static isSupported() {
		return !!(
			navigator.mediaDevices &&
			typeof navigator.mediaDevices.getUserMedia === 'function' &&
			typeof RTCPeerConnection !== 'undefined'
		);
	}

	getCurrentRoomChat() {
		const rd = roomsData[activeRoomIndex];
		return rd && rd.chat ? rd.chat : null;
	}

	// 通话开始时从 /voice-turn 拉取 TURN 配置并缓存；任何失败都回落到默认 STUN
	// Fetch TURN config from /voice-turn at call start and cache it; any failure keeps STUN-only
	loadIceServers() {
		if (!this.turnLoaded) {
			if (!this.turnPromise) {
				this.turnPromise = (async () => {
					try {
						const response = await fetch('/voice-turn', { cache: 'no-store' });
						if (response.ok) {
							const data = await response.json();
							if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
								this.iceServers = data.iceServers;
							}
						}
					} catch (e) { /* 保持 STUN 兜底 / keep STUN fallback */ }
				})();
			}
			this.turnPromise.finally(() => { this.turnLoaded = true; });
		}
		return this.turnPromise;
	}

	// 将 getUserMedia 错误类型映射为可读提示，避免一律报"被拒绝"
	// Map getUserMedia error types to readable messages instead of one generic "denied"
 describeMicError(e) {
		const name = e && e.name;
		if (name === 'NotAllowedError' || name === 'SecurityError') {
			return t('voice.permission_denied', 'Microphone access denied — allow microphone for this site in browser settings, then retry');
		} else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
			return t('voice.mic_not_found', 'No microphone detected on this device');
		} else if (name === 'NotReadableError' || name === 'TrackStartError') {
			return t('voice.mic_busy', 'Microphone is in use by another application');
		} else if (name === 'OverconstrainedError') {
			return t('voice.mic_constraint', 'Audio options are not supported by this device');
		}
		return t('voice.mic_error', 'Failed to access the microphone');
	}

	getPeersWithSharedKey() {
		const chat = this.getCurrentRoomChat();
		if (!chat) return [];
		const peers = [];
		for (const peerId in chat.channel) {
			const peer = chat.channel[peerId];
			if (peer.shared && peer.username) {
				peers.push({ peerId, username: peer.username });
			}
		}
		return peers;
	}

	sendVoiceSignaling(type, data) {
		const chat = this.getCurrentRoomChat();
		if (!chat) return;
		// 一对一模式：信令只发给通话目标，其他成员收不到密文也不参与
		// Direct mode: signaling goes only to the call target
		if (this.directPeerId) {
			this.sendVoiceSignalingTo(this.directPeerId, type, data);
			return;
		}
		const peers = this.getPeersWithSharedKey();
		for (const { peerId } of peers) {
			this.sendVoiceSignalingTo(peerId, type, data);
		}
	}

	sendVoiceSignalingTo(targetId, type, data) {
		const chat = this.getCurrentRoomChat();
		if (!chat) return;
		const peer = chat.channel[targetId];
		if (!peer || !peer.shared) return;
		try {
			const clientPayload = chat.encryptClientMessage(
				{ a: 'm', t: type, d: data || {} },
				peer.shared
			);
			// n:0 = 控制类封装：服务器只转发，不触发离线设备推送（防幽灵通知）
			// n:0 = control wrapper: server relays only, no offline-device push
			const serverPayload = chat.encryptServerMessage(
				{ a: 'c', n: 0, p: clientPayload, c: targetId },
				chat.serverShared
			);
			chat.sendMessage(serverPayload);
		} catch (e) {
			console.error('[VoiceChat] send signaling error:', e);
		}
	}

	async startCall(targetPeerId = null) {
		if (this.isInCall) return;

		// 群呼前清空一对一状态
		// Reset direct-call state before a group call
		this.directPeerId = null;

		if (!VoiceChat.isSupported()) {
			addSystemMsg(t('voice.not_supported', 'Voice chat is not supported in this browser'));
			return;
		}

		// 在用户手势的同步阶段先创建 AudioContext（WebView 的音频解锁依赖手势）
		// Create the AudioContext in the synchronous phase of the user gesture (WebView audio unlock depends on it)
		this.ensureAudioUnlocked();

		// 加载 TURN 配置（蜂窝网络 NAT 兜底；失败时不阻塞通话，退回纯 STUN）
		// Load TURN config (cellular NAT fallback; never blocks on failure, falls back to STUN)
		await this.loadIceServers();

		const peers = this.getPeersWithSharedKey();
		if (peers.length === 0) {
			addSystemMsg(t('voice.no_peers', 'No other members to call'));
			return;
		}

		// 一对一模式：校验目标在线（有 shared 密钥）才继续
		// Direct mode: validate the target still has a shared key
		if (targetPeerId) {
			const target = peers.find(p => p.peerId === targetPeerId);
			if (!target) {
				addSystemMsg(t('voice.no_peers', 'No other members to call'));
				return;
			}
			this.directPeerId = targetPeerId;
		}

		// 不再依赖 enumerateDevices 预检（WebView 授权状态变化时会漏报 audioinput，
		// 把有麦设备误判成无麦）。直接 getUserMedia 试采集——它才是权威判断：
		// 真无麦 → NotFoundError；被拒 → NotAllowedError；其余失败照常进入仅听模式。
		// Don't trust enumerateDevices pre-check (WebView auth-state changes make it
		// under-report audioinput). getUserMedia is the ground truth: a real mic gets
		// prompted/succeeds; true absence yields NotFoundError; denial NotAllowedError.
		try {
			this.localStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
				video: false
			});
			this.listenOnly = false;
		} catch (e) {
			// 麦克风不可用时不再退出，转为仅听模式继续加入，可正常听到其他人
			// When mic is unavailable, don't bail out — join in listen-only mode and keep receiving others
			console.error('[VoiceChat] getUserMedia failed:', e && e.name, e);
			addSystemMsg(this.describeMicError(e));
			addSystemMsg(t('voice.listen_only', 'No microphone — joining in listen-only mode, you can still hear others'));
			this.listenOnly = true;
		}

		try {
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				await this.audioCtx.resume();
			}
		} catch (e) { /* ignore */ }

		this.isInCall = true;
		this.callStartTime = Date.now();
		this.updateVoiceUI(true);
		this.startTimer();

		const rd = roomsData[activeRoomIndex];
		const userName = rd ? rd.myUserName : '';
		if (this.directPeerId) {
			// 一对一：提示正在邀请目标成员
			// Direct mode: announce the invite to the target
			const targetName = rd && rd.userMap && rd.userMap[this.directPeerId]
				? (rd.userMap[this.directPeerId].userName || this.directPeerId)
				: this.directPeerId;
			addSystemMsg(t('voice.direct_starting', '{name} joined voice chat').replace('{name}', targetName));
		} else {
			addSystemMsg(t('voice.user_joined', '{name} joined voice chat').replace('{name}', userName));
		}

		this.sendVoiceSignaling('voice-active', {});

		if (this.directPeerId) {
			// 一对一：只对目标成员发起 offer（对方未入会，会经 direct offer 自动接听）
			// Direct: offer only the target peer (callee auto-accepts via direct offer)
			await this.createOfferForPeer(this.directPeerId, true);
		} else if (this.activeCallers.size === 0) {
			for (const { peerId } of peers) {
				await this.createOfferForPeer(peerId);
			}
		} else {
			this.sendVoiceSignaling('voice-join', {});
		}

		this.updateCallIndicator();
	}

	// 一对一来电自动接听：对方未入会即收到 direct offer 时调用
	// Auto-accept an incoming one-on-one call (direct offer received while not in call)
	async acceptDirectCall(peerId) {
		this.ensureAudioUnlocked();

		// 与群呼一致：先拉 TURN（蜂窝 NAT 兜底），失败不阻塞
		// Same as group calls: try TURN first, never blocks
		await this.loadIceServers();

		try {
			this.localStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
				video: false
			});
			this.listenOnly = false;
		} catch (e) {
			console.error('[VoiceChat] accept mic failed:', e && e.name, e);
			addSystemMsg(this.describeMicError(e));
			addSystemMsg(t('voice.listen_only', 'No microphone — joining in listen-only mode, you can still hear others'));
			this.listenOnly = true;
		}

		try {
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				await this.audioCtx.resume();
			}
		} catch (e) { /* ignore */ }

		this.isInCall = true;
		this.callStartTime = Date.now();
		this.directPeerId = peerId;
		this.updateVoiceUI(true);
		this.startTimer();

		const rd = roomsData[activeRoomIndex];
		const callerName = rd && rd.userMap && rd.userMap[peerId]
			? (rd.userMap[peerId].userName || peerId)
			: peerId;
		addSystemMsg(t('voice.direct_incoming', '{name} invited you to a one-on-one call — connecting automatically').replace('{name}', callerName));

		this.sendVoiceSignaling('voice-active', {});
		this.updateCallIndicator();
	}

	async createOfferForPeer(peerId, direct = false) {
		const pc = this.createPeerConnection(peerId);
		try {
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			this.sendVoiceSignalingTo(peerId, 'voice-offer', {
				sdp: pc.localDescription.toJSON(),
				direct: direct
			});
		} catch (e) {
			console.error('[VoiceChat] create offer error:', e);
			this.closePeerConnection(peerId);
		}
	}

	createPeerConnection(peerId) {
		const savedCandidates = this.pendingCandidates.get(peerId);
		this.closePeerConnection(peerId);
		if (savedCandidates && savedCandidates.length > 0) {
			this.pendingCandidates.set(peerId, savedCandidates);
		}

		const pc = new RTCPeerConnection({ iceServers: this.iceServers });

		if (this.localStream) {
			this.localStream.getTracks().forEach(track => {
				pc.addTrack(track, this.localStream);
			});
		} else if (this.listenOnly) {
			// 仅听模式：声明只接收的音频 transceiver，对端仍会向我们发送音频
			// Listen-only: declare a recvonly audio transceiver so peers still send audio to us
			pc.addTransceiver('audio', { direction: 'recvonly' });
		}

		pc.ontrack = (event) => {
			if (event.streams && event.streams[0]) {
				this.setupAudioElement(peerId, event.streams[0]);
			}
		};

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.sendVoiceSignalingTo(peerId, 'voice-ice', {
					candidate: event.candidate.toJSON()
				});
			}
		};

		pc.onconnectionstatechange = () => {
			const state = pc.connectionState;
			if (state === 'failed' || state === 'closed') {
				this.handlePeerDisconnected(peerId);
			} else if (state === 'connected') {
				this.updateVoiceUI(true);
			}
		};

		pc.oniceconnectionstatechange = () => {
			if (pc.iceConnectionState === 'failed') {
				this.restartIceForPeer(peerId);
			}
		};

		this.peerConnections.set(peerId, pc);
		return pc;
	}

	setupAudioElement(peerId, stream) {
		this.removeAudioElement(peerId);
		const audio = document.createElement('audio');
		audio.srcObject = stream;
		audio.autoplay = true;
		audio.muted = false;
		audio.volume = 1;
		audio.setAttribute('playsinline', 'true');
		audio.id = `voice-audio-${peerId}`;
		audio.style.display = 'none';
		document.body.appendChild(audio);
		this.audioElements.set(peerId, audio);

		audio.play().catch(() => {
			// 元素播放被拦截（自动播放策略）时，一次手势后重试
			// When element playback is blocked by autoplay policy, retry after a gesture
			this.armUnlockRetry();
		});

		// WebAudio 兜底 + 增益：媒体音量流 经播放增益节点 输出（支持 ×1/×1.8/×3 放大）
		// WebAudio fallback + boost: media-volume stream routed via the playback gain node
		if (this.audioCtx && this.audioCtx.state !== 'closed') {
			try {
				const source = this.audioCtx.createMediaStreamSource(stream);
				const sink = this.getPlaybackGain();
				source.connect(sink);
				this.audioSources.set(peerId, source);
			} catch (e) { /* WebAudio 不可用时仍依赖 <audio> 元素 */ }
		}

		// 8 秒后仍无声则给出恢复提示（点击屏幕 / 检查音量）
		// After 8s of silence, surface a recovery hint (tap screen / check volume)
		const hintTimer = setTimeout(() => {
			if (this.audioElements.get(peerId) === audio && audio.paused) {
				addSystemMsg(t('voice.sound_hint', 'No remote sound yet — tap the screen once and check media/voice-call volume'));
				this.armUnlockRetry();
			}
		}, SOUND_HINT_DELAY_MS);
		this.hintTimers.set(peerId, hintTimer);

		if (this.isInCall) this.updateVoiceUI(true);
	}

	// 手势解锁：恢复 AudioContext 并重试所有待播放元素
	// Gesture unlock: resume the AudioContext and retry every pending element
	armUnlockRetry() {
		if (this.audioUnlockBound) return;
		this.audioUnlockBound = () => {
			this.audioUnlockBound = null;
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
			for (const [, el] of this.audioElements) {
				el.play().catch(() => {});
			}
		};
		document.addEventListener('touchstart', this.audioUnlockBound, { once: true, passive: true });
		document.addEventListener('click', this.audioUnlockBound, { once: true, passive: true });
	}

	// 音频解锁：尽量在点击手势内创建/恢复 AudioContext
	// Audio unlock: create/resume the AudioContext within a user gesture when possible
	ensureAudioUnlocked() {
		if (!this.audioCtx || this.audioCtx.state === 'closed') {
			try {
				this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			} catch (e) { /* AudioContext 不可用时仅依赖 <audio> 元素 */ return; }
		}
		if (this.audioCtx.state === 'suspended') {
			this.audioCtx.resume().catch(() => {});
		}
	}

	// 播放增益节点（惰性创建）；所有 WebAudio 远端源统一接到它，再进扬声器
	// Playback gain node (lazy); every remote WebAudio source routes through it
	getPlaybackGain() {
		if (!this.audioCtx || !this.audioCtx.createGain) {
			return this.audioCtx ? this.audioCtx.destination : null;
		}
		if (!this.playbackGain) {
			this.playbackGain = this.audioCtx.createGain();
			this.playbackGain.connect(this.audioCtx.destination);
		}
		return this.playbackGain;
	}

	// 三档增益循环：×1 → ×1.8 → ×3 → ×1，同步按钮标签
	// Cycle gain ×1 -> ×1.8 -> ×3 -> ×1 and update the button label
	togglePlaybackBoost() {
		const levels = [1, 1.8, 3];
		this.playbackBoost = (this.playbackBoost + 1) % 3;
		this.ensureAudioUnlocked();
		const gain = this.getPlaybackGain();
		if (gain && 'gain' in gain) {
			gain.gain.value = levels[this.playbackBoost];
		}
		this.updateBoostButton();
		// 最高档外放显著增强麦克风拾音回路，双端外放距离远时易啸叫，主动提示
		// Highest boost amplifies the mic pickup loop; warn before the user
		// experiences speaker feedback during far-field calls
		if (levels[this.playbackBoost] === 3) {
			addSystemMsg(t('voice.boost_echo_hint', 'Max speaker volume — use headphones or lower the boost to avoid echo/howling'));
		}
	}

	updateBoostButton() {
		const label = $id('voice-boost-label');
		if (label) {
			const levels = ['×1', '×1.8', '×3'];
			label.textContent = levels[this.playbackBoost];
		}
	}

	removeAudioElement(peerId) {
		const existing = this.audioElements.get(peerId);
		if (existing) {
			existing.srcObject = null;
			existing.remove();
			this.audioElements.delete(peerId);
		}
		const source = this.audioSources.get(peerId);
		if (source) {
			try { source.disconnect(); } catch (e) { /* ignore */ }
			this.audioSources.delete(peerId);
		}
		const hintTimer = this.hintTimers.get(peerId);
		if (hintTimer) {
			clearTimeout(hintTimer);
			this.hintTimers.delete(peerId);
		}
	}

	closePeerConnection(peerId) {
		const pc = this.peerConnections.get(peerId);
		if (pc) {
			try { pc.close(); } catch (e) { /* ignore */ }
			this.peerConnections.delete(peerId);
		}
		this.removeAudioElement(peerId);
	}

	handlePeerDisconnected(peerId) {
		this.closePeerConnection(peerId);
		if (this.isInCall) this.updateVoiceUI(true);
		// 一对一：连接最终失败（ICE 重启也救不回）→ 自动挂断并退出通话
		// Direct call: final connection failure (ICE restart didn't help) → auto hang-up
		if (this.directPeerId && peerId === this.directPeerId) {
			this.leaveCall();
		}
	}

	async restartIceForPeer(peerId) {
		const pc = this.peerConnections.get(peerId);
		if (!pc || pc.connectionState === 'closed') return;
		try {
			const offer = await pc.createOffer({ iceRestart: true });
			await pc.setLocalDescription(offer);
			this.sendVoiceSignalingTo(peerId, 'voice-offer', {
				sdp: pc.localDescription.toJSON()
			});
		} catch (e) {
			console.error('[VoiceChat] ICE restart failed:', e);
		}
	}

	async handleSignalingMessage(msg) {
		const type = msg.type;
		if (type === 'voice-active' || type === 'voice-inactive') {
			this.handleActiveStatus(msg);
			return;
		}
		// voice-offer 必须放行到 handleOffer：未入会时收到 direct offer 要自动接听，
		// 非 direct 的群呼 offer 仍将在 handleOffer 内被忽略
		// voice-offer must reach handleOffer: a direct offer while not in call is auto-accepted;
		// non-direct (group) offers stay ignored there
		if (!this.isInCall && type !== 'voice-join' && type !== 'voice-offer') return;

		const senderId = msg.clientId;
		const data = msg.data || {};

		switch (type) {
			case 'voice-join':
				await this.handleVoiceJoin(senderId);
				break;
			case 'voice-offer':
				await this.handleOffer(senderId, data);
				break;
			case 'voice-answer':
				await this.handleAnswer(senderId, data);
				break;
			case 'voice-ice':
				await this.handleIceCandidate(senderId, data);
				break;
			case 'voice-leave':
				this.handleVoiceLeave(senderId);
				break;
			case 'voice-mute':
				this.handleMuteStatus(senderId, data);
				break;
		}
	}

	handleActiveStatus(msg) {
		const senderId = msg.clientId;
		const type = msg.type;
		if (type === 'voice-active') {
			this.activeCallers.add(senderId);
		} else {
			this.activeCallers.delete(senderId);
		}
		this.updateCallIndicator();
	}

	async handleVoiceJoin(peerId) {
		if (!this.isInCall || this.directPeerId) return;
		await this.createOfferForPeer(peerId);
	}

	async handleOffer(peerId, data) {
		if (!data || !data.sdp) return;
		const isDirectInvite = data.direct === true;
		if (this.isInCall) {
			// 群呼中不接受一对一邀请；一对一通话中只处理通话目标本身的信令（含 ICE 重启）
			// Ignore 1:1 invites while in a group call; in a direct call only process the target's signaling
			if (isDirectInvite) return;
			if (this.directPeerId && peerId !== this.directPeerId) return;
		} else {
			// 未入会：只有标记 direct 的 offer 视为一对一来电并自动接听
			// Not in call: only direct-flagged offers are 1:1 invites and get auto-accepted
			if (!isDirectInvite) return;
			await this.acceptDirectCall(peerId);
		}
		const pc = this.createPeerConnection(peerId);
		try {
			await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
			if (this.pendingCandidates.has(peerId)) {
				const candidates = this.pendingCandidates.get(peerId);
				for (const c of candidates) {
					await pc.addIceCandidate(new RTCIceCandidate(c));
				}
				this.pendingCandidates.delete(peerId);
			}
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			this.sendVoiceSignalingTo(peerId, 'voice-answer', {
				sdp: pc.localDescription.toJSON()
			});
		} catch (e) {
			console.error('[VoiceChat] handle offer error:', e);
			this.closePeerConnection(peerId);
		}
	}

	async handleAnswer(peerId, data) {
		if (!data.sdp) return;
		const pc = this.peerConnections.get(peerId);
		if (!pc) return;
		try {
			if (pc.signalingState === 'have-local-offer') {
				await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
				if (this.pendingCandidates.has(peerId)) {
					const candidates = this.pendingCandidates.get(peerId);
					for (const c of candidates) {
						await pc.addIceCandidate(new RTCIceCandidate(c));
					}
					this.pendingCandidates.delete(peerId);
				}
			}
		} catch (e) {
			console.error('[VoiceChat] handle answer error:', e);
		}
	}

	async handleIceCandidate(peerId, data) {
		if (!data.candidate) return;
		const pc = this.peerConnections.get(peerId);
		if (pc && pc.remoteDescription) {
			try {
				await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
			} catch (e) {
				console.error('[VoiceChat] add ICE candidate error:', e);
			}
		} else {
			if (!this.pendingCandidates.has(peerId)) {
				this.pendingCandidates.set(peerId, []);
			}
			this.pendingCandidates.get(peerId).push(data.candidate);
		}
	}

	handleVoiceLeave(peerId) {
		if (this.directPeerId) {
			// 一对一通话中：只关心对方；对方离开/下线 → 自动挂断
			// In a direct call: only the target matters; if they leave, hang up automatically
			if (peerId !== this.directPeerId) return;
			this.closePeerConnection(peerId);
			this.activeCallers.delete(peerId);
			const rd = roomsData[activeRoomIndex];
			const name = rd && rd.userMap && rd.userMap[peerId]
				? (rd.userMap[peerId].userName || peerId)
				: peerId;
			if (this.isInCall) {
				addSystemMsg(t('voice.user_left', '{name} left voice chat').replace('{name}', name));
			}
			this.leaveCall();
			return;
		}
		this.closePeerConnection(peerId);
		this.activeCallers.delete(peerId);
		if (this.isInCall) {
			this.updateVoiceUI(true);
			this.updateCallIndicator();
			if (this.peerConnections.size === 0 && (this.getLocalTracks().length > 0 || this.listenOnly)) {
				addSystemMsg(t('voice.all_left', 'All participants have left'));
			}
		}
	}

	handleMuteStatus(peerId, data) {
		if (data && typeof data.muted === 'boolean') {
			const rd = roomsData[activeRoomIndex];
			if (rd && rd.userMap && rd.userMap[peerId]) {
				rd.userMap[peerId].voiceMuted = data.muted;
				this.updateVoiceUI(true);
			}
		}
	}

	getLocalTracks() {
		if (!this.localStream) return [];
		return this.localStream.getAudioTracks();
	}

	async toggleMute() {
		if (!this.isInCall || !this.localStream) return false;
		const audioTrack = this.localStream.getAudioTracks()[0];
		if (!audioTrack) return false;
		audioTrack.enabled = !audioTrack.enabled;
		this.isMuted = !audioTrack.enabled;
		this.sendVoiceSignaling('voice-mute', { muted: this.isMuted });
		this.updateMuteButton();
		return this.isMuted;
	}

	leaveCall() {
		if (!this.isInCall) return;
		this.sendVoiceSignaling('voice-inactive', {});
		for (const [peerId] of this.peerConnections) {
			this.closePeerConnection(peerId);
		}
		this.peerConnections.clear();
		// 通话结束后恢复群呼模式（voice-leave 消息是点对点的，不受影响）
		// Restore group-call mode after the call ends
		this.directPeerId = null;
		if (this.localStream) {
			this.localStream.getTracks().forEach(track => track.stop());
			this.localStream = null;
		}
		if (this.audioCtx) {
			this.audioCtx.close().catch(() => {});
			this.audioCtx = null;
		}
		for (const [, source] of this.audioSources) {
			try { source.disconnect(); } catch (e) { /* ignore */ }
		}
		this.audioSources.clear();
		for (const [, timer] of this.hintTimers) {
			clearTimeout(timer);
		}
		this.hintTimers.clear();
		if (this.audioUnlockBound) {
			this.audioUnlockBound = null;
		}
		this.isMuted = false;
		this.listenOnly = false;
		this.isInCall = false;
		this.callStartTime = null;
		this.stopTimer();
		this.updateVoiceUI(false);
		this.updateCallIndicator();
	}

	destroy() {
		this.leaveCall();
	}

	onNewPeerJoined(peerId) {
		// 仅听模式也需为新成员建立连接（recvonly offer），继续接收其音频
		// Listen-only peers also connect to new members (recvonly offer) to keep receiving audio
		// 一对一通话中不自动连接新成员（避免第三方混入）
		// Skip new members while in a direct call
		if (!this.isInCall || this.directPeerId) return;
		const peers = this.getPeersWithSharedKey();
		if (!peers.some(p => p.peerId === peerId)) return;
		this.sendVoiceSignalingTo(peerId, 'voice-active', {});
		this.createOfferForPeer(peerId);
	}

	startTimer() {
		this.stopTimer();
		this.timerInterval = setInterval(() => {
			this.updateTimerDisplay();
		}, 1000);
		this.updateTimerDisplay();
	}

	stopTimer() {
		if (this.timerInterval) {
			clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
		const timerEl = $id('voice-call-timer');
		if (timerEl) timerEl.textContent = '';
	}

	updateTimerDisplay() {
		const timerEl = $id('voice-call-timer');
		if (!timerEl || !this.callStartTime) return;
		const elapsed = Math.floor((Date.now() - this.callStartTime) / 1000);
		const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
		const sec = String(elapsed % 60).padStart(2, '0');
		timerEl.textContent = `${min}:${sec}`;
	}

	updateVoiceUI(show) {
		const panel = $id('voice-call-panel');
		const voiceBtn = $id('chat-voice-btn');
		const textEl = $id('voice-call-text');

		if (show && this.isInCall) {
			if (panel) panel.style.display = 'flex';
			if (voiceBtn) voiceBtn.classList.add('active');
			if (textEl) {
				const count = this.peerConnections.size + 1;
				textEl.textContent = `${t('voice.in_call', 'Voice Chat')} (${count})`;
			}
			this.updateMuteButton();
			this.updateMemberVoiceIndicators();
		} else {
			if (panel) panel.style.display = 'none';
			if (voiceBtn) voiceBtn.classList.remove('active');
			this.updateMemberVoiceIndicators();
		}

		if (voiceBtn) {
			if (this.isInCall) {
				voiceBtn.title = t('voice.leave_call', 'Leave voice call');
			} else if (this.activeCallers.size > 0) {
				voiceBtn.title = t('voice.join_call', 'Join voice call');
			} else {
				voiceBtn.title = t('voice.call_direct_hint', 'Tap to start a group call, long-press for a one-on-one call');
			}
		}
	}

	updateCallIndicator() {
		const indicator = $id('voice-header-indicator');
		if (!indicator) return;

		if (this.isInCall) {
			const count = this.peerConnections.size + 1;
			indicator.style.display = 'inline-flex';
			indicator.innerHTML = `<span class="voice-header-dot"></span><span class="voice-header-text">${t('voice.in_call', 'Voice Chat')} (${count})</span><button class="voice-header-action" id="voice-header-toggle">${t('voice.close_audio', 'Close audio')}</button>`;
			const toggleBtn = $id('voice-header-toggle');
			if (toggleBtn) toggleBtn.onclick = () => this.leaveCall();
		} else if (this.activeCallers.size > 0) {
			const count = this.activeCallers.size;
			indicator.style.display = 'inline-flex';
			indicator.innerHTML = `<span class="voice-header-dot"></span><span class="voice-header-text">${count} ${t('voice.in_call', 'Voice Chat')}</span><button class="voice-header-action" id="voice-header-toggle">${t('voice.open_audio', 'Open audio')}</button>`;
			const toggleBtn = $id('voice-header-toggle');
			if (toggleBtn) toggleBtn.onclick = () => window.voiceChat.startCall();
		} else {
			indicator.style.display = 'none';
			indicator.innerHTML = '';
		}
	}

	updateMuteButton() {
		const muteBtn = $id('voice-mute-btn');
		if (!muteBtn) return;
		if (this.isMuted) {
			muteBtn.classList.add('muted');
			muteBtn.title = t('voice.unmute', 'Unmute');
			muteBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
				<path d="M12 1C10.34 1 9 2.34 9 4V12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12V4C15 2.34 13.66 1 12 1Z" fill="#999"/>
				<path d="M17 12C17 14.76 14.76 17 12 17C9.24 17 7 14.76 7 12H5C5 15.53 7.61 18.43 11 18.92V22H13V18.92C16.39 18.43 19 15.53 19 12H17Z" fill="#999"/>
				<line x1="3" y1="3" x2="21" y2="21" stroke="#f44336" stroke-width="2.5" stroke-linecap="round"/>
			</svg>`;
		} else {
			muteBtn.classList.remove('muted');
			muteBtn.title = t('voice.mute', 'Mute');
			muteBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
				<path d="M12 1C10.34 1 9 2.34 9 4V12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12V4C15 2.34 13.66 1 12 1Z" fill="#808080"/>
				<path d="M17 12C17 14.76 14.76 17 12 17C9.24 17 7 14.76 7 12H5C5 15.53 7.61 18.43 11 18.92V22H13V18.92C16.39 18.43 19 15.53 19 12H17Z" fill="#808080"/>
			</svg>`;
		}
	}

	updateMemberVoiceIndicators() {
		const memberList = $id('member-list');
		if (!memberList) return;
		memberList.querySelectorAll('.member').forEach(el => {
			const existing = el.querySelector('.voice-indicator');
			if (existing) existing.remove();
		});
		if (!this.isInCall) return;
		const rd = roomsData[activeRoomIndex];
		if (!rd) return;
		memberList.querySelectorAll('.member').forEach(el => {
			const nameEl = el.querySelector('.member-name');
			if (!nameEl) return;
			const name = nameEl.textContent.replace(/\s*\(me\)\s*$/, '').trim();
			for (const [peerId] of this.peerConnections) {
				const peerUser = rd.userMap[peerId];
				if (peerUser && (peerUser.userName || peerUser.username) === name) {
					const indicator = document.createElement('span');
					indicator.className = 'voice-indicator';
					indicator.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M12 1C10.34 1 9 2.34 9 4V12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12V4C15 2.34 13.66 1 12 1Z" fill="#4caf50"/>
						<path d="M17 12C17 14.76 14.76 17 12 17C9.24 17 7 14.76 7 12H5C5 15.53 7.61 18.43 11 18.92V22H13V18.92C16.39 18.43 19 15.53 19 12H17Z" fill="#4caf50"/>
					</svg>`;
					const infoEl = el.querySelector('.member-info');
					if (infoEl) infoEl.appendChild(indicator);
					break;
				}
			}
			if (el.classList.contains('me')) {
				const indicator = document.createElement('span');
				indicator.className = 'voice-indicator';
				const iconColor = this.isMuted ? '#999' : '#4caf50';
				indicator.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path d="M12 1C10.34 1 9 2.34 9 4V12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12V4C15 2.34 13.66 1 12 1Z" fill="${iconColor}"/>
					<path d="M17 12C17 14.76 14.76 17 12 17C9.24 17 7 14.76 7 12H5C5 15.53 7.61 18.43 11 18.92V22H13V18.92C16.39 18.43 19 15.53 19 12H17Z" fill="${iconColor}"/>
					${this.isMuted ? '<line x1="4" y1="4" x2="20" y2="20" stroke="#f44336" stroke-width="2.5" stroke-linecap="round"/>' : ''}
				</svg>`;
				const infoEl = el.querySelector('.member-info');
				if (infoEl) infoEl.appendChild(indicator);
			}
		});
	}

	cleanupPeer(peerId) {
		this.activeCallers.delete(peerId);
		if (this.peerConnections.has(peerId)) {
			this.closePeerConnection(peerId);
			if (this.isInCall) this.updateVoiceUI(true);
		}
		this.updateCallIndicator();
	}
}

let voiceChatInstance = null;

export function getVoiceChat() {
	return voiceChatInstance;
}

export function initVoiceChat() {
	if (!voiceChatInstance) {
		voiceChatInstance = new VoiceChat();
	}
	return voiceChatInstance;
}

export function destroyVoiceChat() {
	if (voiceChatInstance) {
		voiceChatInstance.destroy();
		voiceChatInstance = null;
	}
}
