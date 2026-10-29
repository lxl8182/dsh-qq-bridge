import { AgentExecutor } from './agent.js';
import type { InboundImage } from '../onebot/images.js';
import { BridgeModelInfo, BridgeModelSelection, BridgeModelSelectionRef, PermissionController, SessionLifecycleController } from './model-control.js';
/**
 * 提取 session surface 中最后一条 assistant 消息的纯文本。
 *
 * 兼容两种事件形状:
 * - **DSH 真实形状**: `{ type, seq, data: { message: { content: [...] } }, ... }`
 *   (assistant 消息体挂在 `data.message.content`)。
 * - 简易形状(用于本地测试): `{ type: 'assistant/message', content: [...] }`。
 */
export declare function extractLastAssistantText(events: readonly unknown[]): string | null;
/** 一轮内完成的可见消息按首次出现顺序合并，相同消息 ID 只采用最后的完整版本。 */
export declare function extractAssistantText(events: readonly unknown[]): string | null;
/** Read one committed turn without mixing in later followups. */
export declare function eventsForTurn(events: readonly unknown[], turn: number): readonly unknown[];
/**
 * DSH 工具调用没有被运行时识别时,模型可能把 DSML 协议文本当普通 text 输出。
 * 这类内容不是有效回复,也不应透传给 QQ 用户。
 */
export declare function isUnexecutedDsmlToolCall(text: string): boolean;
/**
 * 提取 session surface 中最后一条 user 消息的 id 与文本。
 *
 * 这是「这次输入」在 DSH 侧的稳定标识:每条用户消息的 id 由宿主生成且唯一,
 * 因此外部可以据此把一次删除/发送与具体的 DSH 轮次对上,而不必猜轮次序号。
 *
 * 兼容两种事件形状(与 `extractLastAssistantText` 同一套):
 * `{ type, data: { message } }` 与简易的 `{ type, content }`。
 */
export declare function extractLastUserMessage(events: readonly unknown[]): {
    id: string;
    text: string;
} | null;
/** 一个可投料、等待、可释放销毁的 DSH agent 会话。 */
export interface DshRenderedAgent {
    followup(message: {
        id: string;
        role: string;
        content: unknown;
        source: unknown;
    }): void;
    whenIdle(): Promise<void>;
    /**
     * 读取该 live agent 会话的**实时**事件(即会话已提交的日志)。
     * 若实现提供,executor 优先用它提取回复,避免走持久化 corpus 的滞后;
     * 未提供则回退到 `DshServiceHandles.readSurface(sessionId)`。
     */
    readSurface?(): Promise<readonly unknown[]>;
    /** 销毁该会话底层的 DSH agent(释放资源)。 */
    dispose(): Promise<void>;
    /** 原始 DSH agent 对象;需要调用 host 原生命令服务时使用。 */
    _commandAgent?: unknown;
}
export type DshCommandExecutor = (agent: unknown, line: string) => Promise<string | undefined>;
/**
 * 上下文分段端口 —— 由外部策略(记忆插件)按需注入。
 *
 * 桥接层不知道「一段该多大」「带多少历史」;它只知道两件事:这一轮进模型之前
 * `prepareSession` 是一个安全窗口(上一轮已结束、气泡已发完、下一轮输入未受理),
 * 以及换会话的原语是 `startNewSession`。所以这里只留两个最小的问句,策略留在
 * 调用方。
 *
 * 两个方法都是**可选**的;缺失时 executor 完全退回原行为:同一个 QQ 来源从
 * 创建到卸载只有一个 DSH 会话,与未接线时逐字节相同。
 */
export interface DshSegmentPolicy {
    /**
     * 现在该不该换段。
     *
     * 调用时机:每一轮**进入模型之前**、本来源排队输入已空时精确调用一次
     * (见 `DshAgentExecutor.prepareSession`)。此刻上一轮的 `run()` 已经返回、
     * 气泡全部投递完毕,而下一轮输入还没进来 —— 因此不需要跟投递时序抢时间,
     * 也不会把一条正在生成的消息切成两段。
     *
     * @param sessionKey QQ 来源键。
     * @param sessionId 换段前这一轮原本要用的 DSH 会话 id(尚未建会话时为空串)。
     * @returns 需要换段时返回非空原因(写进日志/状态),否则 undefined。
     */
    shouldStartNewSegment?(sessionKey: string, sessionId: string): string | undefined | Promise<string | undefined>;
    /**
     * 「换段已经发生」的通知,也是带上旧话的唯一时机。
     *
     * 调用时机:换段**已完成之后**、这一轮真正投给模型之前。策略在这里开新段、
     * 记下旧会话 id、准备好带进新段的那几句旧话;桥接层不保存也不解释它的内容。
     * 返回空串表示不带入。这里是通知而不是再次判定:再问一次会让两次判定不一致。
     *
     * @param sessionKey QQ 来源键。
     * @param previousSessionId 刚被归档的旧会话 id。
     * @param sessionId 新会话 id。
     */
    carryOverText?(sessionKey: string, previousSessionId: string, sessionId: string): void | Promise<void>;
}
/**
 * DSH 服务句柄 —— 由插件注入,mock 可注入。
 * getOrCreate 必须返回带 dispose 的 live agent,便于 executor 统一释放。
 */
