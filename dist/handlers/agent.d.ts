import { Handler, HandlerContext } from '../router.js';
import { QqControlDispatcher, QqSpellDispatcher } from './control.js';
import { AgentRunGate } from '../web-activity.js';
import { type SavedInput } from '../delivery-store.js';
import type { QqTurnInput } from '../bridge-events.js';
import { type InboundImage } from '../onebot/images.js';
/**
 * 历史配置字段 qqReplyStyleSkill 的默认 skill 名。
 *
 * 配置仍然解析(旧 profile 不会因此报错),但桥接层不再用它注入任何 prompt:
 * QQ 入站消息的原文逐字交给 Agent,不附加来源说明、临时风格标记或自动 skill 调用。
 */
export declare const DEFAULT_QQ_REPLY_STYLE_SKILL_NAME = "qq-session-reply-style";
/** qqReplyStyleSkill 的解析结果。仅为配置兼容保留,不再影响交给 Agent 的内容。 */
export interface QqReplyStyleSkillOptions {
    enabled?: boolean;
    skillName?: string;
}
export declare function sessionKeyOf(ctx: Pick<HandlerContext, 'scope' | 'userId' | 'groupId'>): string;
/**
 * 把文本按最大长度切分为多条,保证每条不超过 maxLen。
 * 优先在换行/标点附近切(保持可读),实在没有边界则硬切。
 */
export declare function splitText(text: string, maxLen: number): string[];
/**
 * 可注入的“遥控 DSH Agent”执行器。
 * 生产环境由 Cordis 插件接入 DSH 的 agents/agentLoop 服务注入;
 * 测试时可注入一个假执行器,无需真实 DSH。
 */
export interface AgentExecutor {
    prepareSession?(sessionKey: string): Promise<string>;
    /**
     * 把 payload 交给一个 DSH Agent 会话处理,返回最终文本。
     * @param sessionKey 用于把同一 QQ 会话映射到固定 AgentId(多轮上下文)
     * @param payload 用户消息
     * @param onChunk 可选:agent 产出过程中的分段回调(流式返回)。
     *        kind='text' 为最终回复文本增量;kind='reasoning' 为思考过程增量。
     */
    run(sessionKey: string, payload: string, onChunk?: (text: string, kind: 'text' | 'reasoning') => void, 
    /**
     * 本轮随消息一起下载好的图片。缺省表示没有图片,或图片全部不可用。
     * 实现方必须容忍缺失:图片是增量能力,不是调用前提。
     */
    images?: readonly InboundImage[]): Promise<string>;
    /**
     * 本轮真实用户消息在 DSH 侧的身份(可选)。
     *
     * 存在时,报告里的 `turnMessageId` 就是宿主生成的用户消息 id,外部据此把
     * 保存与发送对齐到同一轮;不实现时该字段缺省,调用方不得用平台 id 冒充。
     */
    lastTurnIdentity?(sessionKey: string): {
        sessionId?: string;
        messageId?: string;
    } | undefined;
}
/**
 * 一次 QQ 生成轮次结束后的对外事实。
 *
 * 只为接入方(例如记忆插件)记录真实发生的事:真实用户输入、桥接层解析控制块
 * 之后真正发出去的可见文字,以及每个分段是否被平台接受。不含思考过程、工具日志
 * 或桥接自己的确认/错误提示。
 */
export interface QqTurnReport {
    sessionKey: string;
    /** 这一轮所在的 DSH 会话 id;尚未建立会话时缺省。 */
    sessionId?: string;
    scope: 'private' | 'group';
    userId: string | number;
    groupId?: string | number;
    /** 已通过 bridge 配置校验的拥有者;人格与个人记忆只跟随它。 */
    owner: boolean;
    /** 入站平台消息 id,用于把一条输入与它引起的轮次关联。 */
    messageId?: string | number;
    /**
     * DSH 会话里那条真实用户消息的 id。
     *
     * 这是「这次输入」在 DSH 侧的唯一稳定标识,记忆插件用它把保存与发送对上;
     * 平台消息 id 不能替代它(同一个 QQ 消息 id 不会出现在 DSH 会话里)。
     */
    turnMessageId?: string;
    /** 指令前缀剥离后的真实用户输入。 */
    input: string;
    /** 桥接层解析控制块后的最终对外文字;没有可发文字时为空串。 */
    reply: string;
    /** 实际发送成功的分段,含平台消息 id(平台未提供时缺省)。 */
    parts: Array<{
        index: number;
        chars: number;
        platformId?: string;
        ok: boolean;
        error?: string;
    }>;
    status: 'completed' | 'failed' | 'interrupted';
    generationStatus?: 'completed' | 'failed' | 'interrupted';
    /** 失败/中断原因;成功时缺省。 */
    reason?: string;
}
export interface AgentTurnObserver {
    (report: QqTurnReport): void;
}
/**
 * A 内置 handler:QQ 消息 → 遥控 DSH Agent → 回发。
 */
