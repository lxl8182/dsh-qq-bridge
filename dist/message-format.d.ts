/** 固定正文与 Unicode 分段；片段拼接必须能还原正文。 */
export declare function replyParts(text: string, maxChars?: number, bubbles?: boolean): {
    text: string;
    parts: string[];
    part_sizes: number[];
};
