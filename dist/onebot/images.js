/**
 * QQ 入站图片:从平台消息里取出图片段,下载并编码成 DSH 可接收的图片载荷。
 *
 * 边界:
 * - 本模块只负责「取地址 → 取字节 → 归一化」,不碰 DSH 会话、不改消息队列;
 * - 任何一步失败都只损失这一张图,绝不阻断文本消息(图片是增量的,不是前置条件);
 * - 不记录图片字节或 base64,日志里只出现数量、媒体类型与可判定的失败原因。
 *
 * 两种平台来源:
 * - NapCat/OneBot v11: `message` 数组里 `type === 'image'`,字段在 `data` 上;
 *   老式 CQ 码场景由 `raw_message` 兜底,但那只是地址,不是内容。
 * - 官方 QQ 机器人:SDK 已经把附件解析成 `attachments[]`,图片是 `content_type` 为
 *   `image/*` 的条目。
 */
import { Buffer } from 'node:buffer';
/** DSH 图片准入接受的媒体类型。不在白名单里的一律丢弃,不猜也不转码。 */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** 与 DSH 默认准入一致的单图上限;超过就丢,不截断(截断会产生坏图)。 */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 单条消息最多取几张图。 */
export const DEFAULT_MAX_IMAGES = 4;
/** 下载超时:图片是次要内容,不能因此拖住整轮对话。 */
export const DEFAULT_IMAGE_TIMEOUT_MS = 10_000;
/**
 * 把任意声明类型收敛到白名单内。
 * @param declared - 平台或响应头声明的类型。
 * @param url - 地址兜底用的扩展名来源。
 * @returns 白名单内的类型,无法判定时返回 undefined。
 */
export function normalizeImageType(declared, url) {
    const cleaned = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (SUPPORTED_IMAGE_TYPES.includes(cleaned)) {
        return cleaned;
    }
    const path = url.split('?')[0]?.toLowerCase() ?? '';
    if (path.endsWith('.png'))
        return 'image/png';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg'))
        return 'image/jpeg';
    if (path.endsWith('.webp'))
        return 'image/webp';
    if (path.endsWith('.gif'))
        return 'image/gif';
    return undefined;
}
/**
 * 从 OneBot v11 消息事件的 `message` 数组成员里取图片。
 *
 * OneBot v11 的段形状是 `{ type, data }`;图片地址优先取 `data.url`,
 * 其次是 `data.file`(当它已经是一个 http 地址时)。其余字段形状因实现而异,
 * 因此只读这两处,读不到就当这张图不可用。
 * @param segments - 平台推送的消息段数组。
 * @returns 按出现顺序的图片地址。
 */
export function imageSourcesFromOnebotSegments(segments) {
    if (!Array.isArray(segments))
        return [];
    const sources = [];
    for (const raw of segments) {
        const segment = raw;
        if (!segment || segment.type !== 'image')
            continue;
        const data = segment.data ?? {};
        const file = typeof data.file === 'string' ? data.file : undefined;
        const url = typeof data.url === 'string' && data.url.length > 0
            ? data.url
            : file && /^https?:\/\//i.test(file) ? file : undefined;
        if (!url)
            continue;
        sources.push({
            url,
            ...(typeof data.summary === 'string' && data.summary.length > 0 ? { name: data.summary } : {}),
        });
    }
    return sources;
}
/**
 * 从官方 QQ 机器人的附件数组里取图片。
 * @param attachments - SDK 的 `InboundAttachment[]`。
 * @returns 按出现顺序的图片地址。
 */
export function imageSourcesFromOfficialAttachments(attachments) {
    if (!Array.isArray(attachments))
        return [];
    const sources = [];
    for (const raw of attachments) {
        const item = raw;
        if (!item || typeof item.url !== 'string' || item.url.length === 0)
            continue;
        const contentType = typeof item.content_type === 'string' ? item.content_type : '';
        if (!contentType.toLowerCase().startsWith('image/'))
            continue;
        sources.push({
            url: item.url,
            mediaType: contentType,
            ...(typeof item.filename === 'string' && item.filename.length > 0 ? { name: item.filename } : {}),
        });
    }
    return sources;
}
/**
 * 下载并编码一张图片。
 *
 * 先按响应头判定类型,响应头缺失或不认识时回落到地址扩展名;两者都判定不了就丢弃,
 * 不使用「按字节嗅探」这类需要额外依赖的做法。
 * @param source - 图片地址与平台声明。
 * @param options - 超时与大小上限。
 * @returns 编码结果,或可读的丢弃原因。
 */
export async function fetchInboundImage(source, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
        const response = await fetchImpl(source.url, { signal: controller.signal });
        if (!response.ok)
            return { skipped: `http ${response.status}` };
        const declared = response.headers.get('content-type') ?? source.mediaType;
        const mediaType = normalizeImageType(declared, source.url);
        if (!mediaType)
            return { skipped: `unsupported type ${declared ?? 'unknown'}` };
        const lengthHeader = response.headers.get('content-length');
        if (lengthHeader && Number(lengthHeader) > maxBytes)
            return { skipped: `too large (${lengthHeader} bytes)` };
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength === 0)
            return { skipped: 'empty body' };
        if (buffer.byteLength > maxBytes)
            return { skipped: `too large (${buffer.byteLength} bytes)` };
        return {
            image: {
                mediaType,
                data: buffer.toString('base64'),
                ...(source.name === undefined ? {} : { name: source.name }),
            },
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { skipped: controller.signal.aborted ? 'download timeout' : `download failed: ${message}` };
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 依次下载一组图片地址,单张失败不影响其它张。
 * @param sources - 图片地址。
 * @param options - 张数上限、单图上限、超时与可注入的 fetch。
 * @returns 成功的图与每一条丢弃原因。
 */
export async function collectInboundImages(sources, options = {}) {
    const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
    const images = [];
    const skipped = [];
    const limited = sources.slice(0, Math.max(0, maxImages));
    if (sources.length > limited.length) {
        skipped.push(`${sources.length - limited.length} image(s) over the per-message limit`);
    }
    for (const source of limited) {
        const result = await fetchInboundImage(source, options);
        if ('image' in result)
            images.push(result.image);
        else
            skipped.push(result.skipped);
    }
    return { images, skipped };
}
/**
 * 构造交给 DSH 的用户消息内容块。
 *
 * 文本在前、图片在后:DSH 的图片准入把 `{ type: 'image', attachment }` 与文本块
 * 同等对待,顺序只影响模型可读性,不影响正确性。
 * @param text - 用户原话(可能为空)。
 * @param images - 已编码的图片。
 * @returns 内容块数组;没有任何内容时返回空数组,由调用方决定如何报错。
 */
export function buildUserContent(text, images) {
    const blocks = [];
    if (text.length > 0)
        blocks.push({ type: 'text', text });
    for (const image of images) {
        blocks.push({
            type: 'image',
            data: image.data,
            mediaType: image.mediaType,
            ...(image.name === undefined ? {} : { name: image.name }),
        });
    }
    return blocks;
}
