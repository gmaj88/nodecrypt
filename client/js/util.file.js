// Import necessary modules
// 导入必要的模块
import { deflate, inflate } from 'fflate';
import { showFileUploadModal } from './util.fileUpload.js';
import { roomsData, activeRoomIndex } from './room.js';

// 分卷大小统一配置
const DEFAULT_VOLUME_SIZE = 256 * 1024; // 256KB

// 单帧体积预算：频道广播帧包含每个目标成员各一份密文，
// 分卷批量按 目标成员数 × 单卷密文长度 动态收敛，避免大群一次发出数 MB 帧
// （worker 入站上限 8MB，超限会被静默丢弃；大帧也会拉高转推延迟）
// Per-frame size budget: a channel frame carries one ciphertext per target member,
// so the batch size shrinks as the roster grows (worker rejects frames > 8MB)
const FRAME_BUDGET = 2 * 1024 * 1024;
const MIN_BATCH = 1;
const MAX_BATCH = 3;
// 发送期间短暂掉线（自愈重连通常 3s）不立即中止，等待重连后从当前卷续传
const RECONNECT_WAIT_MS = 20000;
// 接收端无任何新卷超过该时长判失败（发送方卡死/掉线/丢卷不再重发）
const RECEIVE_TIMEOUT_MS = 90000;
// 文件收发期间推迟看门狗判死（与 APP 端 deferWatchdog 对齐）
const FILE_WATCHDOG_DEFER_MS = 30000;

// File transfer state management
// 文件传输状态管理
window.fileTransfers = new Map();

// 文件收发期间延期心跳看门狗：压缩/加解密占用主线程时 pong 回调会迟到，
// 旧行为会在传输中途 forceReconnect，导致下一批分卷"未连接"直接中止
// Defer the heartbeat watchdog during bulk transfers: compression/encryption
// blocks the main thread, late pongs must not kill a live socket mid-transfer
function deferFileWatchdog(ms) {
	const rd = roomsData && activeRoomIndex >= 0 ? roomsData[activeRoomIndex] : null;
	const chat = rd && rd.chat;
	if (chat && typeof chat.deferWatchdog === 'function') {
		chat.deferWatchdog(ms || FILE_WATCHDOG_DEFER_MS)
	}
}

function activeChat() {
	const rd = roomsData && activeRoomIndex >= 0 ? roomsData[activeRoomIndex] : null;
	return rd && rd.chat ? rd.chat : null
}

// 连接可用性：serverShared 未建立（握手未完成）同样视为不可发
// Connection usable: an unfinished server handshake counts as offline
function isFileLinkOnline() {
	const chat = activeChat();
	return !!(chat && chat.serverShared && typeof chat.isOpen === 'function' && chat.isOpen())
}

// 目标成员数（私聊恒为 1），用于计算单帧体积
// Number of targets for one send (1 for private chat), used for frame budgeting
function fileRosterCount() {
	const rd = roomsData && activeRoomIndex >= 0 ? roomsData[activeRoomIndex] : null;
	if (rd && rd.privateChatTargetId) return 1;
	const chat = rd && rd.chat;
	return chat ? Object.keys(chat.channel || {}).length : 0
}

function fileTargetCount() {
	return Math.max(1, fileRosterCount())
}

// 单卷在"客户端→服务端"帧里的近似字符数：base64 → ChaCha(base64) → AES(base64)
// 两次 4/3 膨胀，实测约 1.79 倍
function estimateVolumeFrameChars(volumeData) {
	return Math.ceil((volumeData || '').length * 1.8)
}

// 按帧预算计算每批卷数
function computeBatchSize(volumes, offset) {
	if (!volumes || !volumes.length) return MIN_BATCH;
	const perVolume = estimateVolumeFrameChars(volumes[Math.min(offset || 0, volumes.length - 1)]);
	const targets = fileTargetCount();
	const fit = Math.floor(FRAME_BUDGET / Math.max(1, perVolume * targets));
	return Math.max(MIN_BATCH, Math.min(MAX_BATCH, fit || MIN_BATCH))
}

// Base64 encoding for binary data (more efficient than hex)
// Base64编码用于二进制数据（比十六进制更高效）
function arrayBufferToBase64(buffer) {
	const uint8Array = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000; // 32KB chunks to avoid call stack limits
	
	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		const chunk = uint8Array.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk);
	}
	
	return btoa(binary);
}

