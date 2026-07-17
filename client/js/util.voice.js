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
		this.callStartTime = null;
		this.timerInterval = null;
		this.pendingCandidates = new Map();
		this.activeCallers = new Set();
		this.audioCtx = null;

		this.handleSignalingMessage = this.handleSignalingMessage.bind(this);
		this.destroy = this.destroy.bind(this);
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

		const peers = this.getPeersWithSharedKey();
		if (peers.length === 0) {
			addSystemMsg(t('voice.no_peers', 'No other members to call'));
			return;
		}

		try {
			this.localStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
				video: false
			});
		} catch (e) {
			console.error('[VoiceChat] getUserMedia failed:', e);
			addSystemMsg(t('voice.permission_denied', 'Microphone access denied'));
			return;
		}

		try {
			this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			if (this.audioCtx.state === 'suspended') {
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
		audio.id = `voice-audio-${peerId}`;
		audio.style.display = 'none';
		document.body.appendChild(audio);
		this.audioElements.set(peerId, audio);
		if (this.isInCall) this.updateVoiceUI(true);
	}

	removeAudioElement(peerId) {
		const existing = this.audioElements.get(peerId);
		if (existing) {
			existing.srcObject = null;
			existing.remove();
			this.audioElements.delete(peerId);
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
			if (this.peerConnections.size === 0 && this.getLocalTracks().length > 0) {
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
		this.isMuted = false;
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
		if (!this.isInCall || !this.localStream) return;
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
