import { imageSourcesFromOnebotSegments } from './images.js';
/** 只解析传输层的 CQ 段；结构化 text 段里的字面代码保持原样。 */
export function normalizeInboundMessage(raw, segments) {
    const decode = (text) => text.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
    const parts = [];
    if (Array.isArray(segments) && segments.length)
        parts.push(...segments);
    else {
        let cursor = 0;
        for (const match of raw.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/gu)) {
            if (match.index > cursor)
                parts.push({ type: 'text', data: { text: decode(raw.slice(cursor, match.index)) } });
            parts.push({ type: match[1], data: Object.fromEntries(match[2].split(',').filter(Boolean).map(field => {
                    const at = field.indexOf('=');
                    return [field.slice(0, at), decode(field.slice(at + 1))];
                })) });
            cursor = match.index + match[0].length;
        }
        parts.push({ type: 'text', data: { text: decode(raw.slice(cursor)) } });
    }
    const images = [];
    const text = parts.map(part => {
        if (part.type === 'text')
            return String(part.data?.text ?? '');
        if (part.type === 'image') {
            const sourceIndex = images.length + 1;
            images.push({ ...(imageSourcesFromOnebotSegments([part])[0] ?? { url: '' }), sourceIndex });
            return `[图片${sourceIndex}]`;
        }
        if (part.type === 'at')
            return `@${part.data?.qq ?? ''}`;
        if (part.type === 'reply')
            return '';
        return `[${part.type}]`;
    }).join('');
    return { text, images };
}
export function imageStatusText(text, sources, images) {
    const admitted = new Set(images.map(image => image.sourceIndex));
    for (const source of sources) {
        const index = source.sourceIndex;
        if (index === undefined)
            continue;
        text = text.replace(new RegExp(`\\[图片${index}(?:未能读取)?\\]`, 'gu'), admitted.has(index) ? `[图片${index}]` : `[图片${index}未能读取]`);
    }
    return text;
}