export interface DshServiceHandles {
    prepareImages?(images: readonly InboundImage[]): Promise<InboundImage[]>;
    /** 按 sessionKey 获取(已有)或创建(miss)一个 live agent。 */
    getOrCreate(options: {
        sessionKey: string;
        sessionId: string;
        resume?: boolean;
        cwd?: string;
        modelSelection: BridgeModelSelectionRef;
    }): Promise<DshRenderedAgent>;
    /**
     * 投递用户消息并等待本轮完成。
     * @param onChunk 可选分段回调:agent 产出过程中的文本增量,便于流式回发。
     */
    deliver(agent: DshRenderedAgent, prompt: string, onChunk?: (text: string, kind: 'text' | 'reasoning') => void, 
    /** 本轮随消息下载好的图片;实现方负责把它们变成 DSH 的 ImageBlock。 */
    images?: readonly InboundImage[]): Promise<{
        messageId: string;
    } | void>;
    /** 读取包含 turn/start/end 的完整会话事件，以定位本轮回复。 */
    readSurface(sessionId: string): Promise<readonly unknown[]>;
}
/**
 * A 内置 handler 的 DSH 实现 —— 多轮上下文版本。
 *
 * - 每个 QQ sessionKey 持有一个常驻 live agent:首次创建、之后复用 → 保留多轮上下文。
 * - 同一 sessionKey 的并发消息串行排队,避免并发驱动同一会话。
 * - disposeAll() 在插件 teardown 时释放全部 live agent。
 * - disposeSession() 可主动丢弃某个会话(如错误恢复、会话上限)。
 */
