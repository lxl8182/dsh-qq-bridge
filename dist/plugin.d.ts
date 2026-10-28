import { AgentRpcHandler } from './handlers/agent.js';
import { DshAgentExecutor } from './handlers/dsh-executor.js';
import type { DshStorageDomainRuntime } from './handlers/custom-memory.js';
import { BridgeModelSelection } from './handlers/model-control.js';
import { DshQqBridgeConfig } from './config.js';
import { OnebotMessageEvent, PlatformReplyTarget } from './onebot/types.js';
import type { MessageTargetId } from './onebot/types.js';
import { InteractionCtxLike, QqInteractionBridge } from './interactions.js';
import type { BridgeConfigRef } from './settings.js';
import { QqBridgeEvents } from './bridge-events.js';
import type { DshSegmentPolicy } from './handlers/dsh-executor.js';
/** DSH live agent 最小画面。 */
interface DshAgent {
    session: DshSessionSubject;
    followup(message: {
        id: string;
        role: string;
        content: unknown;
        source: unknown;
    }): void;
    whenIdle(): Promise<void>;
}
/** 结构性描述 DSH 服务;不硬依赖 DSH 内部类型。 */
interface DshCtx extends InteractionCtxLike {
    profileContext?: {
        home: string;
    };
    get?(name: string): unknown;
    agentLoop?: {
        createAgent(ownerCtx: unknown, options: {
            sessionId: string;
            agentOptions?: Record<string, unknown>;
            meta?: {
                cwd?: string;
                agentPreset?: string;
            };
            setup?: (agentCtx: unknown) => void | Promise<void>;
        }): Promise<{
            agent: DshAgent;
            dispose(): Promise<void>;
        }>;
    };
    agentPresets?: {
        mount(agentCtx: unknown, preset?: string): Promise<void>;
    };
    sessionQuery?: {
        readSession(sessionId: string): Promise<{
            events: readonly unknown[];
        }>;
    };
    workspaceRegistry?: DshWorkspaceRegistry;
    llm?: DshLlmRuntime;
    commands?: DshCommandRuntime;
    storageDomain?: DshStorageDomainRuntime;
    on?(event: 'session/event', cb: (subject: DshSessionSubject, event: unknown) => void, options?: {
        prepend?: boolean;
    }): () => void;
    on?(event: 'approval/request', cb: (...args: never[]) => unknown, options?: {
        prepend?: boolean;
    }): () => void;
    on?(event: string, cb: (...args: never[]) => unknown, options?: {
        prepend?: boolean;
    }): () => void;
}
interface DshLlmRuntime {
    listProviders?(): Array<{
        id: string;
        name?: string;
    }>;
    listModels?(provider: string): Promise<Array<{
        provider?: string;
        id: string;
        name?: string;
    }>>;
    resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{
        provider?: string;
        id?: string;
        name?: string;
        reasoning?: {
            efforts: ReadonlyArray<{
                id: string;
                name?: string;
                description?: string;
            }>;
            defaultEffort?: string;
        };
    }>;
    resolveCallConfig?(config: BridgeModelSelection, signal?: AbortSignal): Promise<BridgeModelSelection>;
}
interface DshCommandRuntime {
    execute(agent: unknown, line: string, images: readonly unknown[], signal: AbortSignal): Promise<undefined | {
        result?: {
            kind?: string;
            text?: string;
        };
    }>;
}
export interface DshWorkspace {
    id?: string;
    attachSession(sessionId: string): Promise<void>;
}
export interface DshWorkspaceRegistry {
    create(path: string): Promise<DshWorkspace>;
}
interface DshSessionSubject {
    id?: string;
    header?: {
        origin?: string;
    };
    snapshotEvents(): readonly unknown[];
}
interface BridgeChatClient {
    connect(): Promise<void>;
    onMessage(cb: (evt: OnebotMessageEvent) => void): () => void;
    sendPrivate(userId: MessageTargetId, message: string, replyTarget?: PlatformReplyTarget): Promise<unknown>;
    sendPrivateAndWait?(userId: MessageTargetId, message: string, timeoutMs: number, uid: string): Promise<unknown>;
    sendGroup(groupId: MessageTargetId, message: string, replyTarget?: PlatformReplyTarget): Promise<unknown>;
    disconnect(): Promise<void>;
}
/**
 * Cordis 插件入口(Host 侧)。
 * M3:每个 QQ 会话持有常驻 DSH live agent,实现多轮上下文。
 * 依赖:agentLoop / agentPresets / sessionQuery。
 */
