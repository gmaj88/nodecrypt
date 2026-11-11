// 构建后镜像 APK：从 worker/appVersion.js 的 mirror.source 下载到 dist/<mirror.path>
// Post-build APK mirror: download worker/appVersion.js mirror.source into dist/<mirror.path>
// 用途：GitHub 在大陆访问慢时，把 /api/app-version 的 url 切到
// https://ai.aiui.de5.net/app/Channel-X.apk（随 Worker 静态资源部署，单文件上限 25MiB）
// Purpose: when GitHub downloads are slow, point /api/app-version's url at the
// https://ai.aiui.de5.net/app/... mirror served with the Worker's static assets (25 MiB/file cap)
// 失败只告警不阻断构建：客户端 url 可回退 GitHub 直链，Web 部署不受影响
// Warn-only on failure: the client url still works via the GitHub direct link, web deploy unaffected
// 刷新镜像：dist/ 是构建产物，删除 dist/app 后重新 npm run build 即可重拉
// To refresh: dist/ is build output - delete dist/app and run npm run build again
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../worker/appVersion.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
	const { source, path: relPath } = APP_VERSION.mirror || {};
	if (!source || !relPath) {
		console.log('[fetch-apk] mirror not configured, skip');
		return;
	}
	const target = path.join(root, 'dist', relPath);
	if (existsSync(target) && statSync(target).size > 0) {
		console.log(`[fetch-apk] exists, skip: ${relPath} (${statSync(target).size} bytes)`);
		return;
	}
	console.log(`[fetch-apk] downloading ${source}`);
	const res = await fetch(source, { redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} (release asset may not exist yet)`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (!buf.length) {
		throw new Error('empty response body');
	}
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, buf);
	console.log(`[fetch-apk] saved dist/${relPath} (${buf.length} bytes)`);
}

main().catch((error) => {
	console.warn(`[fetch-apk] mirror failed, continue without it (client url falls back to GitHub): ${error && error.message}`);
});
