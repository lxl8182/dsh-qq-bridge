import type { HandlerContext } from './router.js';
import type { QqTurnReport } from './handlers/agent.js';
export type SavedInput = Pick<HandlerContext, 'scope' | 'userId' | 'senderName' | 'groupId' | 'owner' | 'messageId' | 'payload' | 'replyTarget' | 'images'>;
export interface DeliveryPart {
    outputIndex?: number;
    text: string;
    kind: 'reply' | 'control';
    state: 'pending' | 'sending' | 'sent' | 'unknown';
    platformId?: string;
    error?: string;
}
export interface DeliveryTurn {
    id: string;
    input: SavedInput;
    state: 'waiting' | 'running' | 'output' | 'complete' | 'failed' | 'unknown';
    parts: DeliveryPart[];
    report?: QqTurnReport;
    notified?: boolean;
    sessionId?: string;
    retired?: boolean;
    externallyManaged?: boolean;
}
/**
 * 一条输出在本机的持久投递状态(RO04-B 通用投递的读侧)。
 *
 * 消费者按 outputId 取回"哪些索引已送达、哪些还要发",重启后据此续投;
 * 它不重新生成正文,也不决定该说什么——那属于消费方。
 */
export interface DeliveryOutputView {
    output_id: string;
    state: DeliveryTurn['state'];
    parts: Array<{
        index: number;
        text: string;
        state: DeliveryPart['state'];
        platformId?: string;
        error?: string;
    }>;
    /** 仍未送达的分段索引(升序);用同一 outputId 再投这些索引即可。 */
    pending: number[];
    /** 是否还值得重试:sending/unknown 一律不自动重发。 */
    retryable: boolean;
}
/** An unfinished generation is never replayed after a crash; only admitted
 * inputs and individually known-unsent text may be retried automatically. */
export declare class DeliveryStore {
    private readonly path?;
    readonly turns: Record<string, DeliveryTurn>;
    private tail;
    constructor(path?: string | undefined);
    private inputKey;
    open(): Promise<void>;
    save(): Promise<void>;
    accept(ctx: HandlerContext, output?: {
        sessionId: string;
        parts: DeliveryPart[];
        externallyManaged?: boolean;
    }): Promise<{
        turn: DeliveryTurn;
        duplicate: boolean;
    }>;
    /** 找到某个稳定 outputId 对应的投递记录;没有时返回 undefined。 */
    outputTurn(outputId: string): DeliveryTurn | undefined;
    /**
     * 读侧投影:哪个索引已送达、哪些还要续投。
     *
     * 状态是桥接自己的事实(sent/pending/unknown),不是平台的"已读";
     * unknown 不算可重试——没有确认的发出去可能已经到达,重复会变成两条消息。
     */
    outputView(outputId: string): DeliveryOutputView | undefined;
    /** 所有仍可续投的输出(重启后按 outputId 续投用)。 */
    pendingOutputs(): DeliveryOutputView[];
}