export declare const Config: unknown;
export declare const name = "dsh-qq-bridge";
export declare const inject: string[];
export declare function apply(ctx: DshCtx, options: DshQqBridgeConfig | BridgeConfigRef): Promise<() => Promise<void>>;
declare const _default: {
    name: string;
    inject: string[];
    Config: unknown;
    apply: typeof apply;
};
export default _default;
/** 判断是否启用 agent 完成后的管理员主动提醒。 */
export declare function agentReplyNotificationsEnabled(cfg: DshQqBridgeConfig): boolean;
/**
 * 从一个平台动作响应里取出消息 id。
 *
 * 官方 SDK 返回对象里 id 的键名随版本变化(c2c/group 都可能带 `id`、
 * `messageId` 或 `msgId`),NapCat 用 OneBot 的 `data.message_id`。这里只做只读
 * 提取:取不到就是取不到,不合成假 id。
 */
export declare function readPlatformMessageId(result: unknown): string | undefined;
export declare function makeDshExecutor(ctx: DshCtx, agentCfg?: {
    preset?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    models?: readonly string[];
    cwd?: string;
}, interactions?: QqInteractionBridge, attachWorkspace?: (sessionId: string, cwd: string) => Promise<void>, llm?: () => DshLlmRuntime | undefined, commands?: () => DshCommandRuntime | undefined): DshAgentExecutor;
/** 段判定端口的安装点;只需要这一个方法,便于测试注入假 executor。 */
type SegmentPolicyTarget = {
    setSegmentPolicy(policy: DshSegmentPolicy | undefined): void;
};
/**
 * 取用记忆插件发布的段端口,并装到 executor 上。
 *
 * 方向与 `qqBridgeEvents` 相反:那边是桥接对外发布,这边是记忆插件发布、桥接取用。
 * 两个插件由宿主按各自顺序启用,谁先谁后都不确定,所以不能只在启动时 get 一次 ——
 * 与 llm/commands/storageDomain 一样用可选 fiber,端口换实现或消失时跟着重装/卸载。
 *
 * 服务缺失时什么都不做:executor 完全退回原行为(一个 QQ 来源一个会话)。
 * 注意 module 级 `inject` 里**不能**加它 —— 那会变成硬依赖,并可能与 qqBridgeEvents 成环。
 */
export declare function createSegmentPolicyAccess(ctx: DshCtx, executor: SegmentPolicyTarget): {
    dispose(): void;
};
export declare function attachSessionToWorkspace(registry: DshWorkspaceRegistry, sessionId: string, cwd: string): Promise<void>;
/** Forward completed followups only for sessions bound by an admitted QQ input. */
export declare function registerQqSessionOutput(ctx: Pick<DshCtx, 'on'>, executor: Pick<DshAgentExecutor, 'currentSessionId'>, bridge: QqBridgeEvents | undefined, handler: Pick<AgentRpcHandler, 'sendSessionOutput'>): () => void;
export declare function createAgentReplyNotifier(ctx: Pick<DshCtx, 'on'>, client: Pick<BridgeChatClient, 'sendPrivate'>, adminTarget: MessageTargetId): () => void;
/** 监听 DSH 会话完成事件,向管理员 QQ 发送一条轻量提醒。 */
export declare function registerAgentReplyNotifier(ctx: Pick<DshCtx, 'on'>, client: Pick<BridgeChatClient, 'sendPrivate'>, adminTarget: MessageTargetId): () => void;
export declare function findSessionTitle(events: readonly unknown[]): string;
/** 构建官方机器人连接失败时的引导文案。 */
export declare function buildOfficialConnectGuidance(cfg: DshQqBridgeConfig, err: unknown): string;
/** 构建连接失败时的引导文案,指向「给 Agent 的 NapCat 安装向导」。 */
export declare function buildConnectGuidance(cfg: DshQqBridgeConfig, err: unknown): string;
