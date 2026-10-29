import { MessageTargetId, OnebotMessageEvent, PlatformReplyTarget } from './onebot/types.js';
import { AccessGate } from './security.js';
import { type ImageSource } from './onebot/images.js';
/**
 * handler 上下文:暴露来源信息与便捷回发能力。
 */
export interface HandlerContext {
    userId: MessageTargetId;
    senderName?: string;
    scope: 'private' | 'group';
    groupId?: MessageTargetId;
    /** 已经剥离指令前缀后的有效载荷 */
    payload: string;
    /**
     * 这条消息是否来自已校验的拥有者(不是白名单成员,不是陌生人)。
     * 人格与个人记忆只跟随这个身份,昵称/群号/会话前缀都不作数。
     */
    owner: boolean;
    /** 平台消息 id;用于把一次入站与它引起的生成关联起来。 */
    messageId?: MessageTargetId;
    replyTarget?: PlatformReplyTarget;
    /**
     * 本条消息里图片的地址,按出现顺序。
     *
     * 这里只有地址,没有字节:命令类 handler 不该为了响应一条 "/help" 去下载图片。
     * 需要图片的处理器(Agent 轮次)自己调用 `collectInboundImages` 下载,失败只损失
     * 图片,不影响文本处理。
     */
    images?: readonly ImageSource[];
    /** 回发到来源会话 */
    respond(text: string): Promise<void>;
    /**
     * 回发并返回平台接收结果。
     *
     * `respond` 只报告“没有抛错”,调用方无法区分已送达与静默失败;需要记录平台
     * 接收事实时用这个形态。返回 `undefined` 表示平台未提供消息 id。
     */
    send?(text: string): Promise<{
        platformId?: string;
    }>;
}
export interface Handler {
    name: string;
    /** 是否愿意处理这条 message(如按 payload 命令名匹配) */
    test(payload: string): boolean;
    /** 命中后是否继续尝试后续 handler。默认 false,命令 handler 会独占消费。 */
    continueAfterRun?: boolean;
    run(ctx: HandlerContext): Promise<void>;
}
export interface PendingReplyHandler {
    handle(ctx: HandlerContext): Promise<boolean>;
}
export type OutboundSender = (scope: 'private' | 'group', targetId: MessageTargetId, text: string, replyTarget?: PlatformReplyTarget) => Promise<void>;
/** 带平台回执的出站发送;返回值里的 id 来自平台动作响应。 */
export type OutboundSendReceipt = ((scope: 'private' | 'group', targetId: MessageTargetId, text: string, replyTarget?: PlatformReplyTarget) => Promise<{
    platformId?: string;
} | void>) | undefined;
/**
 * C 骨架:消息分发器。注册 handler,按前缀 + 匹配路由。
 */
export declare class MessageRouter {
    private readonly gate;
    private readonly outbound;
    private readonly pendingReply?;
    /**
     * 带平台回执的发送器。缺省时 `ctx.send` 退化为 `respond` 且不带 id:
     * 旧调用方与旧传输层不需要改动,新调用方拿不到 id 时也知道自己拿不到。
     */
    private readonly outboundWithReceipt?;
    private handlers;
    constructor(gate: AccessGate, outbound: OutboundSender, pendingReply?: PendingReplyHandler | undefined, 
    /**
     * 带平台回执的发送器。缺省时 `ctx.send` 退化为 `respond` 且不带 id:
     * 旧调用方与旧传输层不需要改动,新调用方拿不到 id 时也知道自己拿不到。
     */
    outboundWithReceipt?: OutboundSendReceipt);
    register(handler: Handler): () => void;
    /**
     * 处理一条入站消息:
     * 1. 白名单过滤
     * 2. 前缀剥离
     * 3. 按注册顺序匹配 handler。
     * 返回是否被消费(被 router 处理且至少一个 handler 匹配)。
     */
    route(evt: OnebotMessageEvent): Promise<boolean>;
}
