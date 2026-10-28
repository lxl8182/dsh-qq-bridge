import { QQBot } from '@tencent-connect/qqbot-nodejs';
const SDK_ERROR_ONLY_LOGGER = {
    info() { },
    warn() { },
    debug() { },
    error(msg) {
        console.error(msg);
    },
};
/** 腾讯官方 QQ 机器人 SDK 适配器:把官方事件转成桥接层内部消息事件。 */
export class TencentOfficialBotClient {
    bot;
    listeners = new Set();
    abort;
    started;
    constructor(options, bot) {
        this.bot = bot ?? new QQBot({
            appId: options.appId,
            appSecret: options.appSecret,
            ...(options.sandbox ? { baseUrl: 'https://sandbox.api.sgroup.qq.com' } : {}),
            logger: SDK_ERROR_ONLY_LOGGER,
        });
    }
    connect() {
        if (this.started !== undefined)
            return this.started;
        this.abort = new AbortController();
        this.started = new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn) => {
                if (settled)
                    return;
                settled = true;
                fn();
            };
            this.bot
                .on('ready', () => {
                console.info('[dsh-qq-bridge] official QQ bot connected');
                settle(resolve);
            })
                .on('resumed', () => {
                console.info('[dsh-qq-bridge] official QQ bot resumed');
                settle(resolve);
            })
                .on('error', (err) => {
                console.warn(`[dsh-qq-bridge] official QQ bot error: ${err.message}`);
                settle(() => reject(err));
            })
                .on('message', (_ctx, msg) => this.handleMessage(msg));
            this.bot.start(this.abort?.signal).catch((err) => {
                settle(() => reject(err instanceof Error ? err : new Error(String(err))));
            });
        });
        return this.started;
    }
    onMessage(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    async sendPrivate(userId, message, replyTarget) {
        const key = String(userId);
        const target = officialReplyTarget(replyTarget, 'c2c') ?? { scope: 'c2c', targetId: key };
        if (target.msgId === undefined && this.bot.sendWakeup) {
            await this.bot.sendWakeup(target, message);
            return;
        }
        await this.bot.sendText(target, message);
    }
    async sendGroup(groupId, message, replyTarget) {
        const key = String(groupId);
        const target = officialReplyTarget(replyTarget, 'group') ?? { scope: 'group', targetId: key };
        await this.bot.sendText(target, message);
    }
    async disconnect() {
        this.listeners.clear();
        this.abort?.abort();
        this.abort = undefined;
        this.started = undefined;
        this.bot.stop();
    }
    handleMessage(msg) {
        const event = toBridgeMessageEvent(msg);
        if (event === null)
            return;
        console.info(`[dsh-qq-bridge] official QQ message from ${event.user_id} (${event.message_type})`);
        for (const cb of this.listeners)
            cb(event);
    }
}
export function toBridgeMessageEvent(msg) {
    const scope = officialScopeToBridgeScope(msg.replyTarget.scope);
    if (scope === null)
        return null;
    const groupId = scope === 'group' ? msg.replyTarget.targetId : undefined;
    const segments = [{ type: 'text', data: { text: msg.content } }, ...officialAttachmentSegments(msg.attachments)];
    return {
        post_type: 'message',
        message_type: scope,
        user_id: msg.senderId,
        ...(groupId === undefined ? {} : { group_id: groupId }),
        raw_message: msg.content,
        ...(segments.length === 0 ? {} : { message: segments }),
        message_id: msg.messageId,
        reply_target: {
            platform: 'official',
            scope: msg.replyTarget.scope,
            targetId: msg.replyTarget.targetId,
            ...(msg.replyTarget.msgId === undefined ? {} : { msgId: msg.replyTarget.msgId }),
        },
    };
}
/**
 * 把官方机器人的附件归一化成 OneBot 形状的图片段。
 *
 * 官方 SDK 已经把附件解析成 `attachments[]`,这里只做形状转换,让下游的图片
 * 采集逻辑对两种平台共用一份代码。非图片附件不进入结果,也不在这里判类型是否
 * 可接受——那是下载环节的事。
 * @param attachments - SDK 的入站附件数组。
 * @returns 图片段;没有图片时返回空数组。
 */
export function officialAttachmentSegments(attachments) {
    if (!Array.isArray(attachments))
        return [];
    const segments = [];
    for (const raw of attachments) {
        const item = raw;
        if (!item || typeof item.url !== 'string' || item.url.length === 0)
            continue;
        const contentType = typeof item.content_type === 'string' ? item.content_type : '';
        if (!contentType.toLowerCase().startsWith('image/'))
            continue;
        segments.push({
            type: 'image',
            data: {
                url: item.url,
                ...(typeof item.filename === 'string' && item.filename.length > 0 ? { file: item.filename } : {}),
            },
        });
    }
    return segments;
}
function officialScopeToBridgeScope(scope) {
    if (scope === 'c2c')
        return 'private';
    if (scope === 'group')
        return 'group';
    return null;
}
function officialReplyTarget(target, scope) {
    if (target?.platform !== 'official' || target.scope !== scope)
        return undefined;
    return {
        scope,
        targetId: target.targetId,
        ...(target.msgId === undefined ? {} : { msgId: target.msgId }),
    };
}
