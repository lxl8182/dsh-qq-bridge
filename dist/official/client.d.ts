import { type QQBotInboundMessage, type ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import type { OnebotMessageEvent, OnebotMessageSegment, MessageTargetId, PlatformReplyTarget } from '../onebot/types.js';
export interface TencentOfficialBotOptions {
    appId: string;
    appSecret: string;
    sandbox?: boolean;
}
interface OfficialBotLike {
    on(event: 'ready', handler: (data: unknown) => void): this;
    on(event: 'resumed', handler: (data: unknown) => void): this;
    on(event: 'error', handler: (err: Error) => void): this;
    on(event: 'message', handler: (ctx: unknown, msg: QQBotInboundMessage) => void | Promise<void>): this;
    start(signal?: AbortSignal): Promise<void>;
    stop(): void;
    sendText(target: ReplyTarget, content: string): Promise<unknown>;
    sendWakeup?(target: ReplyTarget, content: string): Promise<unknown>;
}
/** 腾讯官方 QQ 机器人 SDK 适配器:把官方事件转成桥接层内部消息事件。 */
export declare class TencentOfficialBotClient {
    private readonly bot;
    private readonly listeners;
    private abort?;
    private started?;
    constructor(options: TencentOfficialBotOptions, bot?: OfficialBotLike);
    connect(): Promise<void>;
    onMessage(cb: (evt: OnebotMessageEvent) => void): () => void;
    sendPrivate(userId: MessageTargetId, message: string, replyTarget?: PlatformReplyTarget): Promise<void>;
    sendGroup(groupId: MessageTargetId, message: string, replyTarget?: PlatformReplyTarget): Promise<void>;
    disconnect(): Promise<void>;
    private handleMessage;
}
export declare function toBridgeMessageEvent(msg: QQBotInboundMessage): OnebotMessageEvent | null;
/**
 * 把官方机器人的附件归一化成 OneBot 形状的图片段。
 *
 * 官方 SDK 已经把附件解析成 `attachments[]`,这里只做形状转换,让下游的图片
 * 采集逻辑对两种平台共用一份代码。非图片附件不进入结果,也不在这里判类型是否
 * 可接受——那是下载环节的事。
 * @param attachments - SDK 的入站附件数组。
 * @returns 图片段;没有图片时返回空数组。
 */
export declare function officialAttachmentSegments(attachments: unknown): OnebotMessageSegment[];
export {};
