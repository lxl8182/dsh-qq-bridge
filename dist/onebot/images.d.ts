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
/** DSH 图片准入接受的媒体类型。不在白名单里的一律丢弃,不猜也不转码。 */
export declare const SUPPORTED_IMAGE_TYPES: readonly ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** 与 DSH 默认准入一致的单图上限;超过就丢,不截断(截断会产生坏图)。 */
export declare const DEFAULT_MAX_IMAGE_BYTES: number;
/** 单条消息最多取几张图。 */
export declare const DEFAULT_MAX_IMAGES = 4;
/** 下载超时:图片是次要内容,不能因此拖住整轮对话。 */
export declare const DEFAULT_IMAGE_TIMEOUT_MS = 10000;
/** 一张已经下载并编码好的入站图片。 */
export interface InboundImage {
    /** 规范化后的媒体类型。 */
    mediaType: (typeof SUPPORTED_IMAGE_TYPES)[number];
    /** 标准 base64(无 data: 前缀)。 */
    data: string;
    /** 可选展示名,来自平台字段,仅用于日志与模型提示。 */
    name?: string;
}
/** 从平台消息里抽出的图片地址;此时还没有下载。 */
export interface ImageSource {
    url: string;
    mediaType?: string;
    name?: string;
}
/** 一次图片解析的结果:成功的图 + 可读的丢弃原因。 */
export interface InboundImageResult {
    images: InboundImage[];
    /** 每一条被丢弃的原因;调用方只用于日志,不呈现给用户。 */
    skipped: string[];
}
/**
 * 把任意声明类型收敛到白名单内。
 * @param declared - 平台或响应头声明的类型。
 * @param url - 地址兜底用的扩展名来源。
 * @returns 白名单内的类型,无法判定时返回 undefined。
 */
export declare function normalizeImageType(declared: string | undefined, url: string): InboundImage['mediaType'] | undefined;
/**
 * 从 OneBot v11 消息事件的 `message` 数组成员里取图片。
 *
 * OneBot v11 的段形状是 `{ type, data }`;图片地址优先取 `data.url`,
 * 其次是 `data.file`(当它已经是一个 http 地址时)。其余字段形状因实现而异,
 * 因此只读这两处,读不到就当这张图不可用。
 * @param segments - 平台推送的消息段数组。
 * @returns 按出现顺序的图片地址。
 */
export declare function imageSourcesFromOnebotSegments(segments: unknown): ImageSource[];
/**
 * 从官方 QQ 机器人的附件数组里取图片。
 * @param attachments - SDK 的 `InboundAttachment[]`。
 * @returns 按出现顺序的图片地址。
 */
export declare function imageSourcesFromOfficialAttachments(attachments: unknown): ImageSource[];
/**
 * 下载并编码一张图片。
 *
 * 先按响应头判定类型,响应头缺失或不认识时回落到地址扩展名;两者都判定不了就丢弃,
 * 不使用「按字节嗅探」这类需要额外依赖的做法。
 * @param source - 图片地址与平台声明。
 * @param options - 超时与大小上限。
 * @returns 编码结果,或可读的丢弃原因。
 */
export declare function fetchInboundImage(source: ImageSource, options?: {
    timeoutMs?: number;
    maxBytes?: number;
    fetchImpl?: typeof fetch;
}): Promise<{
    image: InboundImage;
} | {
    skipped: string;
}>;
/**
 * 依次下载一组图片地址,单张失败不影响其它张。
 * @param sources - 图片地址。
 * @param options - 张数上限、单图上限、超时与可注入的 fetch。
 * @returns 成功的图与每一条丢弃原因。
 */
export declare function collectInboundImages(sources: readonly ImageSource[], options?: {
    maxImages?: number;
    maxBytes?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<InboundImageResult>;
/**
 * 构造交给 DSH 的用户消息内容块。
 *
 * 文本在前、图片在后:DSH 的图片准入把 `{ type: 'image', attachment }` 与文本块
 * 同等对待,顺序只影响模型可读性,不影响正确性。
 * @param text - 用户原话(可能为空)。
 * @param images - 已编码的图片。
 * @returns 内容块数组;没有任何内容时返回空数组,由调用方决定如何报错。
 */
export declare function buildUserContent(text: string, images: readonly InboundImage[]): Array<{
    type: 'text';
    text: string;
} | {
    type: 'image';
    data: string;
    mediaType: string;
    name?: string;
}>;
