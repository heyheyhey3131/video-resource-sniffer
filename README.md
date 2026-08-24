# 视频资源嗅探与下载 (Video Resource Sniffer)

> 拟定仓库名：**`video-resource-sniffer`**  
> 建议完整地址：`https://github.com/heyheyhey3131/video-resource-sniffer`（请将 `heyheyhey3131` 替换为你的 GitHub 用户名，创建同名仓库后按下方推送指引操作即可）

油猴脚本：在任意网页以悬浮按钮嗅探 `MP4/WebM/MOV`、`HLS(m3u8)`、`DASH(mpd)` 及内联 `JSON-LD` 中的视频资源，支持一键下载、复制链接/FFmpeg 命令、清单解析与 Via 移动端适配。

## 特性

- **全链路嗅探**：`fetch`/`XHR` Hook、`PerformanceObserver`、`MutationObserver`、媒体标签与 `og:video` 元信息，覆盖 51cwc/4kvms/imoviebot 等站点
- **HLS 增强**：主清单→变体/音轨自动展开、`EXT-X-MAP/BYTERANGE`、AES-128 (`IV` 缺省时以 `seq` 大端) 经 `WebCrypto` 解密、PNG/GIF/JPG 伪装剥离（`IEND/3B` 后首个 `0x47` 且 `+188` 仍 `0x47`）、`VOD` 无 `ENDLIST` 误判为直播的修复
- **DASH 增强**：`BaseURL` 非目录过滤、`Representation` 带宽/分辨率聚合
- **下载与播放**：
  - **Via/移动端 0.0B 根治**：彻底解决 Via 原生下载器接管 `blob:` 协议导致的 0.0B 空任务与卡 0 问题；
  - **内置在线播放**：合并后或直链媒体支持一键在页面悬浮播放器中秒开预览，零缓冲、全进度拖动；
  - **外部下载器唤起**：一键调用 1DM、ADM 及 Android 系统播放器 Intent；
  - **多协议命令复制**：支持一键复制 `FFmpeg`、`N_m3u8DL-RE` 下载命令及原始媒体直链。
- **交互**：可拖拽四档吸附（`left-offset/left-edge/right-offset/right-edge`）、全屏弹窗、`清空` 后 `重扫` 秒级恢复（`hlsManifestCache` 50条 LRU + 4s 轮询 `requestManifest`）
- **分类优化**：`febspot.com` 的 `preview_720p.mp4.jpg` 等 `IMAGE_EXTENSIONS` 误判为 `视频` 已修复，现显示 `图片` 且排序置底（`video/audio > 可下载HLS > HLS > DASH > 图片`）

## 安装

1. 浏览器安装 Tampermonkey / Violentmonkey / Via 内置脚本管理器
2. 访问 Raw 链接安装：`https://raw.githubusercontent.com/heyheyhey3131/video-resource-sniffer/main/视频资源嗅探下载.user.js`
3. Via：脚本列表 → 右上角 `⋮` → `自动更新` 勾选后，每日按 `updateURL` 检查

## 自动更新

脚本头已内置：

```js
// @updateURL   https://raw.githubusercontent.com/heyheyhey3131/video-resource-sniffer/main/视频资源嗅探下载.user.js
// @downloadURL https://raw.githubusercontent.com/heyheyhey3131/video-resource-sniffer/main/视频资源嗅探下载.user.js
// @homepage    https://github.com/heyheyhey3131/video-resource-sniffer
```

Via 开启自动更新后无需手动操作；Tampermonkey 默认检查间隔为 1 天。

## 使用

- 悬浮按钮显示数量徽标，点击打开面板
- `下载视频`（可解密 HLS）/ `保存视频` / `在线播放` / `外部下载` / `复制 FFmpeg` / `复制 N_m3u8DL` / `解析清单` / `打开` / `复制链接`
- 失败时查看 `downloadMessage`，`DRM/SAMPLE-AES` 提示改用 FFmpeg

## 版本

- `1.2.0` - 修复 Via 浏览器“保存视频”弹出 0.0B 且进度卡 0 问题；新增内置“在线播放”弹窗；新增 1DM/ADM 外部下载器调用与 N_m3u8DL-RE 命令复制
- `1.1.0` - 大文件 OPFS 流式落盘，突破 512MB 限制
- `1.0.0` - 首发：对齐 APK 的 ExoPlayer 能力（AES-128、TS 剥壳、VOD 判定）、4kvms/51cwc 跨域与重扫修复、febspot 图片分类

## 许可

MIT © OpenCode