// Base64 decoding back to binary
// Base64解码回二进制数据
function base64ToArrayBuffer(base64) {
	const binary = atob(base64);
	const uint8Array = new Uint8Array(binary.length);
	
	for (let i = 0; i < binary.length; i++) {
		uint8Array[i] = binary.charCodeAt(i);
	}
	
	return uint8Array;
}

// Generate unique file ID
// 生成唯一文件ID
function generateFileId() {
	return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Calculate SHA-256 hash for data integrity verification
// 计算SHA-256哈希值用于数据完整性验证
async function calculateHash(data) {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}



// Compress file into volumes with optimized compression
// 将文件压缩为分卷，优化压缩算法
async function compressFileToVolumes(file, volumeSize = DEFAULT_VOLUME_SIZE) { // 96KB原始数据，base64后约128KB
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = async function(e) {
			const arrayBuffer = new Uint8Array(e.target.result);
			
			try {
				// Calculate hash of original file for integrity
				const originalHash = await calculateHash(arrayBuffer);
				
				// Use single compression pass with balanced compression
				// 使用单次压缩，平衡压缩率和速度
				deflate(arrayBuffer, { 
					level: 6, // 平衡压缩级别
					mem: 8    // 合理内存使用
				}, (err, compressed) => {
					if (err) {
						reject(err);
						return;
					}
					
					// Split compressed data into volumes
					const volumes = [];
					for (let i = 0; i < compressed.length; i += volumeSize) {
						const volume = compressed.slice(i, i + volumeSize);
						volumes.push(arrayBufferToBase64(volume));
					}
					
					resolve({
						volumes,
						originalSize: file.size,
						compressedSize: compressed.length,
						originalHash
					});
				});
			} catch (hashError) {
				reject(hashError);
			}
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

// Compress multiple files into a single archive with volumes
// 将多个文件压缩为单个分卷归档
async function compressFilesToArchive(files, volumeSize = DEFAULT_VOLUME_SIZE) {	try {
		// Create a simple archive format: [file1_size][file1_name_length][file1_name][file1_data][file2_size]...
		// 创建简单的归档格式
		const archiveData = [];
		const fileManifest = [];
		
		for (const file of files) {
			const fileBuffer = await readFileAsArrayBuffer(file);
			const nameBytes = new TextEncoder().encode(file.name);
			
			// Add file metadata to manifest
			fileManifest.push({
				name: file.name,
				size: file.size,
				offset: 0 // Will be calculated later
			});
			
			// File format: [name_length(4)][name][size(8)][data]
			// Use separate arrays to avoid alignment issues
			const nameLengthBytes = new Uint8Array(4);
			const nameLengthView = new DataView(nameLengthBytes.buffer);
			nameLengthView.setUint32(0, nameBytes.length, true); // little endian
			
			const fileSizeBytes = new Uint8Array(8);
			const fileSizeView = new DataView(fileSizeBytes.buffer);
			fileSizeView.setBigUint64(0, BigInt(file.size), true); // little endian
			
			archiveData.push(
				nameLengthBytes,
				nameBytes,
				fileSizeBytes,
				new Uint8Array(fileBuffer)
			);
		}		
		// Combine all data
		const totalLength = archiveData.reduce((sum, part) => sum + part.length, 0);
		
		const combinedData = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const part of archiveData) {
			combinedData.set(part, offset);
			offset += part.length;
		}
		
		// Calculate hash of the entire archive
		const archiveHash = await calculateHash(combinedData);
		
		// Compress the archive
		return new Promise((resolve, reject) => {
			deflate(combinedData, { 
				level: 6,
				mem: 8
			}, (err, compressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Split compressed data into volumes
				const volumes = [];
				for (let i = 0; i < compressed.length; i += volumeSize) {
					const volume = compressed.slice(i, i + volumeSize);
					volumes.push(arrayBufferToBase64(volume));
				}
				
				resolve({
					volumes,
					originalSize: totalLength,
					compressedSize: compressed.length,
					archiveHash,
					fileCount: files.length,
					fileManifest
				});
			});
		});
	} catch (error) {
		throw new Error(`Archive compression failed: ${error.message}`);
	}
}

// Helper function to read file as array buffer
// 辅助函数：将文件读取为ArrayBuffer
function readFileAsArrayBuffer(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = (e) => resolve(e.target.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

// Decompress volumes back to file
// 将分卷解压回文件
async function decompressVolumesToFile(volumes, fileName, originalHash = null) {
	try {
		// Combine all volumes using base64 decoding
		const combinedData = volumes.map(volume => {
			return base64ToArrayBuffer(volume);
		});
		
		const totalLength = combinedData.reduce((sum, arr) => sum + arr.length, 0);
		const compressed = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const data of combinedData) {
			compressed.set(data, offset);
			offset += data.length;
		}
				// Decompress
		return new Promise((resolve, reject) => {
			inflate(compressed, async (err, decompressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Verify hash if provided
				if (originalHash) {
					try {
						const calculatedHash = await calculateHash(decompressed);
						if (calculatedHash !== originalHash) {
							reject(new Error('File integrity check failed: hash mismatch'));
							return;
						}
					} catch (hashError) {
						reject(new Error('File integrity check failed: ' + hashError.message));
						return;
					}
				}
				
				// Create blob and download（下载触发 pagehide 的浏览器上：申请暂离抑制短窗）
				try { window.dispatchEvent(new CustomEvent('nodecrypt-suppress-leave')) } catch (e) {}
				const blob = new Blob([decompressed]);
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = fileName;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
				
				resolve();
			});
		});
	} catch (error) {
		console.error('Decompression error:', error);
		throw error;
	}
}

// Decompress archive volumes to multiple files
// 将归档分卷解压为多个文件
async function decompressArchiveToFiles(volumes, fileManifest, archiveHash = null) {
	try {
		// Combine all volumes using base64 decoding
		const combinedData = volumes.map(volume => {
			return base64ToArrayBuffer(volume);
		});
		
		const totalLength = combinedData.reduce((sum, arr) => sum + arr.length, 0);
		const compressed = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const data of combinedData) {
			compressed.set(data, offset);
			offset += data.length;
		}
		
		// Decompress archive
		return new Promise((resolve, reject) => {
			inflate(compressed, async (err, decompressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Verify archive hash if provided
				if (archiveHash) {
					try {
						const calculatedHash = await calculateHash(decompressed);
						if (calculatedHash !== archiveHash) {
							reject(new Error('Archive integrity check failed: hash mismatch'));
							return;
						}
					} catch (hashError) {
						reject(new Error('Archive integrity check failed: ' + hashError.message));
						return;
					}
				}
						// Extract files from archive
				let dataOffset = 0;
				const extractedFiles = [];
						for (const fileInfo of fileManifest) {
					// Read file metadata: [name_length(4)][name][size(8)][data]
					const nameLengthBytes = decompressed.slice(dataOffset, dataOffset + 4);
					const nameLengthView = new DataView(nameLengthBytes.buffer);
					const nameLength = nameLengthView.getUint32(0, true); // little endian
					dataOffset += 4;
					
					const nameBytes = decompressed.slice(dataOffset, dataOffset + nameLength);
					const fileName = new TextDecoder().decode(nameBytes);
					dataOffset += nameLength;
					
					// Use DataView to read BigUint64 safely
					const fileSizeBytes = decompressed.slice(dataOffset, dataOffset + 8);
					const fileSizeView = new DataView(fileSizeBytes.buffer);
					const fileSize = Number(fileSizeView.getBigUint64(0, true)); // little endian
					dataOffset += 8;
					
					const fileData = decompressed.slice(dataOffset, dataOffset + fileSize);
					dataOffset += fileSize;
					
					// Create and download file（下载触发 pagehide 的浏览器上：申请暂离抑制短窗）
					try { window.dispatchEvent(new CustomEvent('nodecrypt-suppress-leave')) } catch (e) {}
					const blob = new Blob([fileData]);
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = fileName;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
					
					extractedFiles.push(fileName);
					
					// Add small delay between downloads to avoid overwhelming the browser
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				
				resolve(extractedFiles);
			});
		});
	} catch (error) {
		console.error('Archive decompression error:', error);
		throw error;
	}
}

// Setup file sending functionality
// 设置文件发送功能
export function setupFileSend({
	inputSelector,
	attachBtnSelector,
	fileInputSelector,
	onSend
}) {
	const attachBtn = document.querySelector(attachBtnSelector);
	
	if (attachBtn) {
		// 点击附件按钮显示文件上传模态框
		// Click attach button to show file upload modal
		attachBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			
			showFileUploadModal(async (files) => {
				// 传递 userName 给 onSend
				const userName = roomsData && activeRoomIndex >= 0
					? (roomsData[activeRoomIndex]?.myUserName || '')
					: '';
				await handleFilesUpload(files, (msg) => {
					// 合并 userName 字段
					return onSend({ ...msg, userName });
				});
			});
		});
	}
}

// Handle files upload
// 处理文件上传
async function handleFilesUpload(files, onSend) {
	if (!files || files.length === 0) return;
	
	const fileId = generateFileId();
	
	try {
		// Show compression progress
		let progressElement = null;
		
		function showProgress(message) {
			// 删除系统提示
		}
		
		function updateProgress(message) {
			// 删除系统提示
		}

		// 压缩前先续期看门狗：50MB 文件压缩会长期占用主线程，心跳回调迟到
		// 不能触发自断连接（发送中途掉线的直接原因）
		deferFileWatchdog(120000);
		
		if (files.length === 1) {
			// Single file upload
			const file = files[0];
			showProgress();
			
			const { volumes, originalSize, compressedSize, originalHash } = await compressFileToVolumes(file);
			
			updateProgress();
			
			// Create file transfer state
			const fileTransfer = {
				fileId,
				fileName: file.name,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				sentVolumes: 0,
				status: 'sending',
				originalHash,
				sawRoster: fileRosterCount() > 0,
				cancelledPeers: new Set()
			};
			
			window.fileTransfers.set(fileId, fileTransfer);
			
			// 发送前等待连接就绪（自愈重连窗口内不再直接放弃）
			await waitForLink(fileTransfer);
			if (fileTransfer.status === 'failed') return;

			// Send file start message
			const startStatus = onSend({
				type: 'file_start',
				fileId,
				fileName: file.name,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				originalHash
			});
			if (startStatus && (startStatus.failed || startStatus.aborted)) {
				abortBeforeVolumes(fileTransfer, file.name, startStatus);
				return;
			}
			
			// Send volumes
			await sendVolumes(fileId, volumes, onSend, updateProgress, file.name);
			
		} else {
			// Multiple files upload - create archive
			const totalSize = files.reduce((sum, file) => sum + file.size, 0);
			showProgress();
			
			const { volumes, originalSize, compressedSize, archiveHash, fileCount, fileManifest } = await compressFilesToArchive(files);
			
			updateProgress();
			
			// Create file transfer state for archive
			const fileTransfer = {
				fileId,
				fileName: `${files.length} files.zip`, // Virtual archive name
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				sentVolumes: 0,
				status: 'sending',
				archiveHash,
				fileCount,
				fileManifest,
				isArchive: true,
				sawRoster: fileRosterCount() > 0,
				cancelledPeers: new Set()
			};
			
			window.fileTransfers.set(fileId, fileTransfer);
			
			await waitForLink(fileTransfer);
			if (fileTransfer.status === 'failed') return;

			// Send archive start message
			const startStatus = onSend({
				type: 'file_start',
				fileId,
				fileName: `${files.length} files`,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				archiveHash,
				fileCount,
				fileManifest,
				isArchive: true
			});
			if (startStatus && (startStatus.failed || startStatus.aborted)) {
				abortBeforeVolumes(fileTransfer, `${files.length} files`, startStatus);
				return;
			}
			
			// Send volumes
			await sendVolumes(fileId, volumes, onSend, updateProgress, `${files.length} files`);
		}
		
	} catch (error) {
		console.error('File compression error:', error);
		if (window.addSystemMsg) {
			window.addSystemMsg(`Failed to compress files: ${error.message}`);
		}
	}
}

// 发送失败原因 → 用户可读文案（配合 core 返回的 reason 码定位问题）
function fileReasonText(reason) {
	switch (reason) {
		case 'offline': return '当前未连接服务器'
		case 'not-ready': return '有成员尚未就绪'
		case 'too-large': return '数据帧超过服务端上限'
		case 'encrypt-failed': return '消息加密失败'
		case 'send-failed': return '连接已断开'
		default: return '请稍后重试'
	}
}

// 连接未就绪时暂停等待自愈重连（每 400ms 探测，超时判失败）
function waitForLink(transfer) {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		let notified = false;
		const tick = () => {
			if (transfer.status === 'failed') return resolve(false);
			// 重连后名单晚于握手到达：入房时曾有成员而名单暂空，视为尚未就绪
			// (otherwise a batch could be dropped into an empty roster)
			if (fileRosterCount() > 0) transfer.sawRoster = true;
			const rosterReady = !transfer.sawRoster || fileRosterCount() > 0;
			if (rosterReady && isFileLinkOnline()) {
				if (transfer.status === 'paused') {
					transfer.status = 'sending';
					updateFileProgress(transfer.fileId);
				}
				return resolve(true)
			}
			if (Date.now() - startedAt > RECONNECT_WAIT_MS) {
				transfer.status = 'failed';
				updateFileProgress(transfer.fileId);
				if (window.addSystemMsg) {
					window.addSystemMsg(`文件「${transfer.fileName}」发送已取消：网络中断超过 ${Math.round(RECONNECT_WAIT_MS / 1000)} 秒`)
				}
				return resolve(false)
			}
			if (!notified) {
				notified = true;
				transfer.status = 'paused';
				updateFileProgress(transfer.fileId)
			}
			setTimeout(tick, 400)
		};
		tick()
	})
}

