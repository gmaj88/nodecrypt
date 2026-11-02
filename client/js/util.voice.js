import { roomsData, activeRoomIndex } from './room.js';
import { addSystemMsg } from './chat.js';
import { t } from './util.i18n.js';
import { $id } from './util.dom.js';

const ICE_SERVERS = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun1.l.google.com:19302' }
];

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
		this.audioCtx = null;
		// WebAudio 兜底路由：WebView 中 <audio> 播放可能被自动播放策略拦截，
		// 远端流经 WebAudio 输出可绕开该限制（走媒体音量流）
		// WebAudio fallback route: <audio> may be autoplay-blocked in WebView;
		// routing the remote stream through WebAudio bypasses that (media volume stream)
		this.audioSources = new Map();
		this.statsTimers = new Map();
		this.audioUnlockBound = null;

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
			const serverPayload = chat.encryptServerMessage(
				{ a: 'c', p: clientPayload, c: targetId },
				chat.serverShared
			);
			chat.sendMessage(serverPayload);
		} catch (e) {
			console.error('[VoiceChat] send signaling error:', e);
		}
	}

	async startCall() {
		if (this.isInCall) return;

		if (!VoiceChat.isSupported()) {
			addSystemMsg(t('voice.not_supported', 'Voice chat is not supported in this browser'));
			return;
		}

		// 在用户手势的同步阶段先创建 AudioContext（WebView 的音频解锁依赖手势）
		// Create the AudioContext in the synchronous phase of the user gesture (WebView audio unlock depends on it)
		this.ensureAudioUnlocked();

		const peers = this.getPeersWithSharedKey();
		if (peers.length === 0) {
			addSystemMsg(t('voice.no_peers', 'No other members to call'));
			return;
		}

		// 预检输入设备：无麦克风时直接进入仅听模式，不再触发权限探测
		// Pre-check input devices: enter listen-only directly when no mic, skip the permission probe
		let micAvailable = true;
		try {
			if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
				const devices = await navigator.mediaDevices.enumerateDevices();
				micAvailable = devices.some((d) => d.kind === 'audioinput' && d.deviceId);
			}
		} catch (e) { /* 预检失败时按“可能有麦克风”处理 / fall back to assuming a mic exists */ }

		if (!micAvailable) {
			console.warn('[VoiceChat] no audio input device detected, entering listen-only mode');
			addSystemMsg(t('voice.mic_not_found', 'No microphone detected on this device'));
			addSystemMsg(t('voice.listen_only', 'No microphone — joining in listen-only mode, you can still hear others'));
			this.listenOnly = true;
		} else {
			try {
				this.localStream = await navigator.mediaDevices.getUserMedia({
					audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
					video: false
				});
				this.listenOnly = false;
			} catch (e) {
				// 输出具体错误类型（NotAllowed/NotFound/NotReadable 等）便于定位
				// Log the concrete error name to help diagnosis
				console.error('[VoiceChat] getUserMedia failed:', e && e.name, e);
				// 麦克风不可用时不再退出，转为仅听模式继续加入，可正常听到其他人
				// When mic is unavailable, don't bail out — join in listen-only mode and keep receiving others
				addSystemMsg(this.describeMicError(e));
				addSystemMsg(t('voice.listen_only', 'No microphone — joining in listen-only mode, you can still hear others'));
				this.listenOnly = true;
			}
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
		addSystemMsg(t('voice.user_joined', '{name} joined voice chat').replace('{name}', userName));

		this.sendVoiceSignaling('voice-active', {});

		if (this.activeCallers.size === 0) {
			for (const { peerId } of peers) {
				await this.createOfferForPeer(peerId);
			}
		} else {
			this.sendVoiceSignaling('voice-join', {});
		}

		this.updateCallIndicator();
	}

	async createOfferForPeer(peerId) {
		const pc = this.createPeerConnection(peerId);
		try {
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			this.sendVoiceSignalingTo(peerId, 'voice-offer', {
				sdp: pc.localDescription.toJSON()
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

		const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

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
			console.log(`[VoiceChat] connectionState (${peerId}): ${state}`);
			if (state === 'failed' || state === 'closed') {
				this.handlePeerDisconnected(peerId);
			} else if (state === 'connected') {
				this.updateVoiceUI(true);
				this.schedulePeerStats(peerId, pc);
			}
		};

		pc.oniceconnectionstatechange = () => {
			console.log(`[VoiceChat] iceConnectionState (${peerId}): ${pc.iceConnectionState}`);
			if (pc.iceConnectionState === 'failed') {
				this.restartIceForPeer(peerId);
			}
		};

		this.peerConnections.set(peerId, pc);
		return pc;
	}

	// 建连 5 秒后输出单行媒体摘要：候选对类型/入站包数/轨道状态
	// One-line media digest 5s after connect: candidate pair type / inbound packets / track state
	schedulePeerStats(peerId, pc) {
		if (this.statsCacheTimer) clearTimeout(this.statsCacheTimer);
		this.statsCacheTimer = setTimeout(async () => {
			try {
				const stats = await pc.getStats();
				let pairLine = 'pair=none';
				let inboundLine = 'inbound=none';
				stats.forEach((report) => {
					if (report.type === 'candidate-pair' && (report.selected === true || report.state === 'succeeded' && report.nominated === true)) {
						const local = stats.get(report.localCandidateId);
						const remote = stats.get(report.remoteCandidateId);
						pairLine = `pair=${local ? local.candidateType : '?'}(${local ? local.protocol : '?'})>${remote ? remote.candidateType : '?'}(${remote ? remote.protocol : '?'})`;
					}
					if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
						let muted = '?';
						try {
							const trackStats = stats.get(report.trackId);
							if (trackStats) muted = String(trackStats.muted);
							else if (report.trackId) {
								const track = pc.getReceivers().map(r => r.track).find(tr => tr.id === report.trackId);
								if (track) muted = String(track.muted);
							}
						} catch (e) { /* ignore */ }
						inboundLine = `inbound packets=${report.packetsReceived !== undefined ? report.packetsReceived : '?'} bytes=${report.bytesReceived !== undefined ? report.bytesReceived : '?'} lost=${report.packetsLost !== undefined ? report.packetsLost : '?'} trackMuted=${muted}`;
					}
				});
				this.logPeerStatsLine(peerId, pairLine, inboundLine);
			} catch (e) { /* getStats unsupported */ }
		}, 5000);
	}

	logPeerStatsLine(peerId, pairLine, inboundLine) {
		const audio = this.audioElements.get(peerId);
		const playing = audio ? !audio.paused : 'no-element';
		console.log(`[VoiceChat] media-check (${peerId}): ${pairLine} | ${inboundLine} | elementPlaying=${playing}`);
	}

	setupAudioElement(peerId, stream) {
		this.removeAudioElement(peerId);
		// 同步上报远端轨道状态，便于区分“没有数据”与“数据到达但未播放”
		// Report remote track state to tell "no data" from "data arrives but not playing"
		try {
			const track = stream.getAudioTracks()[0];
			if (track) {
				console.log(`[VoiceChat] remote track (${peerId}): muted=${track.muted} enabled=${track.enabled} readyState=${track.readyState}`);
			}
		} catch (e) { /* ignore */ }
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

		audio.play().then(() => {
			console.log(`[VoiceChat] remote audio element playing (${peerId})`);
		}).catch((e) => {
			// 明确标记自动播放被拦截，一次手势后重试
			// Tag the autoplay block explicitly; retry once after any gesture
			console.warn(`[VoiceChat] autoplay-blocked (${peerId}):`, e && e.name, e && e.message);
			this.armUnlockRetry(peerId, audio);
		});

		// WebAudio 兜底：媒体音量流 + 独立于 <audio> 的播放 sink
		// WebAudio fallback: media-volume stream and an independent playback sink
		if (this.audioCtx && this.audioCtx.state !== 'closed') {
			try {
				const source = this.audioCtx.createMediaStreamSource(stream);
				source.connect(this.audioCtx.destination);
				this.audioSources.set(peerId, source);
				console.log(`[VoiceChat] webaudio sink attached (${peerId}), ctx.state=${this.audioCtx.state}`);
			} catch (e) {
				console.warn('[VoiceChat] webaudio attach failed:', e && e.name, e);
			}
		}

		// 8 秒后仍无声则给出恢复提示（点击屏幕 / 检查音量）
		// After 8s of silence, surface a recovery hint (tap screen / check volume)
		const hintTimer = setTimeout(() => {
			if (this.audioElements.get(peerId) === audio && audio.paused) {
				console.warn(`[VoiceChat] still silent after 8s (${peerId})`);
				addSystemMsg(t('voice.sound_hint', 'No remote sound yet — tap the screen once and check media/voice-call volume'));
				this.armUnlockRetry(peerId, audio);
			}
		}, 8000);
		if (this.statsTimers.has(peerId)) clearTimeout(this.statsTimers.get(peerId));
		this.statsTimers.set(peerId, hintTimer);

		if (this.isInCall) this.updateVoiceUI(true);
	}

	// 手势解锁：恢复 AudioContext 并重试所有待播放元素
	// Gesture unlock: resume the AudioContext and retry every pending element
	armUnlockRetry(peerId, audio) {
		if (this.audioUnlockBound) return;
		this.audioUnlockBound = () => {
			this.audioUnlockBound = null;
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
			for (const [pid, el] of this.audioElements) {
				el.play().then(() => {
					if (pid === peerId) console.log(`[VoiceChat] remote audio playing after gesture (${pid})`);
				}).catch(() => {});
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
			} catch (e) {
				console.warn('[VoiceChat] AudioContext unavailable:', e && e.name);
				return;
			}
		}
		if (this.audioCtx.state === 'suspended') {
			this.audioCtx.resume().catch(() => {});
		}
		console.log(`[VoiceChat] audio ctx state=${this.audioCtx.state}`);
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
		const hintTimer = this.statsTimers.get(peerId);
		if (hintTimer) {
			clearTimeout(hintTimer);
			this.statsTimers.delete(peerId);
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
		if (!this.isInCall && type !== 'voice-join') return;

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
		if (!this.isInCall) return;
		await this.createOfferForPeer(peerId);
	}

	async handleOffer(peerId, data) {
		if (!data.sdp) return;
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
		for (const [, timer] of this.statsTimers) {
			clearTimeout(timer);
		}
		this.statsTimers.clear();
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
		if (!this.isInCall) return;
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
				voiceBtn.title = '';
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
