import { resolveConfiguredModels, } from './model-control.js';
/**
 * 提取 session surface 中最后一条 assistant 消息的纯文本。
 *
 * 兼容两种事件形状:
 * - **DSH 真实形状**: `{ type, seq, data: { message: { content: [...] } }, ... }`
 *   (assistant 消息体挂在 `data.message.content`)。
 * - 简易形状(用于本地测试): `{ type: 'assistant/message', content: [...] }`。
 */
export function extractLastAssistantText(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const evt = events[i];
        if (!evt || evt.type !== 'assistant/message')
            continue;
        const blocks = evt.data?.message?.content ?? evt.content;
        if (!Array.isArray(blocks))
            continue;
        const text = blocks
            .filter((b) => {
            const blk = b;
            return !!blk && blk.type === 'text' && typeof blk.text === 'string';
        })
            .map((b) => b.text)
            .join('\n');
        if (text)
            return text;
    }
    return null;
}
/** Read one committed turn without mixing in later followups. */
export function eventsForTurn(events, turn) {
    const start = events.findIndex(event => {
        const row = event;
        return row.type === 'turn/start' && row.data?.turn === turn;
    });
    if (start < 0)
        return [];
    const end = events.findIndex((event, index) => {
        const row = event;
        return index > start && row.type === 'turn/end' && row.data?.turn === turn;
    });
    return events.slice(start, end < 0 ? undefined : end + 1);
}
/**
 * DSH 工具调用没有被运行时识别时,模型可能把 DSML 协议文本当普通 text 输出。
 * 这类内容不是有效回复,也不应透传给 QQ 用户。
 */
export function isUnexecutedDsmlToolCall(text) {
    return text.includes('<｜｜DSML｜｜tool_calls>')
        || text.includes('<||DSML||tool_calls>')
        || /<tool_calls>\s*(?:<tool_calls>\s*)?<invoke\s+name=/i.test(text);
}
/**
 * 提取 session surface 中最后一条 user 消息的 id 与文本。
 *
 * 这是「这次输入」在 DSH 侧的稳定标识:每条用户消息的 id 由宿主生成且唯一,
 * 因此外部可以据此把一次删除/发送与具体的 DSH 轮次对上,而不必猜轮次序号。
 *
 * 兼容两种事件形状(与 `extractLastAssistantText` 同一套):
 * `{ type, data: { message } }` 与简易的 `{ type, content }`。
 */
export function extractLastUserMessage(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const evt = events[i];
        if (!evt || evt.type !== 'user/message')
            continue;
        // Memory or runtime-context injections are user-role but not the speaker's
        // own words; only `source.kind === 'user'` counts.
        if ((evt.data?.source ?? evt.data?.message?.source)?.kind !== 'user')
            continue;
        const message = evt.data?.message ?? evt.data;
        const blocks = message?.content ?? evt.content;
        if (!Array.isArray(blocks))
            continue;
        const text = blocks
            .filter((b) => {
            const blk = b;
            return !!blk && blk.type === 'text' && typeof blk.text === 'string';
        })
            .map((b) => b.text)
            .join('\n');
        const id = typeof message?.id === 'string' ? message.id : '';
        if (id || text)
            return { id, text };
    }
    return null;
}
/**
 * A 内置 handler 的 DSH 实现 —— 多轮上下文版本。
 *
 * - 每个 QQ sessionKey 持有一个常驻 live agent:首次创建、之后复用 → 保留多轮上下文。
 * - 同一 sessionKey 的并发消息串行排队,避免并发驱动同一会话。
 * - disposeAll() 在插件 teardown 时释放全部 live agent。
 * - disposeSession() 可主动丢弃某个会话(如错误恢复、会话上限)。
 */