// 首个控制帧（file_start）都发不出去：卡片置失败并给出具体原因
function abortBeforeVolumes(transfer, displayName, status) {
	transfer.status = 'failed';
	updateFileProgress(transfer.fileId);
	if (window.addSystemMsg) {
		window.addSystemMsg(`文件「${displayName}」发送已取消：${fileReasonText(status && status.reason)}`)
	}
}


// Send volumes with progress tracking
// 发送分卷并跟踪进度。
// 背压：onSend 返回 aborted/false 说明有成员未就绪或加密失败 —— 立即中止并提示，
// 绝不静默丢卷（旧实现把卷丢进 outbox，50 条上限会静默丢弃最旧的卷，
// 接收端永远等不齐、进度条卡死）。
// Backpressure: onSend returning aborted/false means a member is not ready or
// encryption failed — abort immediately with a notice; never silently drop volumes
// (the old code queued them into an outbox whose 50-entry cap dropped the oldest,
// leaving receivers waiting forever with a stuck progress bar).
async function sendVolumes(fileId, volumes, onSend, updateProgress, fileName) {
	const fileTransfer = window.fileTransfers.get(fileId);
	if (!fileTransfer) return;
	if (!fileTransfer.cancelledPeers) fileTransfer.cancelledPeers = new Set();

	let currentVolume = 0;
	let aborted = false;

	// 中止：标记失败态 + 系统提示（接收方不会再收到后续卷，早停比静默截断诚实）
	// Abort: mark failed + system notice (receivers get no further volumes; failing
	// early is more honest than a silent truncation)
	function abortTransfer(reason) {
		if (aborted) return;
		aborted = true;
		fileTransfer.status = 'failed';
		updateFileProgress(fileId);
		if (window.addSystemMsg) {
			window.addSystemMsg(`文件「${fileName}」发送已取消：${reason}`);
		}
	}

	// 发送方主动取消入口（当前 UI 未挂按钮，保留给后续/外部调用）
	fileTransfer.cancelSend = () => abortTransfer('已取消');

	// 接收方取消：跳过该成员继续投递给其他人；所有目标都取消才中止
	// Peer cancelled: skip that member and keep delivering to the rest; abort only
	// when every target has cancelled
	function allPeersCancelled() {
		const peers = fileTransfer.cancelledPeers;
		return !!(peers && peers.size > 0 && peers.size >= fileTargetCount())
	}

	async function sendNextBatch() {
		if (aborted) return;
		if (allPeersCancelled()) {
			abortTransfer('所有接收方已取消接收');
			return;
		}
		// 掉线（自愈重连窗口内）暂停等待，恢复后从当前卷续传
		if (!(await waitForLink(fileTransfer))) {
			aborted = true;
			return;
		}
		if (aborted) return;

		const skipIds = Array.from(fileTransfer.cancelledPeers || []);
		const sendOpts = skipIds.length ? { skip: skipIds } : undefined;

		if (currentVolume >= volumes.length) {
			// 发送完成消息（已取消的成员不再投递）
			const completeResult = onSend({ type: 'file_complete', fileId }, sendOpts);
			if (!completeResult || completeResult === false || completeResult.aborted) {
				abortTransfer(completeResult && completeResult.reason === 'not-ready'
					? '有成员尚未就绪，已取消发送'
					: fileReasonText(completeResult && completeResult.reason));
				return;
			}

			fileTransfer.status = 'completed';
			updateFileProgress(fileId);
			updateProgress(`✓ Sent ${fileName} successfully`);
			return;
		}

		// 大流量期间续期看门狗（加密/发送阻塞导致的心跳迟到不该断链）
		deferFileWatchdog();

		// 按帧体积预算动态收敛批量（成员越多每批卷数越少）
		const batchSize = computeBatchSize(volumes, currentVolume);
		const batchEnd = Math.min(currentVolume + batchSize, volumes.length);

		// 发送批次中的所有分卷；任一卷被拒（未就绪/帧过大/掉线）即中止并给出原因
		// Send all volumes of the batch; any rejected volume aborts with a reason
		for (let i = currentVolume; i < batchEnd; i++) {
			const result = onSend({
				type: 'file_volume',
				fileId,
				volumeIndex: i,
				volumeData: volumes[i],
				isLast: i === volumes.length - 1
			}, sendOpts);
			if (!result || result === false || result.aborted) {
				abortTransfer(result && result.reason === 'not-ready'
					? '有成员尚未就绪，已取消发送'
					: fileReasonText(result && result.reason));
				return;
			}
		}

		// 更新发送进度
		fileTransfer.sentVolumes = batchEnd;
		updateFileProgress(fileId);

		currentVolume = batchEnd;

		// 继续发送下一批（150ms 节流，对齐 APP 的稳态节奏）
		setTimeout(sendNextBatch, 150);
	}

	// 开始发送
	sendNextBatch();
}