export declare class DshAgentExecutor implements AgentExecutor, PermissionController, SessionLifecycleController {
    private readonly dsh;
    private opts;
    private agents;
    private sessions;
    private restoredSessions;
    private sessionCwds;
    private sessionVersions;
    private sessionSelections;
    private selectionRefs;
    private queues;
    /** 每个 sessionKey 最近一轮在 DSH 侧的会话与用户消息 id。 */
    private turnIdentities;
    /** 正在进行的换段,按来源去重:并发调用只会真正换一次。 */
    private segmentSwitches;
    /** 最近一次换段的事实,只读输出给状态/排查。 */
    private segmentSwitchesLog;
    /**
     * 本 executor 实例(即一次插件挂载/一次 host boot)唯一的后缀。
     * 避免跨 host 重启复用固定 sessionId 时,与磁盘上残留的旧会话发生 id collision。
     * 同一 boot 内多轮上下文仍通过 sessionKey→sessionId 映射保持。
     */
    private readonly bootSuffix;
    constructor(dsh: DshServiceHandles, opts?: {
        defaultCwd?: string;
        defaultProvider?: string;
        defaultModel?: string;
        defaultReasoningEffort?: string;
        models?: readonly string[];
        resolveModelSelection?: (selection: BridgeModelSelection) => Promise<BridgeModelSelection>;
        listModels?: (provider: string) => Promise<BridgeModelInfo[]>;
        executeCommand?: DshCommandExecutor;
        /** 上下文分段端口;缺失时 executor 行为与未接线时完全一致。 */
        segmentPolicy?: DshSegmentPolicy;
    });
    run(sessionKey: string, payload: string, onChunk?: (text: string, kind: 'text' | 'reasoning') => void, images?: readonly InboundImage[]): Promise<string>;
    /**
     * 每轮进模型前调用一次:先看该不该换段,再给出这一轮真正要用的会话 id。
     *
     * 换段点选在这里,是因为这是整个收发流程里**唯一**同时满足三件事的时刻:
     * 上一轮的 `run()` 已经返回(它 resolve 即本轮完成)、气泡已按投递顺序发完、
     * 而下一轮的输入还没有被受理。因此不必跟投递时序抢时间。
     *
     * 未注入 `segmentPolicy` 时这里只有一次原样的建会话调用,行为与接线前一致。
     *
     * @param sessionKey QQ 来源键。
     * @returns 这一轮应当使用的 DSH 会话 id;刚换过段时就是新的那个。
     */
    prepareSession(sessionKey: string): Promise<string>;
    prepareImages(images: readonly InboundImage[]): Promise<InboundImage[]>;
    retireSessionId(sessionId: string): Promise<void>;
    /**
     * 最近完成的一轮在 DSH 侧的会话与用户消息 id。
     *
     * 只读:两个 id 都由宿主生成,桥接层只是把它们报告给订阅方。没有发生过一轮
     * 时返回 undefined,而不是编造一个。
     */
    lastTurnIdentity(sessionKey: string): {
        sessionId: string;
        messageId: string;
    } | undefined;
    private runNow;
    runPermissionCommand(sessionKey: string, preset?: string): Promise<string>;
    /** 优先读 live agent 的实时会话日志,缺省则退回持久化 surface。 */
    private readEvents;
    /** 主动丢弃某个会话的 live agent。 */
    disposeSession(sessionKey: string): Promise<void>;
    startNewSession(sessionKey: string): Promise<void>;
    /**
     * 按策略判定并在需要时换段。
     *
     * 三条不变量:
     * 1. **未注入策略时零行为变化**:直接返回,不建会话、不问任何问题;
     * 2. 并发调用只真正换一次(按来源去重),否则两条消息会各换一次、白白丢掉
     *    一段还在用的上下文;
     * 3. 换段后调用方必须拿到新 sessionId —— 由 `prepareSession` 保证:换段把
     *    `sessions` 里的映射清掉,紧接着的建会话必然产出新 id。
     *
     * 这里刻意不把换段塞进 `queues`:换段的原语 `disposeSession` 会删掉队列尾巴,
     * 在队列任务内部调用它会让后续消息绕过仍在收尾的这一次。单独的
     * `segmentSwitches` 表既能去重,也不干扰投递队列。
     */
    private maybeStartNewSegment;
    /** 问一次策略、换一个会话、再通知一次。任何一步失败都只记录,不阻断聊天。 */
    private runSegmentSwitch;
    /**
     * 安装/替换段判定端口。
     *
     * 与构造参数二选一:宿主插件之间的启用顺序不确定,构造期往往还拿不到对方的
     * 服务,所以允许在 executor 建好之后再装上。传 undefined 即卸载,之后行为
     * 与从未装过完全一致。
     *
     * @param policy 段判定端口,或 undefined 表示卸载。
     */
    setSegmentPolicy(policy: DshSegmentPolicy | undefined): void;
    /** 最近一次换段的事实;没换过时为 undefined。只读,不产生副作用。 */
    lastSegmentSwitch(sessionKey: string): {
        reason: string;
        previousSessionId: string;
        sessionId: string;
        at: number;
    } | undefined;
    /** 记一行日志,但不要求宿主一定提供 logger。 */
    private loggerFor;
    getSessionVersion(sessionKey: string): number;
    getModelSelection(sessionKey: string): BridgeModelSelection;
    selectModel(sessionKey: string, model: string): Promise<BridgeModelSelection>;
    selectReasoningEffort(sessionKey: string, effort: string): Promise<BridgeModelSelection>;
    listModels(sessionKey: string): Promise<BridgeModelInfo[]>;
    /** 切换某个 QQ 来源的工作目录;下一轮会创建新的 DSH session。 */
    setCwd(sessionKey: string, cwd: string): Promise<void>;
    /** 当前 QQ 来源的工作目录;未切换时返回配置默认目录或 host cwd。 */
    getCwd(sessionKey: string): string;
    /** 释放全部 live agent(插件 teardown 时调用)。 */
    disposeAll(): Promise<void>;
    /**
     * 当前 QQ 会话对应的 DSH session id,尚未建会话时为 undefined。
     *
     * 只读:把「同一 QQ 来源」和「同一 DSH 会话」关联起来,供外部按会话记录或退役;
     * 它不创建会话也不改变映射。
     */
    currentSessionId(sessionKey: string): string | undefined;
    restoreSessions(sessions: readonly {
        sessionKey: string;
        sessionId: string;
    }[]): void;
    get liveSessionCount(): number;
    private enqueue;
    private getOrCreateSessionAgent;
    private createSessionId;
    private selectionRef;
    private setSelection;
    private resolveSelection;
    private defaultSelection;
}
/** 确定性哈希,把任意 sessionKey 映射到固定长度可用的 session id。 */
export declare function hashKey(input: string): string;
