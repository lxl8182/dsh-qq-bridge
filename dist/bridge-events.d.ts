/**
 * 桥接层对其他 Host 插件暴露的最小事实出口。
 *
 * 记忆插件需要知道「这一轮是不是主人说的、真实输入是什么、最终发出去的文字
 * 是什么、QQ 平台接受到哪几段、对应哪个 DSH 会话」。这些事实只有桥接层知道,
 * 所以由一个只读服务发布,而不是让别的插件去解析 QQ 协议或猜 DSH 事件。
 *
 * 边界:
 * - 只暴露事实,不暴露桥接内部状态、凭据、原始出站文本队列或修改入口;
 * - 服务名固定,结构变化必须留旧字段(新增是可加,删除是破坏);
 * - 桥接未加载时这个服务不存在,订阅方必须自己处理缺失。
 */
import type { QqTurnReport } from './handlers/agent.js';
export interface QqTurnInput {
    sessionKey: string;
    sessionId?: string;
    scope: 'private' | 'group';
    owner: boolean;
    userId: string | number;
    groupId?: string | number;
    messageId?: string | number;
    input: string;
}
/** 服务在 Cordis 中的名字;订阅方按这个名字注入。 */
export declare const QQ_BRIDGE_EVENTS_SERVICE = "qqBridgeEvents";
export type QqTurnListener = (report: QqTurnReport) => void;
export interface QqOutputDelivery {
    parts: Array<{
        index: number;
        ok: boolean;
        platformId?: string;
        error?: string;
    }>;
    status: 'completed' | 'failed' | 'cancelled';
}
type OutputSender = (sessionId: string, outputId: string, parts: Array<{
    index: number;
    text: string;
}>, canSend: () => Promise<boolean>) => Promise<QqOutputDelivery>;
/**
 * 一次订阅的句柄。`dispose` 幂等:重复调用、或在服务已卸载后调用都安全。
 */
export interface QqTurnSubscription {
    dispose(): void;
}
/**
 * 只读事件出口。
 *
 * `subscribe` 同步注册:注册完成后再发生的一轮一定会通知到;注册之前已经结束
 * 的轮次不会补发(补交由订阅方自己的持久队列负责,不靠桥接重放)。
 */
export declare class QqBridgeEvents {
    private readonly listeners;
    private readonly admissions;
    private readonly bindings;
    private retirer?;
    private pusher?;
    platform: 'official' | 'napcat';
    private replay?;
    private outputSender?;
    setOutputSender(sender: OutputSender): () => void;
    normalizeOutput(text: string): string;
    deliverOutput(sessionId: string, outputId: string, parts: Array<{
        index: number;
        text: string;
    }>, canSend: () => Promise<boolean>): Promise<QqOutputDelivery> | undefined;
    setReplay(replay: () => QqTurnReport[]): () => void;
    binding(sessionId: string): QqTurnInput | undefined;
    subscribeAdmission(listener: (input: QqTurnInput) => Promise<void>): QqTurnSubscription;
    prepare(input: QqTurnInput): Promise<void>;
    /**
     * 由宿主插件注册"主动给管理员发一条文字"的能力。
     *
     * 桥接自己知道该发给谁(管理员 QQ / OpenID)和怎么发,别的插件不该复制
     * 这份配置。注册者不出现时 pushPrivate 返回 undefined,调用方据此降级,
     * 而不是假装送达。
     */
    setPusher(pusher: (text: string) => Promise<void>): () => void;
    /** 向管理员推送一条文字。没注册推送者时返回 undefined。 */
    pushPrivate(text: string): Promise<void> | undefined;
    setRetirer(retirer: (sessionId: string) => Promise<void>): () => void;
    retireSession(sessionId: string): Promise<void>;
    subscribe(listener: QqTurnListener): QqTurnSubscription;
    /**
     * 发布一轮的结果。监听器抛错只影响它自己:桥接的收发不能因为某个订阅方
     * 出错而失败。
     */
    publish(report: QqTurnReport): void;
    /** 卸载时清空订阅,避免已销毁的服务继续持有回调。 */
    dispose(): void;
    get listenerCount(): number;
}
export {};