// Update file progress in chat
// 更新聊天中的文件进度
function updateFileProgress(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer) return;
	const elements = document.querySelectorAll(`[data-file-id="${fileId}"]`);
	elements.forEach(element => {
		const progressContainer = element.querySelector('.file-progress-container');
		const progressBar = element.querySelector('.file-progress');
		const statusText = element.querySelector('.file-status');
		const downloadBtn = element.querySelector('.file-download-btn');
		const cancelBtn = element.querySelector('.file-cancel-btn');
		
		// 判断是否为发送方（发送方没有volumeData）
		const isSender = !transfer.volumeData || transfer.volumeData.length === 0;
		
		if (transfer.status === 'sending') {
			const progress = (transfer.sentVolumes / transfer.totalVolumes) * 100;
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = `${progress}%`;
			if (statusText) statusText.textContent = `Sending ${transfer.sentVolumes}/${transfer.totalVolumes}`;
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
		} else if (transfer.status === 'paused') {
			// 发送端暂停（等待自愈重连）：保留进度，明确提示不是取消
			const progress = (transfer.sentVolumes / transfer.totalVolumes) * 100;
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = `${progress}%`;
			if (statusText) statusText.textContent = '网络重连中，已暂停… / Reconnecting, paused';
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
			if (cancelBtn) cancelBtn.style.display = 'none';
		} else if (transfer.status === 'receiving') {
			const progress = (transfer.receivedVolumes.size / transfer.totalVolumes) * 100;
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = `${progress}%`;
			if (statusText) statusText.textContent = `Receiving ${transfer.receivedVolumes.size}/${transfer.totalVolumes}`;
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
		} else if (transfer.status === 'completed') {
			// 传输完成时的动画序列
			if (progressContainer) {
				// 先添加淡出动画类
				progressContainer.classList.add('fade-out');
				// 延迟后完全隐藏
				setTimeout(() => {
					progressContainer.style.display = 'none';
				}, 400);
			}
			
			if (downloadBtn) {
				// 只有接收方才显示下载按钮
				if (isSender) {
					downloadBtn.classList.remove('show', 'animate-in');
					downloadBtn.style.display = 'none';
				} else {
					// 延迟显示下载按钮，等进度条消失动画完成
					setTimeout(() => {
						downloadBtn.style.display = 'flex';
						downloadBtn.classList.add('show');
						downloadBtn.disabled = false;
						// 添加进入动画
						setTimeout(() => {
							downloadBtn.classList.add('animate-in');
						}, 50);
						// 清理动画类
						setTimeout(() => {
							downloadBtn.classList.remove('animate-in');
						}, 550);
					}, 200);
				}
			}
		} else if (transfer.status === 'failed') {
			// 中止/取消：状态文字更新（系统消息里有具体原因），进度条归零不再卡在 Sending x/y
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = '0%';
			if (statusText) statusText.textContent = transfer.statusText || (isSender ? '发送已取消 / Send cancelled' : '接收中断 / Transfer failed');
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
			if (cancelBtn) cancelBtn.style.display = 'none';
		}
	});
}

