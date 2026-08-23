// ==UserScript==
// @name         视频资源嗅探与下载
// @namespace    https://github.com/heyheyhey3131/video-resource-sniffer
// @version      1.0.4
// @description  从网页、网络请求和流媒体清单中识别视频资源，并通过悬浮按钮提供下载、复制和 FFmpeg 选项。支持 HLS/DASH/MP4、AES-128 解密、PNG/GIF 伪装剥离、Via 移动端适配。
// @author       OpenCode
// @license      MIT
// @homepage     https://github.com/heyheyhey3131/video-resource-sniffer
// @supportURL   https://github.com/heyheyhey3131/video-resource-sniffer/issues
// @updateURL    https://raw.githubusercontent.com/heyheyhey3131/video-resource-sniffer/main/视频资源嗅探下载.user.js
// @downloadURL  https://raw.githubusercontent.com/heyheyhey3131/video-resource-sniffer/main/视频资源嗅探下载.user.js
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// ==/UserScript==
// @repo        https://github.com/heyheyhey3131/video-resource-sniffer  - 启用 Via「自动更新」后将按 updateURL 每日检查更新

(() => {
    'use strict';

    const INSTANCE_KEY = '__video_resource_sniffer_v1__';
    const MESSAGE_KEY = '__video_resource_sniffer_message_v1__';
    const MAX_RESOURCES = 250;
    const MAX_SCAN_BYTES = 2 * 1024 * 1024;
    const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
    const MAX_MEMORY_DOWNLOAD_BYTES = 512 * 1024 * 1024;
    const FAB_POSITION_KEY = 'videoResourceSnifferFabPosition';
    const IS_TOP_FRAME = window.top === window.self;

    if (window[INSTANCE_KEY]) return;
    Object.defineProperty(window, INSTANCE_KEY, { value: true });

    const resources = new Map();
    const scannedScripts = new WeakSet();
    const seenPerformanceUrls = new Set();
    const knownHlsSegmentUrls = new Set();
    const manifestRequests = new Map();
    const hlsDownloadTasks = new Map();
    const hlsAesKeyCache = new Map();
    const hlsManifestCache = new Map();
    let ui = null;
    let renderTimer = 0;
    let announceTimer = 0;
    let unannouncedCount = 0;
    let blobMediaSeen = false;

    const MEDIA_EXTENSIONS = new Set([
        'mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'ogv', '3gp', '3g2',
        'mpeg', 'mpg', 'vob', 'wmv', 'asf', 'm2ts', 'mts', 'mxf'
    ]);
    const AUDIO_EXTENSIONS = new Set([
        'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'weba'
    ]);
    const IMAGE_EXTENSIONS = new Set([
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'
    ]);
    const SEGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'part', 'key']);

    const KIND_LABELS = {
        video: '视频',
        audio: '音频',
        hls: 'HLS',
        dash: 'DASH',
        image: '图片'
    };

    installMessageBridge();
    installNetworkHooks();
    installPerformanceObserver();
    installDomObserver();
    installMediaEventListeners();

    if (IS_TOP_FRAME) {
        whenDocumentReady(createUi);
        registerMenuCommands();
        window.addEventListener('pagehide', () => {
            for (const item of resources.values()) releasePreparedDownload(item);
        }, { once: true });
    }

    function currentPageInfo() {
        return {
            pageUrl: location.href,
            pageTitle: document.title || location.hostname
        };
    }

    function installMessageBridge() {
        if (!IS_TOP_FRAME) return;

        window.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || data.key !== MESSAGE_KEY || data.type !== 'resource') return;
            if (!data.resource || typeof data.resource.url !== 'string') return;

            upsertResource({
                ...data.resource,
                source: data.resource.source || 'iframe',
                fromFrame: true
            });
        });
    }

    function postResourceToTop(item) {
        const safeItem = {
            url: item.url,
            kind: item.kind,
            mime: item.mime,
            size: item.size,
            duration: item.duration,
            quality: item.quality,
            bandwidth: item.bandwidth,
            codecs: item.codecs,
            filename: item.filename,
            source: item.source,
            pageUrl: item.pageUrl,
            pageTitle: item.pageTitle,
            referrer: item.referrer,
            parentUrl: item.parentUrl,
            segmentCount: item.segmentCount,
            representationCount: item.representationCount,
            encrypted: item.encrypted,
            drm: item.drm,
            live: item.live,
            hlsAesKeyUri: item.hlsAesKeyUri,
            hlsAesIv: item.hlsAesIv,
            hlsAesMethod: item.hlsAesMethod,
            hlsMediaSequence: item.hlsMediaSequence
        };

        try {
            window.top.postMessage({ key: MESSAGE_KEY, type: 'resource', resource: safeItem }, '*');
        } catch (error) {
            console.debug('[视频嗅探] 无法向顶层页面发送资源', error);
        }
    }

    function normalizeUrl(value, baseUrl = location.href) {
        if (typeof value !== 'string') return '';

        let text = value.trim();
        if (!text || text.length > 8192) return '';

        text = text
            .replace(/&amp;/gi, '&')
            .replace(/\\u002f/gi, '/')
            .replace(/\\u003a/gi, ':')
            .replace(/\\\//g, '/');

        if (/^https?%3a%2f%2f/i.test(text)) {
            try {
                text = decodeURIComponent(text);
            } catch (_) {
                // Keep the original value when percent-decoding is incomplete.
            }
        }

        try {
            const url = new URL(text, baseUrl);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
            url.hash = '';
            return url.href;
        } catch (_) {
            return '';
        }
    }

    function extensionFromUrl(url) {
        try {
            const parsed = new URL(url);
            const pathMatch = parsed.pathname.toLowerCase().match(/\.([a-z0-9]{2,6})$/);
            if (pathMatch) return pathMatch[1];

            for (const value of parsed.searchParams.values()) {
                const queryMatch = value.toLowerCase().match(/\.([a-z0-9]{2,6})(?:$|[?#])/);
                if (queryMatch) return queryMatch[1];
            }
        } catch (_) {
            // Invalid URLs have already been filtered by normalizeUrl.
        }
        return '';
    }

    function classifyResource(url, mime = '', kindHint = '') {
        const safeHint = ['video', 'audio', 'hls', 'dash'].includes(kindHint) ? kindHint : '';
        const lowerMime = String(mime).split(';', 1)[0].trim().toLowerCase();
        const extension = extensionFromUrl(url);
        const lowerUrl = url.toLowerCase();

        if (extension === 'm3u8' || /\.m3u8(?:$|[?#])/i.test(lowerUrl) || /mpegurl/i.test(lowerMime)) return 'hls';
        if (extension === 'mpd' || /\.mpd(?:$|[?#])/i.test(lowerUrl) || lowerMime === 'application/dash+xml') return 'dash';
        // 图片伪装：如 preview_720p.mp4.jpg，扩展名为 jpg 但 URL 含 .mp4，需优先判为图片
        if (IMAGE_EXTENSIONS.has(extension)) return 'image';
        if (lowerMime.startsWith('image/')) return 'image';
        if (safeHint === 'hls' || safeHint === 'dash') return safeHint;
        if (lowerMime.startsWith('video/')) return 'video';
        if (lowerMime.startsWith('audio/')) return 'audio';
        if (MEDIA_EXTENSIONS.has(extension)) return 'video';
        if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
        return safeHint;
    }

    function isDrmEndpoint(url) {
        try {
            const parsed = new URL(url);
            return /(?:^|[\/_?&.-])(widevine|playready|fairplay|drm|license|licence)(?:$|[\/_?&=.-])/i.test(
                `${parsed.hostname}${parsed.pathname}${parsed.search}`
            );
        } catch (_) {
            return false;
        }
    }

    function isMediaSegment(url, kind) {
        if (kind === 'hls' || kind === 'dash') return false;
        return knownHlsSegmentUrls.has(url) || SEGMENT_EXTENSIONS.has(extensionFromUrl(url));
    }

    function rememberHlsSegment(value, baseUrl) {
        const url = normalizeUrl(value, baseUrl);
        if (!url) return;
        if (knownHlsSegmentUrls.size >= 10000) knownHlsSegmentUrls.delete(knownHlsSegmentUrls.values().next().value);
        knownHlsSegmentUrls.add(url);
        if (resources.has(url)) resources.delete(url);
    }

    function upsertResource(raw) {
        const page = currentPageInfo();
        const pageUrl = normalizeUrl(raw.pageUrl || page.pageUrl, page.pageUrl) || page.pageUrl;
        const url = normalizeUrl(raw.url, raw.baseUrl || pageUrl);
        if (!url || isDrmEndpoint(url)) return null;

        const kind = classifyResource(url, raw.mime, raw.kind);
        if (!kind || isMediaSegment(url, kind)) return null;

        const key = url;
        const existing = resources.get(key);
        const now = Date.now();
        const source = cleanShortText(raw.source || '网页', 40);
        const next = existing || {
            id: createResourceId(url),
            url,
            kind,
            mime: '',
            size: 0,
            duration: 0,
            quality: '',
            bandwidth: 0,
            codecs: '',
            filename: '',
            source,
            sources: new Set(),
            pageUrl,
            pageTitle: cleanShortText(raw.pageTitle || page.pageTitle, 160),
            referrer: normalizeUrl(raw.referrer || pageUrl, pageUrl) || pageUrl,
            parentUrl: '',
            segmentCount: 0,
            representationCount: 0,
            encrypted: false,
            drm: false,
            live: false,
            manifestText: '',
            hlsAesKeyUri: '',
            hlsAesIv: '',
            hlsAesMethod: '',
            hlsMediaSequence: 0,
            probeState: '',
            probeError: '',
            downloadState: '',
            downloadProgress: 0,
            downloadBytes: 0,
            mediaSize: 0,
            downloadMessage: '',
            readyDownloadUrl: '',
            readyDownloadName: '',
            discoveredAt: now,
            updatedAt: now
        };

        let changed = !existing;
        changed = assignIfUseful(next, 'kind', kind) || changed;
        changed = assignIfUseful(next, 'mime', normalizeMime(raw.mime)) || changed;
        changed = assignNumberIfLarger(next, 'size', raw.size) || changed;
        changed = assignNumberIfLarger(next, 'duration', raw.duration) || changed;
        changed = assignIfUseful(next, 'quality', cleanShortText(raw.quality, 40)) || changed;
        changed = assignNumberIfLarger(next, 'bandwidth', raw.bandwidth) || changed;
        changed = assignIfUseful(next, 'codecs', cleanShortText(raw.codecs, 120)) || changed;
        changed = assignIfUseful(next, 'filename', sanitizeFilename(raw.filename || '', '')) || changed;
        changed = assignIfUseful(next, 'parentUrl', normalizeUrl(raw.parentUrl, pageUrl)) || changed;
        changed = assignNumberIfLarger(next, 'segmentCount', raw.segmentCount) || changed;
        changed = assignNumberIfLarger(next, 'representationCount', raw.representationCount) || changed;

        if (raw.pageTitle && !next.pageTitle) {
            next.pageTitle = cleanShortText(raw.pageTitle, 160);
            changed = true;
        }
        if (raw.encrypted && !next.encrypted) {
            next.encrypted = true;
            changed = true;
        }
        if (raw.drm && !next.drm) {
            next.drm = true;
            changed = true;
        }
        if (raw.live && !next.live) {
            next.live = true;
            changed = true;
        }
        if (raw.hlsAesKeyUri && !next.hlsAesKeyUri) {
            next.hlsAesKeyUri = normalizeUrl(raw.hlsAesKeyUri, pageUrl) || raw.hlsAesKeyUri;
            changed = true;
        }
        if (raw.hlsAesIv && !next.hlsAesIv) {
            next.hlsAesIv = raw.hlsAesIv;
            changed = true;
        }
        if (raw.hlsAesMethod && !next.hlsAesMethod) {
            next.hlsAesMethod = raw.hlsAesMethod;
            changed = true;
        }
        if (Number.isFinite(Number(raw.hlsMediaSequence)) && Number(raw.hlsMediaSequence) >= 0 && !next.hlsMediaSequence) {
            next.hlsMediaSequence = Number(raw.hlsMediaSequence);
            changed = true;
        }
        if (raw.manifestText && raw.manifestText.length <= MAX_MANIFEST_BYTES && raw.manifestText !== next.manifestText) {
            next.manifestText = raw.manifestText;
            changed = true;
        }

        // 命中本地清单缓存：用于“清空后重扫”秒级恢复可播放状态，无需等待网络重拉
        if (next.kind === 'hls' && !next.manifestText && hlsManifestCache.has(next.url)) {
            const cached = hlsManifestCache.get(next.url);
            next.manifestText = cached.text;
            next.segmentCount = Math.max(next.segmentCount || 0, cached.segmentCount || 0);
            next.duration = Math.max(next.duration || 0, cached.duration || 0);
            next.encrypted = next.encrypted || cached.encrypted;
            next.drm = next.drm || cached.drm;
            next.live = cached.live;
            next.hlsAesKeyUri = next.hlsAesKeyUri || cached.hlsAesKeyUri;
            next.hlsAesIv = next.hlsAesIv || cached.hlsAesIv;
            next.hlsAesMethod = next.hlsAesMethod || cached.hlsAesMethod;
            next.hlsMediaSequence = next.hlsMediaSequence || cached.hlsMediaSequence;
            changed = true;
        }

        if (source && !next.sources.has(source)) {
            next.sources.add(source);
            next.source = [...next.sources].join('、');
            changed = true;
        }

        next.updatedAt = now;

        if (!existing && resources.size >= MAX_RESOURCES) {
            const oldest = [...resources.values()].sort((a, b) => a.discoveredAt - b.discoveredAt)[0];
            if (oldest) resources.delete(oldest.url);
        }
        resources.set(key, next);

        if (!IS_TOP_FRAME && changed) postResourceToTop(next);
        if (IS_TOP_FRAME && changed) scheduleRender(!existing);

        if (raw.manifestText) {
            parseManifestText(next, raw.manifestText);
        }

        return next;
    }

    function assignIfUseful(target, key, value) {
        if (!value || target[key] === value) return false;
        target[key] = value;
        return true;
    }

    function assignNumberIfLarger(target, key, value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0 || number <= Number(target[key] || 0)) return false;
        target[key] = number;
        return true;
    }

    function normalizeMime(value) {
        return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
    }

    function cleanShortText(value, maxLength) {
        return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength) : '';
    }

    function createResourceId(url) {
        let hash = 2166136261;
        for (let index = 0; index < url.length; index += 1) {
            hash ^= url.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `vrd-${(hash >>> 0).toString(36)}`;
    }

    function inspectResponse(details) {
        const page = currentPageInfo();
        const url = normalizeUrl(details.url, details.baseUrl || page.pageUrl);
        if (!url) return;

        const kind = classifyResource(url, details.mime, details.kind);
        let item = null;
        if (kind) {
            item = upsertResource({
                ...details,
                url,
                kind,
                pageUrl: details.pageUrl || page.pageUrl,
                pageTitle: details.pageTitle || page.pageTitle,
                referrer: details.referrer || page.pageUrl,
                filename: details.filename || filenameFromContentDisposition(details.contentDisposition)
            });
        }

        if (typeof details.body !== 'string' || !details.body) return;
        const body = details.body.slice(0, MAX_MANIFEST_BYTES);

        if (kind === 'hls' || body.trimStart().startsWith('#EXTM3U')) {
            item = item || upsertResource({ ...details, url, kind: 'hls' });
            if (item) parseHlsManifest(item, body);
            return;
        }

        if (kind === 'dash' || /<MPD[\s>]/i.test(body.slice(0, 4096))) {
            item = item || upsertResource({ ...details, url, kind: 'dash' });
            if (item) parseDashManifest(item, body);
            return;
        }

        if (shouldScanTextBody(details.mime, url)) {
            extractMediaUrls(body.slice(0, MAX_SCAN_BYTES), url, {
                source: `${details.source || '网络响应'}内链接`,
                pageUrl: details.pageUrl || page.pageUrl,
                pageTitle: details.pageTitle || page.pageTitle,
                referrer: details.referrer || page.pageUrl
            });
        }
    }

    function shouldScanTextBody(mime, url) {
        const normalized = normalizeMime(mime);
        return /(?:json|javascript|text\/|xml)/i.test(normalized) || /\.(?:json|js)(?:$|[?#])/i.test(url);
    }

    function extractMediaUrls(text, baseUrl, meta = {}) {
        if (typeof text !== 'string' || !text) return;

        const normalized = text
            .slice(0, MAX_SCAN_BYTES)
            .replace(/&amp;/gi, '&')
            .replace(/\\u002f/gi, '/')
            .replace(/\\u003a/gi, ':')
            .replace(/\\\//g, '/');
        const found = new Set();

        collectMatches(normalized, /https?:\/\/[^\s"'<>\\\[\]{}]+/gi, found, (match) => match[0]);
        collectMatches(normalized, /(?:"|')((?:\/\/|\/|\.\.\/|\.\/)[^"'\s]{1,2048}\.(?:m3u8|mpd|mp4|webm|mov|m4v|mkv|avi|flv|ogv|m4a|mp3|aac)(?:\?[^"']*)?)(?:"|')/gi, found, (match) => match[1]);
        collectMatches(normalized, /https?%3a%2f%2f[^\s"'<>]+/gi, found, (match) => {
            try {
                return decodeURIComponent(match[0]);
            } catch (_) {
                return '';
            }
        });

        let count = 0;
        for (const candidate of found) {
            if (count >= 100) break;
            const url = normalizeUrl(candidate.replace(/[),;]+$/, ''), baseUrl);
            if (!url) continue;
            const item = upsertResource({ ...meta, url, baseUrl });
            if (item) count += 1;
        }
    }

    function collectMatches(text, pattern, target, mapper) {
        let match;
        while (target.size < 500 && (match = pattern.exec(text))) {
            const value = mapper(match);
            if (value) target.add(value);
        }
    }

    function installNetworkHooks() {
        const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;
        installFetchHook(pageWindow);
        installXhrHook(pageWindow);
    }

    function installFetchHook(pageWindow) {
        try {
            const originalFetch = pageWindow.fetch;
            if (typeof originalFetch !== 'function' || originalFetch[INSTANCE_KEY]) return;

            function wrappedFetch(input, init) {
                const requestedUrl = typeof input === 'string' || input instanceof URL
                    ? String(input)
                    : input && typeof input.url === 'string' ? input.url : '';
                const requestReferrer = init && init.referrer
                    ? String(init.referrer)
                    : input && typeof input.referrer === 'string' ? input.referrer : location.href;
                const result = Reflect.apply(originalFetch, this, arguments);

                return Promise.resolve(result).then((response) => {
                    inspectFetchResponse(response, requestedUrl, requestReferrer);
                    return response;
                });
            }

            Object.defineProperty(wrappedFetch, INSTANCE_KEY, { value: true });
            try {
                Object.defineProperty(wrappedFetch, 'name', { value: 'fetch' });
                Object.defineProperty(wrappedFetch, 'toString', { value: originalFetch.toString.bind(originalFetch) });
            } catch (_) {
                // Function metadata is cosmetic and may be non-configurable.
            }
            pageWindow.fetch = wrappedFetch;
        } catch (error) {
            console.debug('[视频嗅探] Fetch 监听安装失败', error);
        }
    }

    function inspectFetchResponse(response, requestedUrl, requestReferrer) {
        try {
            if (!response) return;
            const url = response.url || requestedUrl;
            const mime = response.headers && response.headers.get ? response.headers.get('content-type') || '' : '';
            const length = response.headers && response.headers.get ? Number(response.headers.get('content-length')) || 0 : 0;
            const contentDisposition = response.headers && response.headers.get ? response.headers.get('content-disposition') || '' : '';
            const kind = classifyResource(normalizeUrl(url, location.href), mime);

            inspectResponse({
                url,
                mime,
                size: length,
                contentDisposition,
                source: 'Fetch',
                referrer: normalizeUrl(requestReferrer, location.href) || location.href,
                ...currentPageInfo()
            });

            const shouldRead = kind === 'hls' || kind === 'dash' || shouldScanTextBody(mime, url);
            const sizeLimit = kind === 'hls' || kind === 'dash' ? MAX_MANIFEST_BYTES : MAX_SCAN_BYTES;
            if (!shouldRead || (length && length > sizeLimit)) return;

            readResponseTextLimited(response, sizeLimit).then((body) => {
                if (!body) return;
                inspectResponse({
                    url,
                    mime,
                    size: length,
                    contentDisposition,
                    body,
                    source: 'Fetch',
                    referrer: normalizeUrl(requestReferrer, location.href) || location.href,
                    ...currentPageInfo()
                });
            }).catch(() => {});
        } catch (_) {
            // Opaque and cross-realm Response objects may deny access to fields.
        }
    }

    async function readResponseTextLimited(response, limit) {
        const clone = response.clone();
        if (!clone.body || typeof clone.body.getReader !== 'function') {
            const text = await clone.text();
            return text.length <= limit ? text : text.slice(0, limit);
        }

        const reader = clone.body.getReader();
        const decoder = new TextDecoder();
        let total = 0;
        let output = '';

        while (total < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            output += decoder.decode(value, { stream: true });
            if (total >= limit) {
                await reader.cancel().catch(() => {});
                break;
            }
        }
        output += decoder.decode();
        return output.slice(0, limit);
    }

    function installXhrHook(pageWindow) {
        try {
            const Xhr = pageWindow.XMLHttpRequest;
            if (!Xhr || !Xhr.prototype || Xhr.prototype[INSTANCE_KEY]) return;

            const originalOpen = Xhr.prototype.open;
            const originalSend = Xhr.prototype.send;
            const urlKey = Symbol('videoSnifferUrl');
            const listeningKey = Symbol('videoSnifferListening');
            const listenerKey = Symbol('videoSnifferReadyStateListener');

            Xhr.prototype.open = function wrappedOpen(method, url) {
                try {
                    if (this[listenerKey]) {
                        if (this.readyState === 4) inspectXhr(this, this[urlKey]);
                        this.removeEventListener('readystatechange', this[listenerKey], true);
                        this[listenerKey] = null;
                        this[listeningKey] = false;
                    }
                    this[urlKey] = String(url || '');
                } catch (_) {
                    // Some host objects reject expandos.
                }
                return Reflect.apply(originalOpen, this, arguments);
            };

            Xhr.prototype.send = function wrappedSend() {
                if (!this[listeningKey]) {
                    this[listeningKey] = true;
                    const inspectAtDone = () => {
                        if (this.readyState !== 4) return;
                        this.removeEventListener('readystatechange', inspectAtDone, true);
                        this[listenerKey] = null;
                        this[listeningKey] = false;
                        inspectXhr(this, this[urlKey]);
                    };
                    this[listenerKey] = inspectAtDone;
                    this.addEventListener('readystatechange', inspectAtDone, true);
                }
                try {
                    return Reflect.apply(originalSend, this, arguments);
                } catch (error) {
                    if (this[listenerKey]) this.removeEventListener('readystatechange', this[listenerKey], true);
                    this[listenerKey] = null;
                    this[listeningKey] = false;
                    throw error;
                }
            };

            Object.defineProperty(Xhr.prototype, INSTANCE_KEY, { value: true });
        } catch (error) {
            console.debug('[视频嗅探] XHR 监听安装失败', error);
        }
    }

    function inspectXhr(xhr, requestedUrl) {
        try {
            const url = xhr.responseURL || requestedUrl;
            const mime = xhr.getResponseHeader('content-type') || '';
            const size = Number(xhr.getResponseHeader('content-length')) || 0;
            const contentDisposition = xhr.getResponseHeader('content-disposition') || '';
            const kind = classifyResource(normalizeUrl(url, location.href), mime);
            let body = '';

            if (kind === 'hls' || kind === 'dash' || shouldScanTextBody(mime, url)) {
                if (xhr.responseType === '' || xhr.responseType === 'text') {
                    body = typeof xhr.responseText === 'string' ? xhr.responseText.slice(0, kind ? MAX_MANIFEST_BYTES : MAX_SCAN_BYTES) : '';
                } else if (xhr.responseType === 'arraybuffer' && xhr.response instanceof ArrayBuffer && xhr.response.byteLength <= MAX_MANIFEST_BYTES) {
                    body = new TextDecoder().decode(xhr.response);
                }
            }

            inspectResponse({
                url,
                mime,
                size,
                contentDisposition,
                body,
                source: 'XHR',
                referrer: location.href,
                ...currentPageInfo()
            });
        } catch (error) {
            console.debug('[视频嗅探] XHR 响应检查失败', error);
        }
    }

    function installPerformanceObserver() {
        const inspectEntry = (entry) => {
            if (!entry || typeof entry.name !== 'string' || seenPerformanceUrls.has(entry.name)) return;
            seenPerformanceUrls.add(entry.name);

            const url = normalizeUrl(entry.name, location.href);
            const kindHint = entry.initiatorType === 'video' ? 'video' : entry.initiatorType === 'audio' ? 'audio' : '';
            const kind = url ? classifyResource(url, '', kindHint) : '';
            if (!kind) return;

            upsertResource({
                url,
                kind,
                size: Number(entry.encodedBodySize || entry.transferSize) || 0,
                source: `Performance/${entry.initiatorType || 'resource'}`,
                referrer: location.href,
                ...currentPageInfo()
            });
        };

        try {
            performance.getEntriesByType('resource').forEach(inspectEntry);
            const observer = new PerformanceObserver((list) => list.getEntries().forEach(inspectEntry));
            try {
                observer.observe({ type: 'resource', buffered: true });
            } catch (_) {
                observer.observe({ entryTypes: ['resource'] });
            }
        } catch (error) {
            console.debug('[视频嗅探] PerformanceObserver 不可用', error);
        }
    }

    function installDomObserver() {
        const start = () => {
            scanDocument();
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.type === 'attributes') scanElement(mutation.target);
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) scanElement(node);
                    }
                }
            });
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'href', 'content', 'data-src', 'data-url', 'data-video-url']
            });

            window.setInterval(() => {
                scanMediaElements(document);
                performance.getEntriesByType('resource').forEach((entry) => {
                    if (!seenPerformanceUrls.has(entry.name)) {
                        const url = normalizeUrl(entry.name, location.href);
                        const kindHint = entry.initiatorType === 'video' ? 'video' : entry.initiatorType === 'audio' ? 'audio' : '';
                        const kind = url ? classifyResource(url, '', kindHint) : '';
                        if (kind) {
                            seenPerformanceUrls.add(entry.name);
                            const item = upsertResource({
                                url,
                                kind,
                                size: Number(entry.encodedBodySize || entry.transferSize) || 0,
                                source: `Performance/${entry.initiatorType || 'resource'}`,
                                ...currentPageInfo()
                            });
                            if (item && (item.kind === 'hls' || item.kind === 'dash') && !item.manifestText && !manifestRequests.has(item.url)) {
                                requestManifest(item, false);
                            }
                        }
                    }
                });
            }, 4000);
        };

        if (document.documentElement) {
            start();
        } else {
            const bootstrap = new MutationObserver(() => {
                if (!document.documentElement) return;
                bootstrap.disconnect();
                start();
            });
            bootstrap.observe(document, { childList: true });
        }
    }

    function installMediaEventListeners() {
        for (const eventName of ['loadedmetadata', 'loadeddata', 'durationchange', 'play']) {
            document.addEventListener(eventName, (event) => {
                if (event.target instanceof HTMLMediaElement) scanMediaElement(event.target);
            }, true);
        }
    }

    function scanDocument() {
        scanMediaElements(document);
        scanMetadata(document);
        scanInlineScripts(document);
        scanLinkLikeElements(document);
    }

    function scanElement(element) {
        if (!(element instanceof Element)) return;
        if (element.matches('video, audio, source')) scanMediaElement(element.closest('video, audio') || element);
        if (element.matches('meta, link, a, [data-src], [data-url], [data-video-url]')) scanLinkLikeElement(element);
        if (element.matches('script:not([src])')) scanInlineScript(element);

        scanMediaElements(element);
        scanMetadata(element);
        scanInlineScripts(element);
        scanLinkLikeElements(element);
    }

    function scanMediaElements(root) {
        if (root instanceof HTMLMediaElement) scanMediaElement(root);
        root.querySelectorAll?.('video, audio').forEach(scanMediaElement);
        root.querySelectorAll?.('source').forEach((source) => {
            if (!source.closest('video, audio')) registerDomUrl(source.src || source.getAttribute('src'), source.type, 'DOM/source');
        });
    }

    function scanMediaElement(media) {
        if (!(media instanceof HTMLMediaElement)) return;
        const kindHint = media instanceof HTMLAudioElement ? 'audio' : 'video';
        const urls = [media.currentSrc, media.src, media.getAttribute('src')];

        for (const value of urls) {
            if (typeof value === 'string' && value.startsWith('blob:')) {
                blobMediaSeen = true;
                if (IS_TOP_FRAME) scheduleRender(false);
                continue;
            }
            registerDomUrl(value, '', `DOM/${media.tagName.toLowerCase()}`, kindHint, media.duration);
        }

        media.querySelectorAll('source').forEach((source) => {
            registerDomUrl(source.src || source.getAttribute('src'), source.type, 'DOM/source', kindHint, media.duration);
        });
    }

    function scanMetadata(root) {
        root.querySelectorAll?.([
            'meta[property="og:video"]',
            'meta[property="og:video:url"]',
            'meta[property="og:video:secure_url"]',
            'meta[property="og:audio"]',
            'meta[name="twitter:player:stream"]',
            'link[rel="preload"][as="video"]',
            'link[rel="preload"][as="audio"]'
        ].join(',')).forEach(scanLinkLikeElement);
    }

    function scanLinkLikeElements(root) {
        root.querySelectorAll?.('a[href], [data-src], [data-url], [data-video-url]').forEach(scanLinkLikeElement);
    }

    function scanLinkLikeElement(element) {
        if (!(element instanceof Element)) return;
        const value = element.getAttribute('content')
            || element.getAttribute('href')
            || element.getAttribute('data-video-url')
            || element.getAttribute('data-src')
            || element.getAttribute('data-url');
        const mime = element.getAttribute('type') || '';
        registerDomUrl(value, mime, `DOM/${element.tagName.toLowerCase()}`);
    }

    function registerDomUrl(value, mime, source, kindHint = '', duration = 0) {
        const url = normalizeUrl(value, location.href);
        if (!url) return;
        upsertResource({
            url,
            mime,
            kind: classifyResource(url, mime, kindHint),
            duration: Number.isFinite(duration) ? duration : 0,
            source,
            referrer: location.href,
            ...currentPageInfo()
        });
    }

    function scanInlineScripts(root) {
        root.querySelectorAll?.('script:not([src])').forEach(scanInlineScript);
    }

    function scanInlineScript(script) {
        if (!(script instanceof HTMLScriptElement) || scannedScripts.has(script)) return;
        scannedScripts.add(script);
        const text = script.textContent || '';
        if (!text || text.length > MAX_SCAN_BYTES || !/(?:m3u8|\.mpd|\.mp4|\.webm|video\/|contentUrl)/i.test(text)) return;
        extractMediaUrls(text, location.href, {
            source: script.type === 'application/ld+json' ? 'JSON-LD' : '内联配置',
            referrer: location.href,
            ...currentPageInfo()
        });
    }

    function parseManifestText(item, text) {
        if (!item || typeof text !== 'string') return;
        if (item.kind === 'hls' || text.trimStart().startsWith('#EXTM3U')) {
            parseHlsManifest(item, text);
        } else if (item.kind === 'dash' || /<MPD[\s>]/i.test(text.slice(0, 4096))) {
            parseDashManifest(item, text);
        }
    }

    function parseHlsManifest(item, text) {
        if (!text.trimStart().startsWith('#EXTM3U')) return;
        item.kind = 'hls';
        item.mime = item.mime || 'application/vnd.apple.mpegurl';
        item.manifestText = text.slice(0, MAX_MANIFEST_BYTES);

        const lines = text.split(/\r?\n/).map((line) => line.trim());
        let segmentCount = 0;
        let duration = 0;
        let encrypted = false;
        let drm = false;
        let hasEndList = false;
        let isVod = false;
        let expectingSegmentUri = false;
        let mediaSequence = 0;
        let currentKeyUri = '';
        let currentKeyIv = '';
        let currentKeyMethod = '';

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!line) continue;

            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const attributes = parseAttributeList(line);
                const child = nextUriLine(lines, index + 1);
                if (child) {
                    upsertResource({
                        url: child,
                        baseUrl: item.url,
                        kind: 'hls',
                        mime: 'application/vnd.apple.mpegurl',
                        quality: qualityFromAttributes(attributes),
                        bandwidth: Number(attributes.BANDWIDTH || attributes['AVERAGE-BANDWIDTH']) || 0,
                        codecs: stripQuotes(attributes.CODECS || ''),
                        source: 'HLS 变体',
                        pageUrl: item.pageUrl,
                        pageTitle: item.pageTitle,
                        referrer: item.referrer,
                        parentUrl: item.url
                    });
                }
                continue;
            }

            if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:') || line.startsWith('#EXT-X-MEDIA:')) {
                const attributes = parseAttributeList(line);
                const uri = stripQuotes(attributes.URI || '');
                if (uri && (line.includes('TYPE=AUDIO') || line.startsWith('#EXT-X-I-FRAME'))) {
                    upsertResource({
                        url: uri,
                        baseUrl: item.url,
                        kind: 'hls',
                        mime: 'application/vnd.apple.mpegurl',
                        quality: line.includes('TYPE=AUDIO') ? cleanShortText(stripQuotes(attributes.NAME || attributes.LANGUAGE || '音轨'), 40) : qualityFromAttributes(attributes),
                        bandwidth: Number(attributes.BANDWIDTH) || 0,
                        source: line.includes('TYPE=AUDIO') ? 'HLS 音轨' : 'HLS I-Frame',
                        pageUrl: item.pageUrl,
                        pageTitle: item.pageTitle,
                        referrer: item.referrer,
                        parentUrl: item.url
                    });
                }
                continue;
            }

            if (line.startsWith('#EXTINF:')) {
                segmentCount += 1;
                expectingSegmentUri = true;
                const seconds = Number.parseFloat(line.slice(8).split(',', 1)[0]);
                if (Number.isFinite(seconds)) duration += seconds;
                continue;
            }

            if (line.startsWith('#EXT-X-MAP:')) {
                const attributes = parseAttributeList(line);
                rememberHlsSegment(stripQuotes(attributes.URI || ''), item.url);
                continue;
            }

            if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
                const attributes = parseAttributeList(line);
                const method = String(attributes.METHOD || '').toUpperCase();
                const keyFormat = stripQuotes(attributes.KEYFORMAT || '').toLowerCase();
                const keyEncrypted = Boolean(method && method !== 'NONE');
                encrypted = encrypted || keyEncrypted;
                drm = drm || (keyEncrypted && /sample-aes|widevine|playready|fairplay|com\.apple\.streamingkeydelivery|edef8ba9|9a04f079/i.test(`${method} ${keyFormat}`));
                if (method === 'AES-128') {
                    currentKeyUri = stripQuotes(attributes.URI || '');
                    currentKeyIv = stripQuotes(attributes.IV || '');
                    currentKeyMethod = method;
                } else if (method === 'NONE') {
                    currentKeyUri = '';
                    currentKeyIv = '';
                    currentKeyMethod = '';
                }
                continue;
            }

            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                const seq = Number.parseInt(line.slice(line.indexOf(':') + 1).trim(), 10);
                if (Number.isFinite(seq)) mediaSequence = seq;
                continue;
            }

            if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
                const type = line.slice(line.indexOf(':') + 1).trim().toUpperCase();
                if (type === 'VOD') isVod = true;
                continue;
            }

            if (line === '#EXT-X-ENDLIST') hasEndList = true;
            if (!line.startsWith('#') && expectingSegmentUri) {
                rememberHlsSegment(line, item.url);
                expectingSegmentUri = false;
            }
        }

        item.segmentCount = Math.max(item.segmentCount || 0, segmentCount);
        item.duration = Math.max(item.duration || 0, duration);
        item.encrypted = item.encrypted || encrypted;
        item.drm = item.drm || drm;
        if (segmentCount > 0) item.live = !hasEndList && !isVod;
        // 保存 AES-128 解密所需信息
        if (currentKeyMethod === 'AES-128' && currentKeyUri) {
            item.hlsAesKeyUri = normalizeUrl(currentKeyUri, item.url) || currentKeyUri;
            item.hlsAesIv = currentKeyIv;
            item.hlsAesMethod = currentKeyMethod;
            item.hlsMediaSequence = mediaSequence;
        } else if (!encrypted) {
            item.hlsAesKeyUri = '';
            item.hlsAesIv = '';
            item.hlsAesMethod = '';
            item.hlsMediaSequence = 0;
        }
        // 缓存清单文本与关键属性，供“清空后重扫”秒级恢复（不依赖网络重拉）
        if (item.manifestText) {
            hlsManifestCache.set(item.url, {
                text: item.manifestText,
                segmentCount: item.segmentCount,
                duration: item.duration,
                encrypted: item.encrypted,
                drm: item.drm,
                live: item.live,
                hlsAesKeyUri: item.hlsAesKeyUri,
                hlsAesIv: item.hlsAesIv,
                hlsAesMethod: item.hlsAesMethod,
                hlsMediaSequence: item.hlsMediaSequence
            });
            if (hlsManifestCache.size > 50) hlsManifestCache.delete(hlsManifestCache.keys().next().value);
        }
        item.updatedAt = Date.now();

        if (!IS_TOP_FRAME) postResourceToTop(item);
        if (IS_TOP_FRAME) scheduleRender(false);
    }

    function parseAttributeList(line) {
        const attributes = {};
        const colon = line.indexOf(':');
        const input = colon >= 0 ? line.slice(colon + 1) : line;
        const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
        let match;
        while ((match = pattern.exec(input))) attributes[match[1].toUpperCase()] = match[2].trim();
        return attributes;
    }

    function nextUriLine(lines, startIndex) {
        for (let index = startIndex; index < lines.length; index += 1) {
            if (!lines[index]) continue;
            if (!lines[index].startsWith('#')) return lines[index];
            if (lines[index].startsWith('#EXT-X-STREAM-INF:')) return '';
        }
        return '';
    }

    function stripQuotes(value) {
        return String(value || '').replace(/^"|"$/g, '');
    }

    function qualityFromAttributes(attributes) {
        const resolution = stripQuotes(attributes.RESOLUTION || '');
        const match = resolution.match(/(\d+)x(\d+)/i);
        if (match) return `${match[2]}p`;
        const name = stripQuotes(attributes.NAME || '');
        return cleanShortText(name, 40);
    }

    function canDownloadHlsVideo(item) {
        if (item.kind !== 'hls' || !item.manifestText || item.segmentCount <= 0 || item.live || item.drm) return false;
        if (!item.encrypted) return true;
        // AES-128 可通过浏览器 WebCrypto 解密，允许下载
        return item.hlsAesMethod === 'AES-128' && Boolean(item.hlsAesKeyUri);
    }

    function createHlsDownloadPlan(item) {
        if (!canDownloadHlsVideo(item)) {
            if (item.drm) throw new Error('该清单包含 DRM 保护');
            if (item.encrypted) throw new Error('浏览器内合并暂不支持加密 HLS，请使用 FFmpeg');
            if (item.live) throw new Error('直播清单会持续变化，暂不支持直接合并');
            throw new Error('请先解析出包含分片的媒体清单');
        }

        const lines = item.manifestText.split(/\r?\n/).map((line) => line.trim());
        const parts = [];
        const rangeEnds = new Map();
        let pendingByteRange = '';
        let currentMapIdentity = '';
        let hasMap = false;
        let currentAesKeyUri = item.hlsAesKeyUri || '';
        let currentAesIv = item.hlsAesIv || '';
        let currentAesMethod = item.hlsAesMethod || '';
        let mediaSequence = Number(item.hlsMediaSequence) || 0;
        let segmentIndex = 0;

        for (const line of lines) {
            if (!line) continue;
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                const seq = Number.parseInt(line.slice(line.indexOf(':') + 1).trim(), 10);
                if (Number.isFinite(seq)) mediaSequence = seq;
                continue;
            }
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                throw new Error('这是主清单，请选择已解析出的具体画质');
            }
            if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
                const attributes = parseAttributeList(line);
                const method = String(attributes.METHOD || '').toUpperCase();
                if (method === 'AES-128') {
                    currentAesKeyUri = normalizeUrl(stripQuotes(attributes.URI || ''), item.url) || stripQuotes(attributes.URI || '');
                    currentAesIv = stripQuotes(attributes.IV || '');
                    currentAesMethod = method;
                } else if (method === 'NONE') {
                    currentAesKeyUri = '';
                    currentAesIv = '';
                    currentAesMethod = '';
                } else if (method && method !== 'NONE') {
                    throw new Error('浏览器内合并暂不支持加密 HLS，请使用 FFmpeg');
                }
                continue;
            }
            if (line.startsWith('#EXT-X-MAP:')) {
                const attributes = parseAttributeList(line);
                const url = normalizeUrl(stripQuotes(attributes.URI || ''), item.url);
                if (!url) continue;
                const range = parseHlsByteRange(stripQuotes(attributes.BYTERANGE || ''), url, rangeEnds);
                const identity = `${url}|${range || ''}`;
                if (identity !== currentMapIdentity) {
                    parts.push({ url, range, init: true });
                    currentMapIdentity = identity;
                    hasMap = true;
                }
                continue;
            }
            if (line.startsWith('#EXT-X-BYTERANGE:')) {
                pendingByteRange = line.slice(line.indexOf(':') + 1).trim();
                continue;
            }
            if (line.startsWith('#')) continue;

            const url = normalizeUrl(line, item.url);
            if (!url) continue;
            const range = parseHlsByteRange(pendingByteRange, url, rangeEnds);
            const part = { url, range, init: false };
            if (currentAesMethod === 'AES-128' && currentAesKeyUri) {
                part.keyUri = currentAesKeyUri;
                part.keyIv = currentAesIv;
                part.keyMethod = currentAesMethod;
                part.seq = mediaSequence + segmentIndex;
            }
            parts.push(part);
            segmentIndex += 1;
            pendingByteRange = '';
        }

        const mediaParts = parts.filter((part) => !part.init);
        if (!mediaParts.length) throw new Error('清单中没有可下载的媒体分片');
        const firstExtension = extensionFromUrl(mediaParts[0].url);
        const fragmentedMp4 = hasMap || ['m4s', 'mp4', 'cmfv', 'cmfa'].includes(firstExtension);
        const extension = fragmentedMp4 ? 'mp4' : firstExtension === 'aac' ? 'aac' : 'ts';
        const mime = fragmentedMp4 ? 'video/mp4' : extension === 'aac' ? 'audio/aac' : 'video/mp2t';
        return { parts, extension, mime, segmentCount: mediaParts.length };
    }

    function parseHlsByteRange(value, url, rangeEnds) {
        if (!value) return '';
        const match = String(value).match(/^(\d+)(?:@(\d+))?$/);
        if (!match) return '';
        const length = Number(match[1]);
        const start = match[2] === undefined ? Number(rangeEnds.get(url) || 0) : Number(match[2]);
        if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start) || start < 0) return '';
        const end = start + length - 1;
        rangeEnds.set(url, end + 1);
        return `bytes=${start}-${end}`;
    }

    function parseDashManifest(item, text) {
        try {
            const documentNode = new DOMParser().parseFromString(text, 'application/xml');
            if (documentNode.querySelector('parsererror')) return;

            const representations = [...documentNode.querySelectorAll('Representation')];
            const protection = [...documentNode.querySelectorAll('ContentProtection')]
                .map((node) => `${node.getAttribute('schemeIdUri') || ''} ${node.getAttribute('value') || ''}`)
                .join(' ');
            const drm = /widevine|playready|fairplay|cenc|edef8ba9|9a04f079|com\.apple/i.test(protection);
            const mpd = documentNode.documentElement;
            const duration = parseIsoDuration(mpd.getAttribute('mediaPresentationDuration') || '');

            item.kind = 'dash';
            item.mime = item.mime || 'application/dash+xml';
            item.manifestText = text.slice(0, MAX_MANIFEST_BYTES);
            item.representationCount = Math.max(item.representationCount || 0, representations.length);
            item.duration = Math.max(item.duration || 0, duration);
            item.drm = item.drm || drm;
            item.updatedAt = Date.now();

            for (const representation of representations) {
                const baseNode = representation.querySelector(':scope > BaseURL');
                if (!baseNode || !baseNode.textContent.trim()) continue;
                const adaptation = representation.closest('AdaptationSet');
                const mime = representation.getAttribute('mimeType') || adaptation?.getAttribute('mimeType') || '';
                const directUrl = normalizeUrl(baseNode.textContent.trim(), item.url);
                if (!directUrl || new URL(directUrl).pathname.endsWith('/')) continue;
                const kind = classifyResource(directUrl, mime);
                if (kind !== 'video' && kind !== 'audio') continue;

                upsertResource({
                    url: directUrl,
                    kind,
                    mime,
                    quality: representation.getAttribute('height') ? `${representation.getAttribute('height')}p` : '',
                    bandwidth: Number(representation.getAttribute('bandwidth')) || 0,
                    codecs: representation.getAttribute('codecs') || adaptation?.getAttribute('codecs') || '',
                    source: 'DASH BaseURL',
                    pageUrl: item.pageUrl,
                    pageTitle: item.pageTitle,
                    referrer: item.referrer,
                    parentUrl: item.url,
                    drm
                });
            }

            if (!IS_TOP_FRAME) postResourceToTop(item);
            if (IS_TOP_FRAME) scheduleRender(false);
        } catch (error) {
            console.debug('[视频嗅探] DASH 清单解析失败', error);
        }
    }

    function parseIsoDuration(value) {
        const match = String(value).match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
        if (!match) return 0;
        return (Number(match[1]) || 0) * 86400
            + (Number(match[2]) || 0) * 3600
            + (Number(match[3]) || 0) * 60
            + (Number(match[4]) || 0);
    }

    function requestManifest(item, userInitiated = true) {
        if (!item || (item.kind !== 'hls' && item.kind !== 'dash')) return Promise.resolve();
        if (manifestRequests.has(item.url)) return manifestRequests.get(item.url);

        item.probeState = 'loading';
        item.probeError = '';
        scheduleRender(false);

        const doFetchText = (fetchUrl, fetchReferrer, fetchHeaders, fetchCredentials) => {
            const cred = fetchCredentials || 'include';
            if (typeof GM_xmlhttpRequest === 'function') {
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: fetchUrl,
                        headers: fetchHeaders,
                        anonymous: cred === 'omit',
                        timeout: 15000,
                        responseType: 'text',
                        onload: (response) => {
                            if (response.status < 200 || response.status >= 400) {
                                reject(new Error(`HTTP ${response.status}`));
                                return;
                            }
                            const body = String(response.responseText || response.response || '').slice(0, MAX_MANIFEST_BYTES);
                            const mime = headerValue(response.responseHeaders, 'content-type');
                            inspectResponse({
                                url: response.finalUrl || fetchUrl,
                                mime,
                                body,
                                source: '清单解析',
                                pageUrl: item.pageUrl,
                                pageTitle: item.pageTitle,
                                referrer: item.referrer
                            });
                            resolve();
                        },
                        onerror: () => reject(new Error('网络请求失败')),
                        ontimeout: () => reject(new Error('请求超时'))
                    });
                });
            }
            return fetch(fetchUrl, { credentials: cred, referrer: fetchReferrer || location.href })
                .then((response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.text();
                })
                .then((body) => {
                    inspectResponse({
                        url: fetchUrl,
                        body: body.slice(0, MAX_MANIFEST_BYTES),
                        source: '清单解析',
                        pageUrl: item.pageUrl,
                        pageTitle: item.pageTitle,
                        referrer: item.referrer
                    });
                });
        };

        const request = (async () => {
            const referrersToTry = [item.referrer, '', location.href].filter((v, i, a) => v !== undefined && a.indexOf(v) === i);
            const credsToTry = ['include', 'omit', 'same-origin'];
            let lastError = null;
            for (const cred of credsToTry) {
                for (const ref of referrersToTry) {
                    const headers = ref ? { Referer: ref } : {};
                    try {
                        await doFetchText(item.url, ref, headers, cred);
                        return;
                    } catch (error) {
                        lastError = error;
                        const isCors = String(error.message).includes('Failed to fetch') || String(error.message).includes('CORS');
                        const isHttp = String(error.message).includes('HTTP 403') || String(error.message).includes('HTTP 401');
                        console.debug('[视频嗅探] 清单拉取失败，尝试回退', item.url, 'cred', cred, 'referrer', ref, error.message);
                        if (isCors || isHttp) continue;
                        if (ref !== referrersToTry[referrersToTry.length - 1] || cred !== credsToTry[credsToTry.length - 1]) continue;
                        throw error;
                    }
                }
            }
            throw lastError || new Error('清单拉取失败');
        })();

        const tracked = request.then(() => {
            item.probeState = 'done';
            item.probeError = '';
            if (userInitiated) showToast('清单解析完成');
        }).catch((error) => {
            item.probeState = 'error';
            item.probeError = cleanShortText(error.message || '解析失败', 100);
            if (userInitiated) showToast(`清单解析失败：${item.probeError}`);
        }).finally(() => {
            manifestRequests.delete(item.url);
            scheduleRender(false);
        });

        manifestRequests.set(item.url, tracked);
        return tracked;
    }

    function headerValue(rawHeaders, name) {
        const pattern = new RegExp(`^${name}:\\s*(.+)$`, 'im');
        const match = String(rawHeaders || '').match(pattern);
        return match ? match[1].trim() : '';
    }

    function filenameFromContentDisposition(value) {
        if (typeof value !== 'string' || !value) return '';
        const utfMatch = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
        if (utfMatch) {
            try {
                return sanitizeFilename(decodeURIComponent(utfMatch[1].trim()), '');
            } catch (_) {
                return sanitizeFilename(utfMatch[1].trim(), '');
            }
        }
        const plainMatch = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
        return sanitizeFilename((plainMatch && (plainMatch[1] || plainMatch[2])) || '', '');
    }

    function whenDocumentReady(callback) {
        if (document.documentElement) {
            callback();
            return;
        }
        const observer = new MutationObserver(() => {
            if (!document.documentElement) return;
            observer.disconnect();
            callback();
        });
        observer.observe(document, { childList: true });
    }

    function createUi() {
        if (ui || !document.documentElement) return;

        const host = document.createElement('div');
        host.dataset.videoResourceSniffer = 'true';
        host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;pointer-events:none!important;';
        const shadow = host.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = createUiStyles();
        shadow.append(style);

        const fab = createElement('button', 'vrd-fab');
        fab.type = 'button';
        fab.title = '点击打开，拖动调整位置';
        fab.setAttribute('aria-label', '打开视频资源列表，当前未发现资源');
        fab.append(createDownloadIcon(), createElement('span', 'vrd-badge'));

        const dialog = createElement('dialog', 'vrd-dialog');
        dialog.setAttribute('closedby', 'any');
        dialog.setAttribute('aria-labelledby', 'vrd-title');

        const panel = createElement('section', 'vrd-panel');
        const header = createElement('header', 'vrd-header');
        const headingWrap = createElement('div', 'vrd-heading-wrap');
        const title = createElement('h2', 'vrd-title', '视频资源');
        title.id = 'vrd-title';
        const summary = createElement('p', 'vrd-summary', '正在监听网页媒体请求');
        headingWrap.append(title, summary);

        const closeForm = document.createElement('form');
        closeForm.method = 'dialog';
        const headerActions = createElement('div', 'vrd-header-actions');
        const fullscreenButton = createElement('button', 'vrd-icon-button vrd-fullscreen-button');
        fullscreenButton.type = 'button';
        fullscreenButton.title = '全屏显示';
        fullscreenButton.setAttribute('aria-label', '全屏显示视频资源列表');
        fullscreenButton.setAttribute('aria-pressed', 'false');
        fullscreenButton.append(createFullscreenIcon());
        const closeButton = createElement('button', 'vrd-icon-button', '×');
        closeButton.type = 'submit';
        closeButton.setAttribute('aria-label', '关闭视频资源列表');
        closeForm.append(closeButton);
        headerActions.append(fullscreenButton, closeForm);
        header.append(headingWrap, headerActions);

        const toolbar = createElement('div', 'vrd-toolbar');
        const scanButton = createElement('button', 'vrd-secondary-button', '重新扫描');
        scanButton.type = 'button';
        const clearButton = createElement('button', 'vrd-secondary-button', '清空');
        clearButton.type = 'button';
        toolbar.append(scanButton, clearButton);

        const empty = createElement('div', 'vrd-empty');
        const emptyIcon = createDownloadIcon();
        emptyIcon.classList.add('vrd-empty-icon');
        const emptyTitle = createElement('strong', '', '尚未发现可下载视频');
        const emptyText = createElement('p', '', '开始播放视频后，脚本会从媒体标签和网络请求中识别资源。');
        empty.append(emptyIcon, emptyTitle, emptyText);

        const list = createElement('ul', 'vrd-list');
        list.setAttribute('aria-label', '已发现的视频资源');

        const footer = createElement('footer', 'vrd-footer', '仅下载你有权保存的内容。');
        const liveRegion = createElement('div', 'vrd-visually-hidden');
        liveRegion.setAttribute('aria-live', 'polite');
        liveRegion.setAttribute('aria-atomic', 'true');

        panel.append(header, toolbar, empty, list, footer, liveRegion);
        dialog.append(panel);
        shadow.append(fab, dialog);
        document.documentElement.append(host);

        ui = { host, shadow, fab, dialog, fullscreenButton, summary, scanButton, clearButton, empty, list, liveRegion };

        applyFabPosition(defaultFabPosition());
        installFabInteractions();
        restoreFabPosition();
        fullscreenButton.addEventListener('click', toggleDialogFullscreen);
        scanButton.addEventListener('click', () => {
            scanDocument();
            performance.getEntriesByType('resource').forEach((entry) => {
                const url = normalizeUrl(entry.name, location.href);
                const kindHint = entry.initiatorType === 'video' ? 'video' : entry.initiatorType === 'audio' ? 'audio' : '';
                const kind = url ? classifyResource(url, '', kindHint) : '';
                if (kind) {
                    const item = upsertResource({
                        url,
                        kind,
                        size: Number(entry.encodedBodySize || entry.transferSize) || 0,
                        source: `Performance/${entry.initiatorType || 'resource'}`,
                        ...currentPageInfo()
                    });
                    // 对未解析的 HLS/DASH 主动拉取清单，修复“清空后重扫仅显示下载清单”
                    if (item && (item.kind === 'hls' || item.kind === 'dash') && !item.manifestText && !manifestRequests.has(item.url)) {
                        requestManifest(item, false);
                    }
                }
            });
            // 对已有但未解析的 HLS 也尝试拉取
            for (const item of resources.values()) {
                if ((item.kind === 'hls' || item.kind === 'dash') && !item.manifestText && !manifestRequests.has(item.url)) {
                    requestManifest(item, false);
                }
            }
            showToast('已重新扫描当前页面');
        });
        clearButton.addEventListener('click', () => {
            clearAllResources();
            showToast('资源列表已清空');
        });
        dialog.addEventListener('close', () => fab.focus());
        installDialogLightDismiss(dialog);

        renderUi();
    }

    function defaultFabPosition() {
        return { mode: 'right-offset', top: clampFabTop(innerHeight - 59) };
    }

    function clampFabTop(value) {
        const buttonHeight = ui?.fab?.offsetHeight || 39;
        const maximum = Math.max(10, innerHeight - buttonHeight - 10);
        const number = Number(value);
        return Math.min(Math.max(Number.isFinite(number) ? number : maximum, 10), maximum);
    }

    function applyFabPosition(position) {
        if (!ui) return;
        const legacyModes = { floating: 'right-offset', left: 'left-edge', right: 'right-edge' };
        const requestedMode = legacyModes[position?.mode] || position?.mode;
        const mode = ['left-offset', 'left-edge', 'right-offset', 'right-edge'].includes(requestedMode)
            ? requestedMode
            : 'right-offset';
        const top = clampFabTop(position?.top);
        const { host } = ui;

        host.dataset.fabPosition = mode;
        host.style.setProperty('top', `${top}px`, 'important');
        host.style.setProperty('bottom', 'auto', 'important');
        if (mode.startsWith('left')) {
            host.style.setProperty('left', mode === 'left-edge' ? '0px' : '18px', 'important');
            host.style.setProperty('right', 'auto', 'important');
        } else {
            host.style.setProperty('left', 'auto', 'important');
            host.style.setProperty('right', mode === 'right-edge' ? '0px' : '18px', 'important');
        }
        ui.fabPosition = { mode, top };
    }

    async function restoreFabPosition() {
        if (typeof GM_getValue !== 'function') return;
        try {
            const stored = await Promise.resolve(GM_getValue(FAB_POSITION_KEY, null));
            if (stored && ui && ui.host.dataset.dragging !== 'true') applyFabPosition(stored);
        } catch (error) {
            console.debug('[视频嗅探] 悬浮按钮位置读取失败', error);
        }
    }

    function saveFabPosition(position) {
        if (typeof GM_setValue !== 'function') return;
        try {
            const result = GM_setValue(FAB_POSITION_KEY, position);
            if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (error) {
            console.debug('[视频嗅探] 悬浮按钮位置保存失败', error);
        }
    }

    function installFabInteractions() {
        const { fab, host } = ui;
        let gesture = null;
        let suppressClick = false;
        let resizeTimer = 0;

        fab.addEventListener('click', (event) => {
            if (suppressClick) {
                event.preventDefault();
                event.stopImmediatePropagation();
                suppressClick = false;
                return;
            }
            openDialog();
        });

        fab.addEventListener('pointerdown', (event) => {
            if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
            const rect = fab.getBoundingClientRect();
            gesture = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
                startMode: ui.fabPosition?.mode || 'right-offset',
                dragging: false
            };
            try {
                fab.setPointerCapture(event.pointerId);
            } catch (_) {
                // Pointer capture is an enhancement; document-level fallback is unnecessary for modern userscript targets.
            }
        });

        fab.addEventListener('pointermove', (event) => {
            if (!gesture || event.pointerId !== gesture.pointerId) return;
            const deltaX = event.clientX - gesture.startX;
            const deltaY = event.clientY - gesture.startY;
            if (!gesture.dragging && Math.abs(deltaX) <= 6 && Math.abs(deltaY) <= 6) return;

            gesture.dragging = true;
            event.preventDefault();
            host.dataset.dragging = 'true';
            const width = fab.offsetWidth || 39;
            const left = Math.min(Math.max(event.clientX - gesture.offsetX, 0), Math.max(0, innerWidth - width));
            const top = clampFabTop(event.clientY - gesture.offsetY);
            host.style.setProperty('left', `${left}px`, 'important');
            host.style.setProperty('right', 'auto', 'important');
            host.style.setProperty('top', `${top}px`, 'important');
        });

        const finishDrag = (event) => {
            if (!gesture || event.pointerId !== gesture.pointerId) return;
            const activeGesture = gesture;
            gesture = null;
            try {
                fab.releasePointerCapture(event.pointerId);
            } catch (_) {
                // The browser may already have released capture on pointercancel.
            }
            delete host.dataset.dragging;
            if (!activeGesture.dragging) return;

            const deltaX = event.clientX - activeGesture.startX;
            let mode = activeGesture.startMode;
            if (event.type !== 'pointercancel' && Math.abs(deltaX) > 18) {
                const edgeZone = Math.min(90, innerWidth * 0.22);
                if (event.clientX <= edgeZone) mode = 'left-edge';
                else if (event.clientX >= innerWidth - edgeZone) mode = 'right-edge';
                else mode = event.clientX < innerWidth / 2 ? 'left-offset' : 'right-offset';
            }
            const position = { mode, top: clampFabTop(Number.parseFloat(host.style.top)) };
            applyFabPosition(position);
            saveFabPosition(position);
            suppressClick = true;
            window.setTimeout(() => { suppressClick = false; }, 0);
        };

        fab.addEventListener('pointerup', finishDrag);
        fab.addEventListener('pointercancel', finishDrag);
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                if (!ui?.fabPosition) return;
                applyFabPosition(ui.fabPosition);
                saveFabPosition(ui.fabPosition);
            }, 120);
        }, { passive: true });
    }

    function toggleDialogFullscreen() {
        if (!ui) return;
        const fullscreen = ui.dialog.dataset.fullscreen !== 'true';
        ui.dialog.dataset.fullscreen = String(fullscreen);
        ui.fullscreenButton.setAttribute('aria-pressed', String(fullscreen));
        ui.fullscreenButton.setAttribute('aria-label', fullscreen ? '退出全屏显示' : '全屏显示视频资源列表');
        ui.fullscreenButton.title = fullscreen ? '退出全屏' : '全屏显示';
        updateFullscreenIcon(ui.fullscreenButton, fullscreen);
    }

    function createUiStyles() {
        return `
            :host { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            *, *::before, *::after { box-sizing: border-box; }
            button, a { font: inherit; }
            button:focus-visible, a:focus-visible { outline: 3px solid #b8ff5a; outline-offset: 2px; }
            .vrd-fab { --vrd-edge-x: 0px; pointer-events: auto; position: relative; display: grid; place-items: center; width: 39px; height: 39px; margin: 0; padding: 0; border: 1px solid rgba(255,255,255,.22); border-radius: 13px; color: #f8fafc; background: linear-gradient(145deg, #17213d, #0b1022); box-shadow: 0 9px 25px rgba(2,6,23,.38), inset 0 1px rgba(255,255,255,.13); cursor: grab; touch-action: none; user-select: none; transform: translate3d(var(--vrd-edge-x), 0, 0); transition: transform .18s ease, box-shadow .18s ease; }
            .vrd-fab:hover, .vrd-fab:focus-visible { --vrd-edge-x: 0px; transform: translate3d(var(--vrd-edge-x), -2px, 0); box-shadow: 0 12px 29px rgba(2,6,23,.46), inset 0 1px rgba(255,255,255,.16); }
            :host([data-fab-position="left-edge"]) .vrd-fab { --vrd-edge-x: -14px; border-radius: 5px 13px 13px 5px; }
            :host([data-fab-position="right-edge"]) .vrd-fab { --vrd-edge-x: 14px; border-radius: 13px 5px 5px 13px; }
            :host([data-fab-position="right-edge"]) .vrd-badge { inset: -5px auto auto -5px; }
            :host([data-dragging="true"]) .vrd-fab { --vrd-edge-x: 0px; border-radius: 50%; cursor: grabbing; transition: none; }
            .vrd-fab[data-active="true"] { color: #101827; background: linear-gradient(145deg, #c9ff71, #8eea31); border-color: rgba(16,24,39,.15); }
            .vrd-fab[data-flash="true"] { animation: vrd-pulse .8s ease-out; }
            .vrd-download-icon { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
            .vrd-fullscreen-icon { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
            .vrd-badge { position: absolute; inset: -5px -5px auto auto; min-width: 18px; height: 18px; padding: 0 4px; display: none; place-items: center; border: 2px solid #fff; border-radius: 999px; color: #fff; background: #ef4444; font-size: 9px; font-weight: 800; line-height: 1; }
            .vrd-badge[data-visible="true"] { display: grid; }
            .vrd-dialog { pointer-events: auto; width: min(720px, calc(100dvw - 28px)); max-width: none; max-height: min(82dvh, 760px); margin: auto; padding: 0; border: 1px solid rgba(148,163,184,.34); border-radius: 22px; color: #e7edf8; background: #0c1325; box-shadow: 0 28px 90px rgba(2,6,23,.58); overflow: hidden; }
            .vrd-dialog::backdrop { background: rgba(3,7,18,.66); backdrop-filter: blur(4px); }
            .vrd-panel { display: flex; flex-direction: column; max-height: min(82dvh, 760px); }
            .vrd-dialog[data-fullscreen="true"] { width: 100dvw; height: 100dvh; max-height: none; margin: 0; border: 0; border-radius: 0; }
            .vrd-dialog[data-fullscreen="true"] .vrd-panel { height: 100dvh; max-height: none; }
            .vrd-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 20px 20px 14px; border-bottom: 1px solid rgba(148,163,184,.16); background: radial-gradient(circle at 15% 0, rgba(142,234,49,.13), transparent 42%); }
            .vrd-heading-wrap { min-width: 0; }
            .vrd-header-actions { display: flex; flex: none; align-items: center; gap: 7px; }
            .vrd-title { margin: 0; color: #f8fafc; font-size: 21px; font-weight: 780; letter-spacing: -.02em; }
            .vrd-summary { margin: 5px 0 0; color: #9daac0; font-size: 13px; line-height: 1.45; }
            .vrd-icon-button { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 1px solid rgba(148,163,184,.2); border-radius: 12px; color: #cbd5e1; background: rgba(255,255,255,.04); font-size: 25px; line-height: 1; cursor: pointer; }
            .vrd-fullscreen-button { padding: 0; }
            .vrd-toolbar { display: flex; gap: 8px; padding: 12px 20px; border-bottom: 1px solid rgba(148,163,184,.12); }
            .vrd-secondary-button, .vrd-action-button { min-height: 34px; padding: 7px 11px; border: 1px solid rgba(148,163,184,.24); border-radius: 10px; color: #d9e2f2; background: rgba(255,255,255,.045); cursor: pointer; }
            .vrd-secondary-button:hover, .vrd-action-button:hover { border-color: rgba(184,255,90,.58); background: rgba(184,255,90,.09); }
            .vrd-action-button[data-primary="true"] { color: #101827; border-color: #a9f455; background: #a9f455; font-weight: 750; }
            .vrd-action-button:disabled { color: #708097; border-color: rgba(148,163,184,.12); background: rgba(255,255,255,.025); cursor: not-allowed; }
            .vrd-empty { display: grid; justify-items: center; gap: 8px; padding: 48px 24px 52px; color: #9daac0; text-align: center; }
            .vrd-empty[hidden] { display: none; }
            .vrd-empty strong { color: #e7edf8; font-size: 16px; }
            .vrd-empty p { max-width: 42ch; margin: 0; font-size: 13px; line-height: 1.55; }
            .vrd-empty-icon { width: 38px; height: 38px; color: #8eea31; }
            .vrd-list { flex: 1 1 auto; min-height: 0; margin: 0; padding: 8px 12px 14px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; list-style: none; scrollbar-color: #48566e transparent; }
            .vrd-resource { margin: 8px 0; padding: 14px; border: 1px solid rgba(148,163,184,.16); border-radius: 15px; background: rgba(255,255,255,.032); }
            .vrd-resource:hover { border-color: rgba(148,163,184,.3); }
            .vrd-resource-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
            .vrd-resource-title { min-width: 0; margin: 0; color: #f1f5f9; font-size: 14px; font-weight: 720; overflow-wrap: anywhere; }
            .vrd-chips { display: flex; flex: none; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
            .vrd-chip { padding: 3px 7px; border-radius: 999px; color: #cbd5e1; background: rgba(148,163,184,.13); font-size: 11px; font-weight: 700; }
            .vrd-chip[data-accent="true"] { color: #16200d; background: #b8ff5a; }
            .vrd-chip[data-danger="true"] { color: #fecaca; background: rgba(239,68,68,.17); }
            .vrd-url { display: block; margin: 9px 0 0; color: #8fa2be; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; text-decoration: none; }
            .vrd-url:hover { color: #b8ff5a; text-decoration: underline; }
            .vrd-meta { margin: 7px 0 0; color: #8291a8; font-size: 11px; line-height: 1.45; }
            .vrd-error { color: #fca5a5; }
            .vrd-download-status { margin: 9px 0 0; padding: 8px 10px; border: 1px solid rgba(184,255,90,.22); border-radius: 9px; color: #dff7c2; background: rgba(184,255,90,.07); font-size: 12px; line-height: 1.45; }
            .vrd-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
            .vrd-footer { padding: 11px 20px 13px; border-top: 1px solid rgba(148,163,184,.12); color: #74839a; font-size: 11px; line-height: 1.45; }
            .vrd-toast { pointer-events: none; position: fixed; right: 0; bottom: 72px; max-width: min(360px, calc(100dvw - 28px)); padding: 10px 13px; border: 1px solid rgba(184,255,90,.32); border-radius: 11px; color: #eaf7dc; background: #152018; box-shadow: 0 12px 30px rgba(2,6,23,.38); font-size: 13px; animation: vrd-toast-in .18s ease-out; }
            .vrd-toast[data-in-dialog="true"] { position: absolute; right: 14px; bottom: 14px; z-index: 5; }
            .vrd-visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; margin: -1px !important; padding: 0 !important; border: 0 !important; clip-path: inset(50%) !important; overflow: hidden !important; white-space: nowrap !important; }
            @keyframes vrd-pulse { 0% { box-shadow: 0 0 0 0 rgba(184,255,90,.62); } 100% { box-shadow: 0 0 0 18px rgba(184,255,90,0); } }
            @keyframes vrd-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
            @media (max-width: 560px) {
                .vrd-dialog { width: 100dvw; max-height: 86dvh; margin: auto 0 0; border-radius: 20px 20px 0 0; border-bottom: 0; }
                .vrd-panel { max-height: 86dvh; }
                .vrd-header { padding: 17px 16px 12px; }
                .vrd-toolbar { padding-inline: 16px; }
                .vrd-list { padding-inline: 8px; }
                .vrd-resource-head { display: block; }
                .vrd-chips { justify-content: flex-start; margin-top: 8px; }
                .vrd-footer { padding-inline: 16px; }
            }
            @media (prefers-reduced-motion: reduce) {
                .vrd-fab, .vrd-fab[data-flash="true"], .vrd-toast { animation: none; transition: none; }
            }
            @media (prefers-contrast: more) {
                .vrd-dialog, .vrd-resource, .vrd-action-button, .vrd-secondary-button { border-color: #94a3b8; }
            }
        `;
    }

    function createElement(tagName, className = '', text = '') {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        if (text) element.textContent = text;
        return element;
    }

    function createDownloadIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('vrd-download-icon');
        const paths = ['M12 3v11', 'm7.5 10.5 4.5 4.5 4.5-4.5', 'M5 20h14'];
        for (const data of paths) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', data);
            svg.append(path);
        }
        return svg;
    }

    function createFullscreenIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('vrd-fullscreen-icon');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M9 4H4v5 M15 4h5v5 M20 15v5h-5 M4 15v5h5');
        svg.append(path);
        return svg;
    }

    function updateFullscreenIcon(button, fullscreen) {
        const path = button.querySelector('.vrd-fullscreen-icon path');
        if (!path) return;
        path.setAttribute('d', fullscreen
            ? 'M4 9h5V4 M20 9h-5V4 M20 15h-5v5 M4 15h5v5'
            : 'M9 4H4v5 M15 4h5v5 M20 15v5h-5 M4 15v5h5');
    }

    function installDialogLightDismiss(dialog) {
        if (typeof HTMLDialogElement === 'undefined' || 'closedBy' in HTMLDialogElement.prototype) return;
        dialog.addEventListener('click', (event) => {
            if (event.target !== dialog) return;
            const rect = dialog.getBoundingClientRect();
            const inside = rect.top <= event.clientY
                && event.clientY <= rect.bottom
                && rect.left <= event.clientX
                && event.clientX <= rect.right;
            if (!inside) dialog.close();
        });
    }

    function openDialog() {
        if (!ui) {
            createUi();
            if (!ui) return;
        }
        renderUi();
        if (typeof ui.dialog.showModal === 'function') {
            if (!ui.dialog.open) ui.dialog.showModal();
        } else {
            ui.dialog.setAttribute('open', '');
        }
    }

    function scheduleRender(isNewResource) {
        if (isNewResource) {
            unannouncedCount += 1;
            clearTimeout(announceTimer);
            announceTimer = window.setTimeout(announceNewResources, 450);
        }
        if (renderTimer) return;
        renderTimer = window.setTimeout(() => {
            renderTimer = 0;
            renderUi(isNewResource);
        }, 60);
    }

    function announceNewResources() {
        if (!ui || !unannouncedCount) return;
        ui.liveRegion.textContent = `新发现 ${unannouncedCount} 个媒体资源`;
        unannouncedCount = 0;
    }

    function clearAllResources() {
        for (const controller of hlsDownloadTasks.values()) controller.abort();
        for (const item of resources.values()) releasePreparedDownload(item);
        resources.clear();
        seenPerformanceUrls.clear();
        knownHlsSegmentUrls.clear();
        hlsAesKeyCache.clear();
        // scannedScripts 是 WeakSet，无法清空，重新创建
        // 保留 blobMediaSeen 状态重置
        blobMediaSeen = false;
        scheduleRender(false);
    }

    function renderUi(flash = false) {
        if (!ui) return;
        const items = [...resources.values()].sort((a, b) => {
            const priority = (item) => {
                if (item.kind === 'video' || item.kind === 'audio') return 0;
                if (canDownloadHlsVideo(item)) return 1;
                if (item.kind === 'hls') return 2;
                if (item.kind === 'dash') return 3;
                if (item.kind === 'image') return 9;
                return 9;
            };
            return priority(a) - priority(b)
                || Number(b.bandwidth || 0) - Number(a.bandwidth || 0)
                || b.discoveredAt - a.discoveredAt;
        });
        const directCount = items.filter((item) => item.kind === 'video' || item.kind === 'audio').length;
        const manifestCount = items.length - directCount;

        ui.fab.dataset.active = String(items.length > 0);
        ui.fab.dataset.flash = String(Boolean(flash && items.length));
        ui.fab.setAttribute('aria-label', `打开视频资源列表，已发现 ${items.length} 项`);
        const badge = ui.fab.querySelector('.vrd-badge');
        badge.textContent = items.length > 99 ? '99+' : String(items.length);
        badge.dataset.visible = String(items.length > 0);
        if (flash) window.setTimeout(() => { if (ui) ui.fab.dataset.flash = 'false'; }, 850);

        ui.summary.textContent = items.length
            ? `已发现 ${directCount} 个直链、${manifestCount} 个流媒体清单`
            : blobMediaSeen
                ? '检测到 Blob/MSE 播放；请继续播放，等待清单或网络资源出现'
                : '正在监听网页媒体请求';
        ui.empty.hidden = items.length > 0;
        ui.list.replaceChildren();

        const fragment = document.createDocumentFragment();
        for (const item of items) fragment.append(createResourceRow(item));
        ui.list.append(fragment);
    }

    function createResourceRow(item) {
        const row = createElement('li', 'vrd-resource');
        const head = createElement('div', 'vrd-resource-head');
        const title = createElement('h3', 'vrd-resource-title', displayFilename(item));
        const chips = createElement('div', 'vrd-chips');
        chips.append(createChip(KIND_LABELS[item.kind] || '媒体', true));
        if (item.quality) chips.append(createChip(item.quality));
        if (item.mediaSize) chips.append(createChip(`视频 ${formatBytes(item.mediaSize)}`));
        else if (item.size) chips.append(createChip(item.kind === 'hls' || item.kind === 'dash' ? `清单 ${formatBytes(item.size)}` : formatBytes(item.size)));
        if (item.duration) chips.append(createChip(formatDuration(item.duration)));
        if (item.live) chips.append(createChip('直播'));
        if (item.encrypted && !item.drm) chips.append(createChip('加密'));
        if (item.drm) chips.append(createChip('DRM', false, true));
        head.append(title, chips);

        const link = createElement('a', 'vrd-url', compactUrl(item.url));
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener';

        const metaParts = [];
        if (item.bandwidth) metaParts.push(formatBitrate(item.bandwidth));
        if (item.codecs) metaParts.push(item.codecs);
        if (item.segmentCount) metaParts.push(`${item.segmentCount} 个分片`);
        if (item.representationCount) metaParts.push(`${item.representationCount} 个轨道/画质`);
        if (item.source) metaParts.push(`来源：${item.source}`);
        const meta = createElement('p', 'vrd-meta', metaParts.join(' · ') || '已从当前页面识别');

        const actions = createElement('div', 'vrd-actions');
        if (!item.drm) {
            const directResource = item.kind === 'video' || item.kind === 'audio';
            const downloadableHls = canDownloadHlsVideo(item);
            if (directResource) {
                const downloadButton = actionButton('下载', true);
                downloadButton.addEventListener('click', () => downloadResource(item));
                actions.append(downloadButton);
            } else if (item.downloadState) {
                const progressButton = actionButton(hlsDownloadProgressLabel(item), true);
                progressButton.disabled = true;
                const cancelButton = actionButton('取消下载');
                cancelButton.addEventListener('click', () => cancelHlsDownload(item));
                actions.append(progressButton, cancelButton);
            } else if (item.readyDownloadUrl) {
                const saveButton = actionButton('保存视频', true);
                saveButton.addEventListener('click', () => savePreparedVideo(item));
                const rebuildButton = actionButton('重新合并');
                rebuildButton.addEventListener('click', () => downloadHlsVideo(item));
                actions.append(saveButton, rebuildButton);
            } else if (downloadableHls) {
                const videoButton = actionButton('下载视频', true);
                videoButton.addEventListener('click', () => downloadHlsVideo(item));
                actions.append(videoButton);
            }

            if (item.kind === 'hls' || item.kind === 'dash') {
                const manifestButton = actionButton('下载清单', !downloadableHls && !item.downloadState);
                manifestButton.addEventListener('click', () => downloadResource(item));
                actions.append(manifestButton);
            }

            if (item.kind === 'hls' || item.kind === 'dash') {
                const ffmpegButton = actionButton('复制 FFmpeg');
                ffmpegButton.addEventListener('click', () => copyText(createFfmpegCommand(item), 'FFmpeg 命令已复制'));
                actions.append(ffmpegButton);
            }
        }

        if (item.kind === 'hls' || item.kind === 'dash') {
            const parseButton = actionButton(item.probeState === 'loading' ? '解析中…' : '解析清单');
            parseButton.disabled = item.probeState === 'loading';
            parseButton.addEventListener('click', () => requestManifest(item));
            actions.append(parseButton);
        }

        const openButton = actionButton('打开');
        openButton.addEventListener('click', () => openResource(item));
        const copyButton = actionButton('复制链接');
        copyButton.addEventListener('click', () => copyText(item.url, '资源链接已复制'));
        const removeButton = actionButton('移除');
        removeButton.addEventListener('click', () => {
            hlsDownloadTasks.get(item.url)?.abort();
            releasePreparedDownload(item);
            resources.delete(item.url);
            scheduleRender(false);
        });
        actions.append(openButton, copyButton, removeButton);

        row.append(head, link, meta);
        if (item.probeError) row.append(createElement('p', 'vrd-meta vrd-error', `清单解析失败：${item.probeError}`));
        if (item.drm) row.append(createElement('p', 'vrd-meta vrd-error', '该清单声明了 DRM/受保护媒体，脚本不提供解密或下载操作。'));
        else if (item.encrypted) row.append(createElement('p', 'vrd-meta', '该 HLS 使用加密分片，浏览器内合并不可用，可复制 FFmpeg 命令下载。'));
        if (item.downloadMessage) row.append(createElement('p', 'vrd-download-status', item.downloadMessage));
        row.append(actions);
        return row;
    }

    function createChip(text, accent = false, danger = false) {
        const chip = createElement('span', 'vrd-chip', text);
        if (accent) chip.dataset.accent = 'true';
        if (danger) chip.dataset.danger = 'true';
        return chip;
    }

    function actionButton(text, primary = false) {
        const button = createElement('button', 'vrd-action-button', text);
        button.type = 'button';
        if (primary) button.dataset.primary = 'true';
        return button;
    }

    function displayFilename(item) {
        if (item.filename) return item.filename;
        let pathName = '';
        try {
            pathName = decodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop() || '');
        } catch (_) {
            pathName = '';
        }

        const generic = !pathName || !/\.[a-z0-9]{2,6}$/i.test(pathName) || /^(?:index|master|playlist|manifest)(?:\.|$)/i.test(pathName);
        if (!generic) return sanitizeFilename(pathName, 'media');

        const base = sanitizeFilename(item.pageTitle || 'video', 'video');
        const quality = item.quality ? `_${sanitizeFilename(item.quality, '')}` : '';
        return `${base}${quality}.${extensionForItem(item)}`;
    }

    function extensionForItem(item) {
        const extension = extensionFromUrl(item.url);
        if (item.kind === 'hls') return 'm3u8';
        if (item.kind === 'dash') return 'mpd';
        if (extension && (MEDIA_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension))) return extension;
        if (item.kind === 'audio') return mimeToExtension(item.mime) || 'm4a';
        return mimeToExtension(item.mime) || 'mp4';
    }

    function mimeToExtension(mime) {
        const map = {
            'video/mp4': 'mp4',
            'video/webm': 'webm',
            'video/quicktime': 'mov',
            'audio/mpeg': 'mp3',
            'audio/mp4': 'm4a',
            'audio/aac': 'aac',
            'audio/ogg': 'ogg'
        };
        return map[normalizeMime(mime)] || '';
    }

    function sanitizeFilename(value, fallback = 'video') {
        const clean = String(value || '')
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
            .replace(/[. ]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 150);
        return clean || fallback;
    }

    function compactUrl(value) {
        try {
            const url = new URL(value);
            const visible = `${url.hostname}${url.pathname}${url.search}`;
            return visible.length > 180 ? `${visible.slice(0, 176)}…` : visible;
        } catch (_) {
            return value;
        }
    }

    function formatBytes(value) {
        const bytes = Number(value);
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        let amount = bytes;
        let unit = 0;
        while (amount >= 1024 && unit < units.length - 1) {
            amount /= 1024;
            unit += 1;
        }
        return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
    }

    function formatDuration(seconds) {
        const total = Math.round(Number(seconds));
        if (!Number.isFinite(total) || total <= 0) return '';
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const remaining = total % 60;
        return hours
            ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
            : `${minutes}:${String(remaining).padStart(2, '0')}`;
    }

    function formatBitrate(value) {
        const bitrate = Number(value);
        if (!Number.isFinite(bitrate) || bitrate <= 0) return '';
        return bitrate >= 1_000_000 ? `${(bitrate / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bitrate / 1000)} Kbps`;
    }

    function hlsDownloadProgressLabel(item) {
        if (item.downloadState === 'preparing') return '准备下载…';
        if (item.downloadState === 'saving') return '正在保存…';
        if (item.downloadState === 'cancelling') return '正在取消…';
        const size = item.downloadBytes ? ` · ${formatBytes(item.downloadBytes)}` : '';
        return `下载 ${Math.max(0, Math.min(100, Number(item.downloadProgress) || 0))}%${size}`;
    }

    async function downloadHlsVideo(item) {
        if (hlsDownloadTasks.has(item.url)) return;

        let plan;
        try {
            plan = createHlsDownloadPlan(item);
        } catch (error) {
            showToast(error.message || '该清单暂不支持直接下载');
            return;
        }

        releasePreparedDownload(item);
        const outputName = hlsVideoFilename(item, plan.extension);
        const pickerAttempt = startSaveFilePicker(outputName, plan);
        const controller = new AbortController();
        hlsDownloadTasks.set(item.url, controller);
        item.downloadState = 'preparing';
        item.downloadProgress = 0;
        item.downloadBytes = 0;
        item.downloadMessage = pickerAttempt.promise
            ? '请选择视频保存位置。'
            : '未能打开系统保存窗口，正在合并视频；完成后将调用浏览器下载。';
        scheduleRender(false);

        let writable = null;
        try {
            let fileHandle = null;
            if (pickerAttempt.promise) {
                try {
                    fileHandle = await pickerAttempt.promise;
                } catch (error) {
                    if (isAbortError(error)) {
                        console.debug('[视频嗅探] 保存位置选择已取消，改用浏览器下载', error);
                        item.downloadMessage = '已取消直接保存，正在改用浏览器下载。';
                        showToast(item.downloadMessage);
                    } else {
                        console.debug('[视频嗅探] 文件选择器不可用，改用内存合并', error);
                        item.downloadMessage = `系统保存窗口不可用（${cleanShortText(error.message || error.name || '调用失败', 80)}），正在改用浏览器下载。`;
                        showToast(item.downloadMessage);
                    }
                }
            } else if (pickerAttempt.error) {
                console.debug('[视频嗅探] 文件选择器调用失败', pickerAttempt.error);
                showToast(item.downloadMessage);
            }

            if (controller.signal.aborted) throw createAbortError();
            if (fileHandle) writable = await fileHandle.createWritable();

            item.downloadState = 'downloading';
            item.downloadMessage = writable
                ? '正在下载并写入所选文件，请勿关闭页面。'
                : '正在下载并合并分片，完成后将弹出浏览器下载。';
            scheduleRender(false);
            const chunks = [];
            let totalBytes = 0;
            let completed = 0;
            const concurrency = 4;

            let skippedCount = 0;
            for (let index = 0; index < plan.parts.length; index += concurrency) {
                const batch = plan.parts.slice(index, index + concurrency);
                const results = await Promise.allSettled(batch.map((part) => requestHlsPart(part, item, controller.signal)));
                for (let i = 0; i < results.length; i++) {
                    const result = results[i];
                    const part = batch[i];
                    if (result.status === 'rejected') {
                        const err = result.reason;
                        if (isAbortError(err)) throw err;
                        const is404 = String(err.message).includes('404') || String(err.message).includes('403');
                        if (is404) {
                            console.debug('[视频嗅探] 分片 404/403 已跳过，继续下载', part.url, err.message);
                            skippedCount += 1;
                            completed += 1;
                            item.downloadProgress = Math.round((completed / plan.parts.length) * 100);
                            continue;
                        }
                        throw err;
                    }
                    const rawBuffer = result.value;
                    const buffer = unwrapImageSegment(rawBuffer);
                    if (controller.signal.aborted) throw createAbortError();
                    totalBytes += buffer.byteLength;
                    if (!writable && totalBytes > MAX_MEMORY_DOWNLOAD_BYTES) {
                        throw new Error('视频超过 512 MB，请使用支持流式写盘的 Chrome/Edge，或复制 FFmpeg 命令下载');
                    }
                    if (writable) await writable.write(buffer);
                    else chunks.push(buffer);
                    completed += 1;
                    item.downloadProgress = Math.round((completed / plan.parts.length) * 100);
                    item.downloadBytes = totalBytes;
                }
                scheduleRender(false);
                await yieldToMain();
            }
            if (skippedCount > 0) {
                console.debug(`[视频嗅探] 共跳过 ${skippedCount} 个失效分片`);
            }

            item.downloadState = 'saving';
            scheduleRender(false);
            if (writable) {
                await writable.close();
                writable = null;
                item.downloadMessage = skippedCount > 0
                    ? `视频已保存，共 ${plan.segmentCount} 个分片（跳过 ${skippedCount} 个失效分片）。`
                    : `视频已保存，共 ${plan.segmentCount} 个分片。`;
            } else {
                const blob = new Blob(chunks, { type: plan.mime });
                prepareBrowserDownload(item, blob, outputName);
                if (skippedCount > 0) {
                    item.downloadMessage += `（跳过 ${skippedCount} 个失效分片）`;
                }
            }
            item.mediaSize = totalBytes;
            showToast(skippedCount > 0
                ? `视频下载完成，共 ${plan.segmentCount} 个分片（跳过 ${skippedCount} 个失效分片，可能存在短暂卡顿）`
                : `视频下载完成，共 ${plan.segmentCount} 个分片`);
        } catch (error) {
            controller.abort();
            if (writable) {
                try {
                    await writable.abort();
                } catch (_) {
                    // The writer may already be closed by the browser.
                }
            }
            if (isAbortError(error)) item.downloadMessage = '视频下载已取消。';
            else item.downloadMessage = `视频下载失败：${cleanShortText(error.message || '未知错误', 120)}`;
            showToast(item.downloadMessage);
        } finally {
            hlsDownloadTasks.delete(item.url);
            item.downloadState = '';
            item.downloadProgress = 0;
            item.downloadBytes = 0;
            scheduleRender(false);
        }
    }

    function cancelHlsDownload(item) {
        const controller = hlsDownloadTasks.get(item.url);
        if (!controller) return;
        item.downloadState = 'cancelling';
        scheduleRender(false);
        controller.abort();
    }

    function hlsVideoFilename(item, extension) {
        const base = displayFilename(item).replace(/\.(?:m3u8|mpd)$/i, '');
        return `${sanitizeFilename(base, 'video')}.${extension}`;
    }

    function startSaveFilePicker(outputName, plan) {
        const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;
        let receiver = pageWindow;
        let picker = pageWindow.showSaveFilePicker;
        if (typeof picker !== 'function' && typeof window.showSaveFilePicker === 'function') {
            receiver = window;
            picker = window.showSaveFilePicker;
        }
        if (typeof picker !== 'function') return { promise: null, error: null };

        const options = {
            id: 'video-resource-sniffer',
            startIn: 'downloads',
            suggestedName: outputName,
            types: [{
                description: plan.extension === 'ts' ? 'MPEG-TS 视频' : '视频文件',
                accept: { [plan.mime]: [`.${plan.extension}`] }
            }]
        };
        try {
            return { promise: Promise.resolve(Reflect.apply(picker, receiver, [options])), error: null };
        } catch (error) {
            return { promise: null, error };
        }
    }

    function prepareBrowserDownload(item, blob, outputName) {
        const blobUrl = URL.createObjectURL(blob);
        item.readyDownloadUrl = blobUrl;
        item.readyDownloadName = outputName;
        item.downloadMessage = '视频已合并，正在调用浏览器下载；若未弹出，请点击“保存视频”。';
        scheduleRender(false);

        const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
        const isViaLike = /Via|Quark|UCBrowser|QQBrowser|MiuiBrowser/i.test(userAgent);
        // Via 等移动端 WebView 对 GM_download/自动锚点点击的 Blob 支持不稳定（0.0B / javabridge 异常），仅提示用户手动点击
        if (isViaLike) {
            console.debug('[视频嗅探] 检测到 Via/Quark 等浏览器，跳过自动下载，等待用户点击“保存视频”');
            item.downloadMessage = '视频已合并，请点击“保存视频”完成保存（Via 需手动触发）。';
            scheduleRender(false);
            showToast('已准备好，请点击“保存视频”');
            return;
        }
        if (typeof GM_download === 'function') {
            try {
                const result = GM_download({
                    url: blobUrl,
                    name: outputName,
                    saveAs: true,
                    onload: () => {
                        item.downloadMessage = '浏览器下载已完成。';
                        scheduleRender(false);
                    },
                    onerror: (error) => {
                        console.debug('[视频嗅探] GM_download 失败，回退到锚点下载', error);
                        savePreparedVideo(item, true);
                    },
                    ontimeout: () => {
                        console.debug('[视频嗅探] GM_download 超时，回退到锚点下载');
                        savePreparedVideo(item, true);
                    }
                });
                if (result && typeof result.catch === 'function') {
                    result.catch((error) => {
                        console.debug('[视频嗅探] GM_download Promise 拒绝，回退到锚点下载', error);
                        savePreparedVideo(item, true);
                    });
                }
                return;
            } catch (error) {
                console.debug('[视频嗅探] Blob 下载提交失败，改用页面下载', error);
            }
        }
        savePreparedVideo(item, true);
    }

    function savePreparedVideo(item, automatic = false) {
        if (!item.readyDownloadUrl) return;
        const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
        const isViaLike = /Via|Quark|UCBrowser|QQBrowser|MiuiBrowser/i.test(userAgent);
        // Via 的 WebView 对 blob: 的 a[download] 与 GM_download 均可能抛 javabridge 异常
        // 统一走最稳定的 window.open / location.href，且必须在用户手势上下文中触发
        if (isViaLike) {
            try {
                // 优先尝试 GM_download 的 blob:（Via 4.8+ 对 blob: 支持较好，且走系统下载管理器）
                if (typeof GM_download === 'function') {
                    GM_download({
                        url: item.readyDownloadUrl,
                        name: item.readyDownloadName || 'video.ts',
                        saveAs: true,
                        onload: () => {
                            item.downloadMessage = '浏览器下载已完成，请查看通知栏。';
                            scheduleRender(false);
                        },
                        onerror: () => {
                            // 回退到 window.open，此路径在手势内不会抛 javabridge
                            try { window.open(item.readyDownloadUrl, '_blank'); } catch (_) { location.href = item.readyDownloadUrl; }
                        }
                    });
                    item.downloadMessage = '已调用系统下载，请查看通知栏或下载管理。';
                    scheduleRender(false);
                    showToast(item.downloadMessage);
                    return;
                }
            } catch (e) {
                console.debug('[视频嗅探] Via GM_download 异常', e);
            }
            // 纯 WebView 回退：必须在用户点击的同步调用栈中执行 window.open
            try {
                const win = window.open(item.readyDownloadUrl, '_blank');
                if (!win) location.href = item.readyDownloadUrl;
            } catch (_) {
                location.href = item.readyDownloadUrl;
            }
            item.downloadMessage = '已尝试打开视频，请在新页面长按保存或查看下载管理。';
            scheduleRender(false);
            showToast(item.downloadMessage);
            return;
        }
        try {
            triggerAnchorDownload(item.readyDownloadUrl, item.readyDownloadName || 'video.ts');
        } catch (error) {
            console.debug('[视频嗅探] 锚点下载触发失败，尝试备用方案', error);
            try {
                window.open(item.readyDownloadUrl, '_blank');
            } catch (_) {
                location.href = item.readyDownloadUrl;
            }
        }
        item.downloadMessage = automatic
            ? '已调用浏览器下载；若未弹出，请点击“保存视频”。'
            : '已再次调用浏览器下载。';
        scheduleRender(false);
        showToast(item.downloadMessage);
    }

    function releasePreparedDownload(item) {
        if (item?.readyDownloadUrl) URL.revokeObjectURL(item.readyDownloadUrl);
        if (!item) return;
        item.readyDownloadUrl = '';
        item.readyDownloadName = '';
    }

    async function requestHlsPart(part, item, signal) {
        const headers = { Accept: '*/*' };
        if (item.referrer) headers.Referer = item.referrer;
        if (part.range) headers.Range = part.range;

        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (signal.aborted) throw createAbortError();
            try {
                let buffer = await requestBinary(part.url, headers, item.referrer, signal);
                if (part.keyMethod === 'AES-128' && part.keyUri) {
                    buffer = await decryptAes128Segment(buffer, part.keyUri, part.keyIv, part.seq || 0, item.referrer, signal);
                }
                return unwrapImageSegment(buffer);
            } catch (error) {
                if (isAbortError(error)) throw error;
                lastError = error;
                if (attempt < 3) await waitWithSignal(300 * attempt, signal);
            }
        }
        throw lastError || new Error('分片下载失败');
    }

    function requestBinary(url, headers, referrer, signal) {
        const fetchFallback = () => {
            const fetchHeaders = {};
            if (headers.Range) fetchHeaders.Range = headers.Range;
            // 尝试不带 Referer 的 fetch，避免某些 CDN 对 Referer 的严格校验（如 4kvms 的 dc.xhscdn.com）
            return fetch(url, {
                credentials: 'include',
                headers: fetchHeaders,
                referrer: referrer || location.href,
                signal
            }).then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (headers.Range && response.status !== 206) throw new Error('服务器不支持 HLS 范围分片请求');
                return response.arrayBuffer();
            }).catch((error) => {
                if (isAbortError(error)) throw error;
                // 二次回退：尝试无 referrer 且无 credentials 的裸请求
                return fetch(url, { signal }).then((response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.arrayBuffer();
                });
            });
        };

        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                let requestHandle = null;
                let settled = false;
                const finish = (callback, value) => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener('abort', abortRequest);
                    callback(value);
                };
                const abortRequest = () => {
                    try {
                        requestHandle?.abort();
                    } catch (_) {
                        // Ignore abort errors from userscript managers.
                    }
                    finish(reject, createAbortError());
                };

                if (signal.aborted) {
                    abortRequest();
                    return;
                }
                signal.addEventListener('abort', abortRequest, { once: true });
                try {
                    requestHandle = GM_xmlhttpRequest({
                        method: 'GET',
                        url,
                        headers,
                        anonymous: false,
                        timeout: 30000,
                        responseType: 'arraybuffer',
                        onload: async (response) => {
                            try {
                                if (response.status && (response.status < 200 || response.status >= 400)) {
                                    throw new Error(`HTTP ${response.status}`);
                                }
                                if (headers.Range && response.status !== 206) {
                                    throw new Error('服务器不支持 HLS 范围分片请求');
                                }
                                const buffer = await toArrayBuffer(response.response);
                                finish(resolve, buffer);
                            } catch (error) {
                                finish(reject, error);
                            }
                        },
                        onerror: () => finish(reject, new Error('网络请求失败')),
                        ontimeout: () => finish(reject, new Error('分片请求超时')),
                        onabort: () => finish(reject, createAbortError())
                    });
                } catch (error) {
                    finish(reject, error);
                }
            }).catch((error) => {
                if (isAbortError(error)) throw error;
                console.debug('[视频嗅探] GM 请求失败，尝试 fetch 回退', url, error.message);
                return fetchFallback();
            });
        }

        return fetchFallback();
    }

    async function toArrayBuffer(value) {
        if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return value;
        if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        if (value && typeof value.arrayBuffer === 'function') return value.arrayBuffer();
        throw new Error('无法读取分片二进制数据');
    }

    function unwrapImageSegment(buffer) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) return buffer;
        const bytes = new Uint8Array(buffer);
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
        const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
        const isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
        const isBmp = bytes[0] === 0x42 && bytes[1] === 0x4D;
        if (!isPng && !isGif && !isJpg && !isBmp) {
            // 非图片伪装，检查是否为直接的 TS（0x47 开头）
            if (bytes[0] === 0x47) return buffer;
            // 兜底：查找首个 TS 包对齐的 0x47
            for (let i = 0; i < bytes.length - 188; i++) {
                if (bytes[i] === 0x47 && bytes[i + 188] === 0x47) return buffer.slice(i);
            }
            return buffer;
        }
        if (isPng) {
            for (let i = 8; i < bytes.length - 12; i++) {
                if (bytes[i] === 0x49 && bytes[i + 1] === 0x45 && bytes[i + 2] === 0x4E && bytes[i + 3] === 0x44) {
                    const tsStart = i + 8;
                    if (tsStart < bytes.length && bytes[tsStart] === 0x47) {
                        if (tsStart + 188 < bytes.length && bytes[tsStart + 188] === 0x47) return buffer.slice(tsStart);
                        return buffer.slice(tsStart);
                    }
                }
            }
        }
        if (isGif) {
            // GIF 尾部为 0x3B，视频数据紧跟其后
            for (let i = bytes.length - 1; i >= 0; i--) {
                if (bytes[i] === 0x3B) {
                    const tsStart = i + 1;
                    if (tsStart < bytes.length && bytes[tsStart] === 0x47) {
                        if (tsStart + 188 < bytes.length && bytes[tsStart + 188] === 0x47) return buffer.slice(tsStart);
                        return buffer.slice(tsStart);
                    }
                    break;
                }
            }
        }
        // 通用兜底：查找首个 TS 包对齐的 0x47（适用于 PNG/GIF/JPG 伪装）
        for (let i = 0; i < bytes.length - 188; i++) {
            if (bytes[i] === 0x47 && bytes[i + 188] === 0x47) return buffer.slice(i);
        }
        // 次级兜底：查找首个 0x47
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 0x47) return buffer.slice(i);
        }
        return buffer;
    }

    function parseAesIv(ivString, seq) {
        if (ivString) {
            let hex = String(ivString).trim().replace(/^0x/i, '');
            if (hex.length % 2 === 1) hex = '0' + hex;
            hex = hex.padStart(32, '0').slice(-32);
            const bytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            return bytes;
        }
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        // HLS 规范：未提供 IV 时使用段序号的大端 128 位
        view.setUint32(12, seq >>> 0, false);
        if (seq > 0xFFFFFFFF) view.setUint32(8, Math.floor(seq / 0x100000000) >>> 0, false);
        return bytes;
    }

    async function fetchAesKey(keyUri, referrer, signal) {
        if (hlsAesKeyCache.has(keyUri)) return hlsAesKeyCache.get(keyUri);
        const headers = {};
        if (referrer) headers.Referer = referrer;
        const buffer = await requestBinary(keyUri, headers, referrer, signal);
        if (buffer.byteLength !== 16 && buffer.byteLength !== 24 && buffer.byteLength !== 32) {
            console.debug('[视频嗅探] AES 密钥长度异常', keyUri, buffer.byteLength);
        }
        const keyBytes = buffer.slice(0, 16);
        hlsAesKeyCache.set(keyUri, keyBytes);
        // 简单的 LRU 清理
        if (hlsAesKeyCache.size > 20) hlsAesKeyCache.delete(hlsAesKeyCache.keys().next().value);
        return keyBytes;
    }

    async function decryptAes128Segment(buffer, keyUri, ivString, seq, referrer, signal) {
        if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.importKey !== 'function') {
            throw new Error('当前环境不支持 AES 解密，请使用 FFmpeg');
        }
        const keyBytes = await fetchAesKey(keyUri, referrer, signal);
        const ivBytes = parseAesIv(ivString, seq);
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        try {
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, buffer);
            return decrypted;
        } catch (error) {
            console.debug('[视频嗅探] AES 解密失败', error);
            throw new Error('分片解密失败，请尝试复制 FFmpeg 命令');
        }
    }

    function waitWithSignal(milliseconds, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(createAbortError());
                return;
            }
            const timer = window.setTimeout(() => {
                signal.removeEventListener('abort', abortWait);
                resolve();
            }, milliseconds);
            const abortWait = () => {
                clearTimeout(timer);
                reject(createAbortError());
            };
            signal.addEventListener('abort', abortWait, { once: true });
        });
    }

    function createAbortError() {
        const error = new Error('操作已取消');
        error.name = 'AbortError';
        return error;
    }

    function isAbortError(error) {
        return error?.name === 'AbortError';
    }

    async function yieldToMain() {
        if (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function') {
            await globalThis.scheduler.yield();
            return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    function downloadResource(item) {
        if (item.drm) {
            showToast('不支持下载 DRM/受保护媒体');
            return;
        }

        if ((item.kind === 'hls' || item.kind === 'dash') && item.manifestText) {
            const blob = new Blob([item.manifestText], { type: item.mime || 'text/plain;charset=utf-8' });
            const blobUrl = URL.createObjectURL(blob);
            triggerAnchorDownload(blobUrl, displayFilename(item));
            window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
            showToast('清单文件已保存；合并为视频可使用 FFmpeg');
            return;
        }

        if (typeof GM_download === 'function') {
            try {
                const options = {
                    url: item.url,
                    name: displayFilename(item),
                    saveAs: true,
                    headers: item.referrer ? { Referer: item.referrer } : undefined,
                    onload: () => showToast('下载已完成'),
                    onerror: (error) => {
                        showToast(`下载失败：${cleanShortText(error?.error || error?.details || '请尝试打开资源', 100)}`);
                    },
                    ontimeout: () => showToast('下载超时')
                };
                const result = GM_download(options);
                if (result && typeof result.catch === 'function') {
                    result.catch(() => openResource(item));
                }
                showToast('已提交下载任务');
                return;
            } catch (error) {
                console.debug('[视频嗅探] GM_download 失败，改用浏览器打开', error);
            }
        }

        triggerAnchorDownload(item.url, displayFilename(item));
        showToast('已交给浏览器处理；跨域资源可能会在新标签页打开');
    }

    function triggerAnchorDownload(url, filename) {
        try {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.target = '_blank';
            anchor.rel = 'noopener';
            anchor.style.display = 'none';
            // 必须在用户手势上下文中触发，部分 WebView 对非手势的 click 会抛 javabridge 异常
            document.documentElement.append(anchor);
            const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            const dispatched = anchor.dispatchEvent(evt);
            if (!dispatched) anchor.click();
            // 延迟移除，避免 Via 等 WebView 在 click 后立即移除导致下载中断
            window.setTimeout(() => anchor.remove(), 1000);
        } catch (error) {
            console.debug('[视频嗅探] triggerAnchorDownload 异常', error);
            throw error;
        }
    }

    function openResource(item) {
        const anchor = document.createElement('a');
        anchor.href = item.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.style.display = 'none';
        document.documentElement.append(anchor);
        anchor.click();
        anchor.remove();
    }

    function createFfmpegCommand(item) {
        const outputBase = sanitizeFilename(displayFilename(item).replace(/\.(?:m3u8|mpd)$/i, ''), 'video');
        const referer = item.referrer ? ` -referer ${quoteCommandArgument(item.referrer)}` : '';
        return `ffmpeg -hide_banner${referer} -i ${quoteCommandArgument(item.url)} -map 0 -c copy ${quoteCommandArgument(`${outputBase}.mp4`)}`;
    }

    function quoteCommandArgument(value) {
        return `"${String(value).replace(/"/g, '\\"')}"`;
    }

    async function copyText(text, successMessage) {
        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(text, 'text');
            } else if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.cssText = 'position:fixed;left:-9999px;top:0;';
                document.documentElement.append(textarea);
                textarea.select();
                document.execCommand('copy');
                textarea.remove();
            }
            showToast(successMessage);
        } catch (_) {
            showToast('复制失败，请手动复制链接');
        }
    }

    function showToast(message) {
        if (!IS_TOP_FRAME || !ui) return;
        ui.shadow.querySelector('.vrd-toast')?.remove();
        const toast = createElement('div', 'vrd-toast', message);
        toast.setAttribute('role', 'status');
        ui.liveRegion.textContent = message;
        if (ui.dialog.open) {
            toast.dataset.inDialog = 'true';
            ui.dialog.append(toast);
        } else {
            ui.shadow.append(toast);
        }
        window.setTimeout(() => toast.remove(), 3600);
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('打开视频资源面板', openDialog);
        GM_registerMenuCommand('重新扫描视频资源', () => {
            scanDocument();
            openDialog();
        });
        GM_registerMenuCommand('清空视频资源列表', () => {
            clearAllResources();
        });
    }
})();
