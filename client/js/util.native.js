// uniapp 原生外壳桥接模块 / uniapp native shell bridge
// 只有当页面运行在 uniapp APP 的 webview 中时，window.uni.postMessage 才可用
// window.uni.postMessage from uni.webview.js only exists inside uniapp APP webview

export function isAppShell() {
	if (typeof navigator === 'undefined') return false;
	if (typeof window !== 'undefined' && typeof window.plus !== 'undefined') return true;
	return /uni-app/i.test(navigator.userAgent);
}

// 向 uniapp 原生层 postMessage（web-view 组件 @message 事件 e.detail.data 数组接收）
// postMessage to the native layer (received in web-view component @message event)
export function postMessageToNative(data) {
	try {
		if (typeof window === 'undefined' || !window.uni || typeof window.uni.postMessage !== 'function') {
			return false;
		}
		window.uni.postMessage({ data: data });
		return true;
	} catch (error) {
		console.warn('[native-bridge] postMessage failed:', error);
		return false;
	}
}

// 从 URL 中读取 uniapp 外壳传入的 pushCid 并保存为全局 pushToken
// Read pushCid passed by the uniapp shell from URL and save it as global pushToken
export function initNativeBridge() {
	try {
		if (typeof window !== 'undefined' && window.nativePushToken == null) {
			window.nativePushToken = '';
		}
		if (typeof window === 'undefined') return;
		const params = new URLSearchParams(window.location.search);
		const cid = params.get('cid');
		if (cid && isAppShell()) {
			window.nativePushToken = cid;
		}
	} catch (error) {
		console.warn('[native-bridge] init failed:', error);
	}

	// 挂载到 window，供 room.js / NodeCrypt.js 等模块使用
	if (typeof window !== 'undefined') {
		window.__postToNative = postMessageToNative;
		window.__isAppShell = isAppShell;
	}
}

if (typeof window !== 'undefined') {
	window.__postToNative = postMessageToNative;
	window.__isAppShell = isAppShell;
}
