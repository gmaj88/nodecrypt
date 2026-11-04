// TURN 凭据签发（Metered.ca Open Relay 静态认证 / TURN credential issuer for Metered Open Relay static auth）
// 客户端通过 GET /voice-turn 获取短时 ICE 服务器配置，缓解蜂窝 CGNAT 下的单向媒体流问题
// Clients fetch short-lived ICE config from GET /voice-turn to fix one-way media behind cellular CGNAT
// 说明：openrelayprojectsecret 为官方公开的共享静态密钥，属公开设计而非泄密
// Note: openrelayprojectsecret is the openly published shared static secret by design

const TURN_SECRET = 'openrelayprojectsecret';
const TURN_HOST = 'staticauth.openrelay.metered.ca';
const TURN_TTL_SECONDS = 3600;

let cachedTurn = null;

async function hmacSha1Base64(secret, message) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
	const bytes = new Uint8Array(mac);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function buildIceServers(username, credential) {
	return [
		{ urls: `turn:${TURN_HOST}:80`, username, credential },
		{ urls: `turn:${TURN_HOST}:80?transport=tcp`, username, credential },
		{ urls: `turn:${TURN_HOST}:443`, username, credential },
		{ urls: `turn:${TURN_HOST}:443?transport=tcp`, username, credential },
		{ urls: `turns:${TURN_HOST}:443?transport=tcp`, username, credential }
	];
}

// 短时凭据：username=过期时间戳，password=HMAC-SHA1(secret, username)，cf/metered 静态认证通用格式
// Short-lived credential: username = expiry timestamp, password = HMAC-SHA1(secret, username)
export async function getVoiceTurnIceServers() {
	try {
		const now = Math.floor(Date.now() / 1000);
		const minFresh = now + 300;
		if (cachedTurn && cachedTurn.expiresAt > minFresh) {
			return cachedTurn.iceServers;
		}
		const expiresAt = now + TURN_TTL_SECONDS;
		const username = String(expiresAt);
		const credential = await hmacSha1Base64(TURN_SECRET, username);
		cachedTurn = { expiresAt, iceServers: buildIceServers(username, credential) };
		return cachedTurn.iceServers;
	} catch (error) {
		return [];
	}
}
