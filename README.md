# 视频资源嗅探与下载 (Video Resource Sniffer)

> 拟定仓库名：**`video-resource-sniffer`**  
> 建议完整地址：`https://github.com/heyheyhey3131/video-resource-sniffer`（请将 `heyheyhey3131` 替换为你的 GitHub 用户名，创建同名仓库后按下方推送指引操作即可）

油猴脚本：在任意网页以悬浮按钮嗅探 `MP4/WebM/MOV`、`HLS(m3u8)`、`DASH(mpd)` 及内联 `JSON-LD` 中的视频资源，支持一键下载、复制链接/FFmpeg 命令、清单解析与 Via 移动端适配。

## 特性

- **全链路嗅探**：`fetch`/`XHR` Hook、`PerformanceObserver`、`MutationObserver`、媒体标签与 `og:video` 元信息，覆盖 51cwc/4kvms/imoviebot 等站点
- **HLS 增强**：主清单→变体/音轨自动展开、`EXT-X-MAP/BYTERANGE`、AES-128 (`IV` 缺省时以 `seq` 大端) 经 `WebCrypto` 解密、PNG/GIF/JPG 伪装剥离（`IEND/3B` 后首个 `0x47` 且 `+188` 仍 `0x47`）、`VOD` 无 `ENDLIST` 误判为直播的修复
- **DASH 增强**：`BaseURL` 非目录过滤、`Representation` 带宽/分辨率聚合
- **下载健壮性**：`showSaveFilePicker` → `GM_download(blobUrl)` → 锚点 `a[download]` 三级回退；`Via/Quark/UC/QQ/Miui` 直接走锚点避免 0.0B；`GM_xmlhttpRequest` 失败回退 `fetch{omit}` 解决 `oss.douyinbit.com/v2.ppqrrs.com` 的 `CORS * + credentials` 阻断
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
- `下载视频`（可解密 HLS）/ `下载清单` / `复制 FFmpeg`（`ffmpeg -referer "URL" -i "m3u8" -c copy out.mp4`）/ `解析清单` / `打开` / `复制链接`
- 失败时查看 `downloadMessage`，`DRM/SAMPLE-AES` 提示改用 FFmpeg

## 推送到你的 GitHub（首次）

```bash
# 在 D:\FileFolder\MuMuShared\UURemote 下
git init
git add "视频资源嗅探下载.user.js" README.md LICENSE
git commit -m "feat: v1.0.0 - HLS AES-128/PNG-GIF剥离/Via适配/febspot图片分类"
git branch -M main
git remote add origin https://github.com/heyheyhey3131/video-resource-sniffer.git
git push -u origin main
# 发布 Release
gh release create v1.0.0 --title "v1.0.0" --notes "首个稳定版，见 README" "视频资源嗅探下载.user.js"
# 或在 GitHub 网页：Releases → Draft a new release → Tag v1.0.0
```

将 `heyheyhey3131` 替换为你的用户名，仓库名保持 `video-resource-sniffer` 即可与脚本内 `namespace/updateURL` 一致。

## 版本

- `1.0.0` - 首发：对齐 APK 的 ExoPlayer 能力（AES-128、TS 剥壳、VOD 判定）、4kvms/51cwc 跨域与重扫修复、febspot 图片分类、Via 0.0B 修复

## 许可

MIT © OpenCode