// Handle incoming file messages
// 处理接收到的文件消息
// fromClientId：消息来源（room.js 透传），用于文件取消的定向回信
// fromClientId: the sender's clientId (passed by room.js), used to route cancels
export function handleFileMessage(message, isPrivate = false, fromClientId = '') {
	const { type } = message || {};

	if (type === 'file_cancel') {
		handleFileCancel(message, fromClientId);
		return;
	}

	switch (type) {
		case 'file_start':
			handleFileStart(message, isPrivate, fromClientId);
			break;
		case 'file_volume':
			handleFileVolume(message);
			break;
		case 'file_complete':
			handleFileComplete(message);
			break;
	}
}

// 文件取消：接收方取消 → 发送端跳过该成员继续给其他人；
// 发送端取消 → 接收端释放分卷并置失败（不再永久卡在"接收中"）
// file_cancel: a receiver opted out (the sender skips that member and continues for
// the others), or the sender gave up (receivers release volumes and fail cleanly)
function handleFileCancel(message, fromClientId) {
	const transfer = message && message.fileId ? window.fileTransfers.get(message.fileId) : null;
	if (!transfer) return;

	if (transfer.status === 'sending' || transfer.status === 'paused') {
		// 发送端：登记取消者，后续分卷/完成帧跳过它
		if (!transfer.cancelledPeers) transfer.cancelledPeers = new Set();
		if (fromClientId) transfer.cancelledPeers.add(fromClientId);
		if (window.addSystemMsg) {
			window.addSystemMsg(`文件「${transfer.fileName}」：有接收方取消了接收，其余成员继续接收`);
		}
		return;
	}

	if (transfer.status !== 'receiving') return;

	transfer.status = 'failed';
	transfer.statusText = '发送方已取消发送';
	transfer.volumeData = null;
	updateFileProgress(transfer.fileId);
}

