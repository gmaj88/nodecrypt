// Import dicebear avatar libraries
// 导入 dicebear 头像库
import * as dicebearCore from '@dicebear/core';
import * as dicebearMicah from '@dicebear/micah';
// Predefined background colors
// 预设背景色数组
const bgColors = ["f87171", "fb923c", "09acf4", "fb923c", "f472b6", "a78bfa", "34d399"];
// Pick a color based on seed string
// 根据种子字符串选择颜色
function pickColor(seed) {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
	return bgColors[Math.abs(hash) % bgColors.length]
}
// Create SVG avatar for user name
// 为用户名生成 SVG 头像
// 头像 SVG 缓存：同用户名只生成一次（dicebear 生成有一定 DOM/计算开销，
// 每条消息都重建会在低端手机 webview 上放大 CPU 占用）
// Avatar SVG cache: generate once per username (dicebear generation costs real
// CPU-DOM work; recreating it for every message amplifies load on low-end webviews)
const avatarCache = new Map();
export function createAvatarSVG(userName) {
	if (avatarCache.has(userName)) {
		return avatarCache.get(userName);
	}
	const svg = dicebearCore.createAvatar(dicebearMicah, {
		seed: userName,
		baseColor: ["f7e1c3", "f9c9b6", "f2d6cb", "f8ce8e", "eac393"],
		backgroundColor: [pickColor(userName)]
	}).toString();
	if (avatarCache.size > 300) avatarCache.clear();
	avatarCache.set(userName, svg);
	return svg;
}