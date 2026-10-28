import type { OnebotMessageSegment } from './types.js';
import { type ImageSource } from './images.js';
/** 只解析传输层的 CQ 段；结构化 text 段里的字面代码保持原样。 */
export declare function normalizeInboundMessage(raw: string, segments?: readonly OnebotMessageSegment[]): {
    text: string;
    images: ImageSource[];
};
export declare function imageStatusText(text: string, sources: readonly ImageSource[], images: readonly {
    sourceIndex?: number;
}[]): string;