// 接收端超时扫描：无任何新卷超过 RECEIVE_TIMEOUT_MS 判失败并释放分卷内存
// （发送方崩溃/掉线/被取消后不再重发，旧实现会永远停在 Receiving x/y）
// Receiver sweep: no new volume for RECEIVE_TIMEOUT_MS → fail and release volumes
let receiveSweepTimer = null;
function armReceiveSweep() {
	if (receiveSweepTimer) return;
	receiveSweepTimer = setInterval(() => {
		const now = Date.now();
		let active = 0;
		for (const [fileId, transfer] of window.fileTransfers) {
			if (transfer.status !== 'receiving') continue;
			if (now - (transfer.lastActivityAt || transfer.startedAt || now) > RECEIVE_TIMEOUT_MS) {
				transfer.status = 'failed';
				transfer.statusText = '传输超时，请让对方重新发送';
				transfer.volumeData = null;
				updateFileProgress(fileId);
				if (window.addSystemMsg) {
					window.addSystemMsg(`文件「${transfer.fileName}」接收超时：对方已停止发送，请让其重新发送`);
				}
			} else {
				active += 1;
			}
		}
		if (active === 0) {
			clearInterval(receiveSweepTimer);
			receiveSweepTimer = null;
		}
	}, 5000);
}

// 接收方主动放弃接收：本地释放分卷 + 卡片置失败 + 通知发送方跳过自己
// Receiver-give-up: release volumes locally, fail the card, tell the sender to skip us
export function cancelFileReceive(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || transfer.status !== 'receiving') return;

	transfer.status = 'failed';
	transfer.statusText = '已取消接收';
	transfer.volumeData = null;
	updateFileProgress(fileId);

	if (transfer.fromClientId && typeof window.ncSendFileCancel === 'function') {
		window.ncSendFileCancel(transfer.fromClientId, { type: 'file_cancel', fileId });
	}
}