export declare class AgentRpcHandler implements Handler {
    private readonly executor;
    private readonly opts;
    name: string;
    private readonly delivery;
    private readonly active;
    private readonly queues;
    private stopped;
    constructor(executor: AgentExecutor, opts?: {
        streamReasoning?: boolean;
        /** 是否边生成边回发 text 分段;默认 false,等待 agent 本轮完成后只发送最终回复。 */
        streamText?: boolean;
        /** 单条 QQ 消息最大长度;超长自动拆分为多条发送。 */
        maxMessageLength?: number;
        /** 收到有效指令后立即回发的确认消息;设为空字符串可关闭。 */
        ackMessage?: string;
        /** Agent 超时时间(ms);未设置时不限制 QQ 对话等待时间。 */
        timeoutMs?: number;
        /** Agent 长时间无响应时回发的消息。 */
        timeoutMessage?: string;
        /**
         * 旧配置 qqReplyStyleSkill 的解析结果:保留字段只为配置兼容,
         * 不再参与 prompt 拼装,也不会触发任何 skill 调用。
         */
        qqReplyStyleSkill?: QqReplyStyleSkillOptions;
        /** 由桥接层自己处理、不应再进入 Agent 的命令前缀。 */
        reservedCommands?: readonly string[];
        /** 单条消息最多取几张图;缺省 4。 */
        maxImages?: number;
        /** 单张入站图片的字节上限;超出即丢弃,不截断。 */
        maxImageBytes?: number;
        /** 单张图片的下载超时(ms);超时只损失这张图。 */
        imageTimeoutMs?: number;
        /** 测试注入用的 fetch;生产留空即用全局 fetch。 */
        fetchImpl?: typeof fetch;
        /** Assistant 输出控制块的执行器。存在时会先解析最终文本再回发。 */
        controlDispatcher?: QqControlDispatcher;
        /** @deprecated 咒语由 companion-memory 插件执行；桥接层只剥离标签。 */
        spellDispatcher?: QqSpellDispatcher;
        /** Web session 正在运行时,延后 QQ agent run 的全局 gate。 */
        webActivityGate?: AgentRunGate;
        /** Web session 忙时先回发给 QQ 的提示。 */
        webBusyMessage?: string;
        /** 当前 QQ 来源对应的 DSH 会话 id(只读关联,用于按会话记录/退役)。 */
        sessionIdOf?: (sessionKey: string) => string | undefined;
        /** 一轮真实结束后报告对外事实;不含思考过程、工具日志或内部提示。 */
        observeTurn?: AgentTurnObserver;
        prepareTurn?: (input: QqTurnInput) => Promise<void>;
        deliveryStatePath?: string;
        restoreContext?: (input: SavedInput) => HandlerContext | undefined;
    });
    open(): Promise<void>;
    dispose(): Promise<void>;
    completedReports(): QqTurnReport[];
    retireSession(sessionId: string): Promise<void>;
    private enqueue;
    retryPending(): Promise<void>;
    /** Session followups have no inbound HandlerContext; reuse durable delivery. */
    sendSessionOutput(input: QqTurnInput, turnNumber: number, result: string): Promise<void>;
    private sendPart;
    private finishDelivery;
    test(payload: string): boolean;
    /** 把一段文本按 maxLen 切分后逐条回发,并带回每段的平台回执。 */
    private respondChunk;
    run(ctx: HandlerContext): Promise<void>;
    private process;
    /**
     * 下载本条消息里的图片。
     *
     * 任何失败都只让这一张图缺席:文本照常送达,整轮不会因为图片坏掉而失败。
     * 丢弃原因写日志(不含字节、不含 base64),便于事后判断是链接过期还是类型不支持。
     * @param ctx - 含图片地址的入站上下文。
     * @returns 成功编码的图片;没有图片或全部失败时返回空数组。
     */
    private collectImages;
    private runAgentTurn;
    private observeTurn;
    private turnReport;
    /**
     * 解析控制块后回发,并报告真正对外可见的文字与每段平台回执。
     *
     * 控制块动作的回执、解析错误提示都是 bridge 自己的输出,不属于“助手回复”,
     * 因此只有 `parsed.visibleText` 计入 `reply`;但它们的发送结果仍逐段返回,
     * 便于调用方知道哪些平台消息已经产生。
     */
    private respondAgentOutput;
}
export declare class AgentTimeoutError extends Error {
    constructor(timeoutMs: number);
}
