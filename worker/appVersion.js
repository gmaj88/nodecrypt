// APP 自动更新版本源（唯一发版登记处）
// Single source of truth for the APP auto-update release info
// 发版时更新本文件：versionCode（统一规则：1.1.3 → 113，即小数点拼数字）、url、note、force
// url 支持任意直链：GitHub Releases 慢时切到镜像 https://ai.aiui.de5.net/app/Channel-X.apk
// （镜像由 scripts/fetch-apk.mjs 在 build 时从 mirror.source 下载到 dist/<mirror.path>，
//  随 Worker 静态资源部署；mirror 字段仅构建用，/api/app-version 不返回。）
// Release: https://github.com/gmaj88/nodecrypt/releases (tag: app-vX.Y.Z)
//
// APP 主站域名（唯一配置处）：通过 /api/app-version 的 origin 字段下发，APP 启动时解析并切换。
// 换域名只改这里；旧域名建议继续服务一段时间，让旧安装包完成更新/解析切换。
// Primary origin for the APP (single config point), served as /api/app-version's origin field.
export const APP_ORIGIN = 'https://ai.aiui.de5.net/';

export const APP_VERSION = {
	versionCode: 120,
	versionName: '1.2.0',
	url: 'https://github.com/gmaj88/nodecrypt/releases/download/app-v1.2.0/Channel-1.2.0.apk',
	size: 0,
	sha256: '',
	note: '',
	force: false,
	mirror: {
		source: 'https://github.com/gmaj88/nodecrypt/releases/download/app-v1.2.0/Channel-1.2.0.apk',
		path: 'app/Channel-1.2.0.apk'
	}
};