// Handle file start message
// 处理文件开始消息
function handleFileStart(message, isPrivate, fromClientId) {
	const { fileId, fileName, originalSize, compressedSize, totalVolumes, originalHash, archiveHash, fileCount, fileManifest, isArchive, userName } = message;
	
	const fileTransfer = {
		fileId,
		fileName,
		originalSize,
		compressedSize,
		totalVolumes,
		receivedVolumes: new Set(),
		volumeData: new Array(totalVolumes),
		status: 'receiving',
		originalHash,
		archiveHash,
		fileCount,
		fileManifest,
		isArchive,
		userName, // 记录发送者名字
		fromClientId: fromClientId || '',
		isPrivate: !!isPrivate,
		startedAt: Date.now(),
		lastActivityAt: Date.now()
	};
	
	window.fileTransfers.set(fileId, fileTransfer);
	armReceiveSweep();
	// 收卷/解压期间主线程繁忙，心跳迟到不能触发自断连接
	deferFileWatchdog();
	
	// 添加文件消息到聊天
	if (window.addOtherMsg) {
		let displayData;
		if (isArchive) {
			displayData = {
				type: 'file',
				fileId,
				fileName: `${fileCount} files`,
				originalSize,
				totalVolumes,
				fileCount,
				isArchive: true,
				userName
			};
		} else {
			displayData = {
				type: 'file',
				fileId,
				fileName,
				originalSize,
				totalVolumes,
				userName
			};
		}
		
		window.addOtherMsg(displayData, userName, userName, false, isPrivate ? 'file_private' : 'file');
	}
}

