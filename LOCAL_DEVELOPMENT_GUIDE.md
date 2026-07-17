# NodeCrypt 本地开发运行指南

本文档详细说明了如何在本地环境中运行 NodeCrypt 项目的前端和后端服务。

## 项目结构概览

```
NodeCrypt/
├── client/          # 前端代码
├── server/          # 后端服务器代码
├── worker/          # Cloudflare Workers 代码
├── dist/            # 前端构建输出目录
├── package.json     # 前端项目配置和依赖
├── vite.config.js   # 前端构建配置
├── wrangler.toml    # Cloudflare Workers 配置
├── Dockerfile       # Docker 部署配置
└── server/
    ├── package.json # 后端依赖配置
    └── server.js    # 后端服务器入口文件
```

## 环境要求

- Node.js 16+ (推荐使用 LTS 版本)
- npm 7+ 或 yarn
- 现代浏览器 (Chrome, Firefox, Edge等)
## 项目构建

### dist目录的作用

`dist` 目录是前端项目的构建输出目录，包含了经过压缩、优化和打包后的生产环境代码。当您需要部署项目到生产环境或进行离线使用时，需要生成这个目录。

### 如何构建项目

要正确构建项目并生成 `dist` 目录，请执行以下步骤：

```bash
# 确保在项目根目录下
npm run build
```

构建完成后，您会在项目根目录下看到 `dist` 目录，其中包含了所有用于生产环境的文件。

### 解决"dist目录不存在"错误

如果您遇到"dist目录不存在"的错误，请尝试以下解决方法：

1. **确保已执行构建命令**
   ```bash
   npm run build
   ```

2. **检查构建是否成功完成**
   确认终端中没有报错信息，并且显示构建成功的消息。

3. **手动创建dist目录（如果需要）**
   ```bash
   mkdir dist
   ```

4. **清理缓存并重新构建**
   ```bash
   # 清理构建缓存
   npm run clean
   
   # 重新构建项目
   npm run build
   ```

5. **检查文件权限**
   确保您有权限在项目目录中创建文件和文件夹。

## 本地运行步骤

### 1. 安装依赖

首先安装前端和后端的依赖包：

```bash
# 安装前端依赖
npm install

# 安装后端依赖
cd server
npm install
cd ..
```
### 2. 构建前端项目（可选，用于生产环境）

如果需要构建项目用于生产环境，请执行以下步骤：

```bash
# 构建生产版本
npm run build
```

构建后的文件会输出到 `dist/` 目录。如果要部署到生产环境，请确保此步骤成功完成。

### 3. 运行后端服务器

### 2. 运行后端服务器

NodeCrypt 使用 WebSocket 服务器进行实时通信。需要先启动后端服务：

```bash
# 进入 server 目录并启动服务器
cd server
node server.js
```

默认情况下，服务器会在 `127.0.0.1:8088` 上监听。

### 3. 运行前端开发服务器

在另一个终端窗口中，启动前端开发服务器：

```bash
# 返回项目根目录
cd ..

# 启动 Vite 开发服务器
npm run dev
```

Vite 会自动打开浏览器并访问 `http://localhost:5173`。

### 4. 访问应用

打开浏览器访问 `http://localhost:5173`，你应该能看到 NodeCrypt 应用界面。

## 开发工作流

### 前端开发

- 前端代码位于 `client/` 目录
- 使用 Vite 进行热重载开发
- 修改代码后浏览器会自动刷新

### 后端开发

- 后端代码位于 `server/server.js`
- 修改后需要重启服务器才能生效
- 服务器使用 WebSocket 进行实时通信

## 构建和部署

### 构建前端

```bash
# 构建生产版本
npm run build
```

构建后的文件会输出到 `dist/` 目录。

### 部署选项

NodeCrypt 支持多种部署方式：

1. **Cloudflare Workers** (推荐)
2. **Docker 容器**
3. **传统服务器部署**

详细部署说明请参考 README.md 文件。

## 常见问题和解决方案

### 1. 端口冲突

如果 8088 端口被占用，可以修改 `server/server.js` 中的配置：

```javascript
const config = {
  wsHost: '127.0.0.1',
  wsPort: 8088,  // 修改为其他端口
  // ...
};
```

### 2. WebSocket 连接失败

确保后端服务器正在运行，并且前端配置的 WebSocket 地址正确。检查浏览器开发者工具中的网络面板，确认 WebSocket 连接状态。

### 3. 依赖安装问题

如果遇到依赖安装问题，可以尝试：

```bash
# 清理缓存并重新安装
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

## 调试技巧

1. 使用浏览器开发者工具查看网络请求和 WebSocket 通信
2. 在 `server/server.js` 中启用调试日志：
   ```javascript
   const config = {
     debug: true  // 启用调试日志
   };
   ```
3. 使用 `console.log` 在关键位置添加调试信息

## 安全注意事项

1. 本地开发环境仅用于开发和测试
2. 不要在生产环境中使用默认配置
3. 确保房间密码足够复杂以保证安全性