export class DshAgentExecutor {
    dsh;
    opts;
    agents = new Map();
    sessions = new Map(); // sessionKey -> sessionId
    sessionCwds = new Map();
    sessionVersions = new Map();
    sessionSelections = new Map();
    selectionRefs = new Map();
    queues = new Map();
    /** 每个 sessionKey 最近一轮在 DSH 侧的会话与用户消息 id。 */
    turnIdentities = new Map();
    /**
     * 本 executor 实例(即一次插件挂载/一次 host boot)唯一的后缀。
     * 避免跨 host 重启复用固定 sessionId 时,与磁盘上残留的旧会话发生 id collision。
     * 同一 boot 内多轮上下文仍通过 sessionKey→sessionId 映射保持。
     */
    bootSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    constructor(dsh, opts = {}) {
        this.dsh = dsh;
        this.opts = opts;
    }
    async run(sessionKey, payload, onChunk) {
        return await this.enqueue(sessionKey, () => this.runNow(sessionKey, payload, onChunk));
    }
    async prepareSession(sessionKey) {
        return (await this.getOrCreateSessionAgent(sessionKey)).sessionId;
    }
    async retireSessionId(sessionId) {
        for (const [key, id] of this.sessions) {
            if (id === sessionId) {
                await this.startNewSession(key);
                return;
            }
        }
    }
    /**
     * 最近完成的一轮在 DSH 侧的会话与用户消息 id。
     *
     * 只读:两个 id 都由宿主生成,桥接层只是把它们报告给订阅方。没有发生过一轮
     * 时返回 undefined,而不是编造一个。
     */
    lastTurnIdentity(sessionKey) {
        const record = this.turnIdentities.get(sessionKey);
        if (!record)
            return undefined;
        return { sessionId: record.sessionId, messageId: record.messageId };
    }
    async runNow(sessionKey, payload, onChunk) {
        const { agent, sessionId } = await this.getOrCreateSessionAgent(sessionKey);
        this.turnIdentities.delete(sessionKey);
        const delivered = await this.dsh.deliver(agent, payload, onChunk);
        const surface = await this.readEvents(agent, sessionId);
        let events = surface;
        if (delivered) {
            const inputIndex = surface.findIndex(event => {
                const row = event;
                return row.type === 'user/message' && (row.data?.message ?? row.data)?.id === delivered.messageId;
            });
            const start = [...surface.slice(0, inputIndex)].reverse().find(event => event.type === 'turn/start');
            if (inputIndex < 0 || start?.data?.turn === undefined)
                throw new Error('DSH input turn was not committed');
            events = eventsForTurn(surface, start.data.turn);
            this.turnIdentities.set(sessionKey, { sessionId, messageId: delivered.messageId });
        }
        const lastEnd = [...events].reverse().find(event => event?.type === 'turn/end');
        const reason = lastEnd?.data?.reason;
        if (reason?.kind === 'blocked' || reason?.kind === 'error' || reason?.kind === 'aborted') {
            throw new Error(reason.error?.message ?? `DSH turn ${reason.kind}`);
        }
        // Record the identity of the input this turn actually consumed, before the
        // reply is extracted: a later lookup must not pair a reply with the next
        // turn's input.
        const user = extractLastUserMessage(events);
        if (user?.id)
            this.turnIdentities.set(sessionKey, { sessionId, messageId: user.id });
        const text = extractLastAssistantText(events);
        if (text !== null && isUnexecutedDsmlToolCall(text)) {
            return [
                'agent 生成了一个未被 DSH 执行的工具调用,已拦截原始协议文本。',
                '这通常是当前模型/工具调用模式不匹配导致的。请换用支持 native tool calling 的模型,或调整 DSH_TOOLS_MODE 后重试。',
            ].join('\n');
        }
        if (text === null) {
            // 调试图:提取不到文本时无条件落盘(写到 workspace 内,host 与开发侧都能访问)。
            try {
                const fs = await import('node:fs');
                const dir = '/home/liangyihao/temp/dsh-qq-bridge';
                fs.writeFileSync(`${dir}/.debug-surface.json`, JSON.stringify(events, null, 2));
                try {
                    const persisted = await this.dsh.readSurface(sessionId);
                    fs.writeFileSync(`${dir}/.debug-persisted.json`, JSON.stringify(persisted, null, 2));
                }
                catch { /* noop */ }
            }
            catch { /* noop */ }
        }
        return text ?? '(agent produced no text)';
    }
    async runPermissionCommand(sessionKey, preset) {
        return await this.enqueue(sessionKey, async () => {
            if (!this.opts.executeCommand)
                return '当前 host 不支持权限切换。';
            const { agent } = await this.getOrCreateSessionAgent(sessionKey);
            const line = preset?.trim() ? `/permission ${preset.trim()}` : '/permission';
            const text = await this.opts.executeCommand(agent._commandAgent ?? agent, line);
            return text ?? '当前 host 不支持权限切换。';
        });
    }
    /** 优先读 live agent 的实时会话日志,缺省则退回持久化 surface。 */
    async readEvents(agent, sessionId) {
        if (typeof agent.readSurface === 'function') {
            const live = await agent.readSurface();
            if (live && live.length)
                return live;
        }
        return this.dsh.readSurface(sessionId);
    }
    /** 主动丢弃某个会话的 live agent。 */
    async disposeSession(sessionKey) {
        const agent = this.agents.get(sessionKey);
        if (agent) {
            this.agents.delete(sessionKey);
            await agent.dispose();
        }
        this.sessions.delete(sessionKey);
        this.queues.delete(sessionKey);
        // The identity belonged to the session that is gone; a new session must not
        // inherit it.
        this.turnIdentities.delete(sessionKey);
    }
    async startNewSession(sessionKey) {
        this.sessionVersions.set(sessionKey, this.getSessionVersion(sessionKey) + 1);
        await this.disposeSession(sessionKey);
    }
    getSessionVersion(sessionKey) {
        return this.sessionVersions.get(sessionKey) ?? 0;
    }
    getModelSelection(sessionKey) {
        return this.selectionRef(sessionKey).current;
    }
    async selectModel(sessionKey, model) {
        const current = this.getModelSelection(sessionKey);
        const selected = await this.resolveSelection({
            provider: current.provider,
            model,
        });
        this.setSelection(sessionKey, selected);
        return selected;
    }
    async selectReasoningEffort(sessionKey, effort) {
        const current = this.getModelSelection(sessionKey);
        const selected = await this.resolveSelection({
            provider: current.provider,
            model: current.model,
            reasoningEffort: effort,
        });
        this.setSelection(sessionKey, selected);
        return selected;
    }
    async listModels(sessionKey) {
        const provider = this.getModelSelection(sessionKey).provider;
        if (this.opts.listModels) {
            const models = await this.opts.listModels(provider);
            if (models.length > 0)
                return models;
        }
        return resolveConfiguredModels(this.opts.defaultModel ?? 'deepseek-v4-flash', this.opts.models)
            .map(id => ({ provider, id, name: id }));
    }
    /** 切换某个 QQ 来源的工作目录;下一轮会创建新的 DSH session。 */
    async setCwd(sessionKey, cwd) {
        this.sessionCwds.set(sessionKey, cwd);
        await this.startNewSession(sessionKey);
    }
    /** 当前 QQ 来源的工作目录;未切换时返回配置默认目录或 host cwd。 */
    getCwd(sessionKey) {
        return this.sessionCwds.get(sessionKey) ?? this.opts.defaultCwd ?? process.cwd();
    }
    /** 释放全部 live agent(插件 teardown 时调用)。 */
    async disposeAll() {
        const agents = [...this.agents.values()];
        this.agents.clear();
        this.sessions.clear();
        this.sessionCwds.clear();
        this.sessionVersions.clear();
        this.sessionSelections.clear();
        this.selectionRefs.clear();
        this.queues.clear();
        this.turnIdentities.clear();
        await Promise.all(agents.map((a) => a.dispose()));
    }
    /**
     * 当前 QQ 会话对应的 DSH session id,尚未建会话时为 undefined。
     *
     * 只读:把「同一 QQ 来源」和「同一 DSH 会话」关联起来,供外部按会话记录或退役;
     * 它不创建会话也不改变映射。
     */
    currentSessionId(sessionKey) {
        return this.sessions.get(sessionKey);
    }
    get liveSessionCount() {
        return this.agents.size;
    }
    async enqueue(sessionKey, task) {
        const prev = this.queues.get(sessionKey) ?? Promise.resolve();
        const next = prev.then(task);
        // 吞掉队列尾部错误,避免串行链断掉后续消息
        this.queues.set(sessionKey, next.then(() => undefined, () => undefined));
        return await next;
    }
    async getOrCreateSessionAgent(sessionKey) {
        const sessionIdExists = this.sessions.get(sessionKey);
        const sessionId = sessionIdExists ?? this.createSessionId(sessionKey);
        this.sessions.set(sessionKey, sessionId);
        let agent = this.agents.get(sessionKey);
        if (!agent) {
            agent = await this.dsh.getOrCreate({
                sessionKey,
                sessionId,
                cwd: this.sessionCwds.get(sessionKey) ?? this.opts.defaultCwd,
                modelSelection: this.selectionRef(sessionKey),
            });
            this.agents.set(sessionKey, agent);
        }
        return { agent, sessionId };
    }
    createSessionId(sessionKey) {
        const version = this.sessionVersions.get(sessionKey) ?? 0;
        return `qq-${hashKey(sessionKey)}-${this.bootSuffix}-${version}`;
    }
    selectionRef(sessionKey) {
        const existing = this.selectionRefs.get(sessionKey);
        if (existing)
            return existing;
        const ref = {
            current: this.sessionSelections.get(sessionKey) ?? this.defaultSelection(),
        };
        this.selectionRefs.set(sessionKey, ref);
        return ref;
    }
    setSelection(sessionKey, selection) {
        this.sessionSelections.set(sessionKey, selection);
        this.selectionRef(sessionKey).current = selection;
    }
    async resolveSelection(selection) {
        if (this.opts.resolveModelSelection)
            return await this.opts.resolveModelSelection(selection);
        return selection;
    }
    defaultSelection() {
        return {
            provider: this.opts.defaultProvider ?? 'deepseek-official',
            model: this.opts.defaultModel ?? 'deepseek-v4-flash',
            // 显式默认思考强度:不传时,部分 provider(裸 openai-completions)会完全不
            // 思考,表现为"同一个模型在 QQ 里变笨"。配置留空则保持适配器自身行为。
            ...(this.opts.defaultReasoningEffort
                ? { reasoningEffort: this.opts.defaultReasoningEffort }
                : {}),
        };
    }
}
/** 确定性哈希,把任意 sessionKey 映射到固定长度可用的 session id。 */
export function hashKey(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}