// Handle file volume message
// 处理文件分卷消息
function handleFileVolume(message) {
	const { fileId, volumeIndex, volumeData } = message;
	const transfer = window.fileTransfers.get(fileId);
	
	if (!transfer) return;
	// 已取消/已超时/已完成：迟到的分卷直接忽略（不再占内存）
	if (transfer.status !== 'receiving') return;
	if (!transfer.volumeData) return;
	
	transfer.receivedVolumes.add(volumeIndex);
	transfer.volumeData[volumeIndex] = volumeData;
	transfer.lastActivityAt = Date.now();
	deferFileWatchdog();
	
	// file_complete 先到（乱序）时，最后一卷补齐即完成
	if (transfer.completeSeen && transfer.receivedVolumes.size === transfer.totalVolumes) {
		transfer.status = 'completed';
	}
	
	updateFileProgress(fileId);
}

// Handle file complete message
// 处理文件完成消息
function handleFileComplete(message) {
	const { fileId } = message;
	const transfer = window.fileTransfers.get(fileId);
	
	if (!transfer) return;
	if (transfer.status !== 'receiving') return;

	transfer.completeSeen = true;
	transfer.lastActivityAt = Date.now();
	deferFileWatchdog();
	
	// 检查是否所有分卷都已接收
	if (transfer.receivedVolumes.size === transfer.totalVolumes) {
		transfer.status = 'completed';
		updateFileProgress(fileId);
	}
}

// Download file from volumes
// 从分卷下载文件
export async function downloadFile(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || transfer.status !== 'completed') return;
	
	try {
		if (transfer.isArchive) {
			// Download archive as multiple files
			await decompressArchiveToFiles(transfer.volumeData, transfer.fileManifest, transfer.archiveHash);
			// 删除系统提示
		} else {
			// Download single file
			await decompressVolumesToFile(transfer.volumeData, transfer.fileName, transfer.originalHash);
			// 删除系统提示
		}
	} catch (error) {
		console.error('Download error:', error);
		window.addSystemMsg(`Failed to download: ${error.message}`);
	}
}

// Format file size
// 格式化文件大小
export function formatFileSize(bytes) {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Legacy image send function for backward compatibility
// 向后兼容的图片发送函数
export function setupImageSend(config) {
	setupFileSend(config);
}