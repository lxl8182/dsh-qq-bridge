import { QqSessionArchivedError } from './agent.js';
import { roleSessionKeyOf } from './role-chat.js';
import { parseQqControlBlocks, parseQqSpells } from './control.js';
import { resolveConfiguredModels, } from './model-control.js';
export const QQ_RESEARCH_SOURCE = 'companion-research';
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
/** 一轮内完成的可见消息按首次出现顺序合并，相同消息 ID 只采用最后的完整版本。 */
export function extractAssistantText(events) {
    const messages = new Map();
    for (const [index, event] of events.entries()) {
        const row = event;
        if (row.type !== 'assistant/message')
            continue;
        const id = row.data?.message?.id ?? index;
        if (row.data?.interrupted) {
            messages.delete(id);
            continue;
        }
        const text = extractLastAssistantText([event]);
        if (text && !isUnexecutedDsmlToolCall(text))
            messages.set(id, text);
        else
            messages.delete(id);
    }
    return messages.size ? [...messages.values()].join('\n') : null;
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
    restoredSessions = new Set();
    sessionCwds = new Map();
    sessionVersions = new Map();
    sessionSelections = new Map();
    selectionRefs = new Map();
    roleContexts = new Map();
    queues = new Map();
    stopped = false;
    /** 每个 sessionKey 最近一轮在 DSH 侧的会话与用户消息 id。 */
    turnIdentities = new Map();
    /** 最近一次换段的事实,只读输出给状态/排查。 */
    segmentSwitchesLog = new Map();
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
    async run(sessionKey, payload, onChunk, images, expectedSessionId) {
        return await this.enqueue(sessionKey, () => this.runNow(sessionKey, payload, onChunk, images, undefined, expectedSessionId));
    }
    async runRole(sessionKey, role, turn) {
        const roleKey = roleSessionKeyOf(sessionKey, role.id);
        return await this.enqueue(roleKey, () => this.runNow(roleKey, '', undefined, undefined, turn));
    }
    async ensureRoleSession(sessionKey, role) {
        const roleKey = roleSessionKeyOf(sessionKey, role.id);
        return await this.enqueue(roleKey, async () => {
            if (!this.agents.has(roleKey)) {
                const selection = await this.resolveSelection({
                    provider: role.provider.trim(),
                    model: role.model.trim(),
                    ...(role.reasoningEffort.trim() ? { reasoningEffort: role.reasoningEffort.trim() } : {}),
                });
                this.setSelection(roleKey, selection);
                this.roleContexts.set(roleKey, { persona: role.persona });
            }
            const { agent, sessionId } = await this.getOrCreateSessionAgent(roleKey);
            if (!agent.replaceRoleSession)
                return sessionId;
            // Keep the QQ transcript when the old role session cannot run with the bridge's isolated prompt
            // or lacks the immutable cwd required by DSH's history API.
            await this.archiveRoleSessionNow(roleKey, sessionId);
            this.roleContexts.set(roleKey, { persona: role.persona });
            return (await this.getOrCreateSessionAgent(roleKey)).sessionId;
        });
    }
    async archiveRoleSession(sessionKey, roleId, sessionId) {
        const roleKey = roleSessionKeyOf(sessionKey, roleId);
        await this.enqueue(roleKey, () => this.archiveRoleSessionNow(roleKey, sessionId));
    }
    async archiveRoleSessionNow(roleKey, sessionId) {
        if (!this.dsh.archiveSession)
            throw new Error('当前 DSH host 不支持归档角色会话。');
        await this.dsh.archiveSession(sessionId);
        if (this.sessions.get(roleKey) === sessionId)
            await this.resetSession(roleKey);
    }
    isSessionArchived(sessionId) {
        return this.dsh.isSessionArchived?.(sessionId) === true;
    }
    /** 进模型前检查归档和段策略，再返回本轮要绑定的会话。 */
    async prepareSession(sessionKey, input) {
        return this.enqueue(sessionKey, async () => {
            const sessionId = await this.openSession(sessionKey);
            if (!input)
                return sessionId;
            return this.runSegmentSwitch(sessionKey, sessionId, input);
        });
    }
    async prepareImages(images) {
        return this.dsh.prepareImages ? this.dsh.prepareImages(images) : [...images];
    }
    async retireSessionId(sessionId) {
        for (const [key, id] of this.sessions) {
            if (id !== sessionId)
                continue;
            await this.enqueue(key, async () => {
                if (this.sessions.get(key) === sessionId)
                    await this.resetSession(key);
            });
            return;
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
    async runNow(sessionKey, payload, onChunk, images, roleTurn, expectedSessionId) {
        const previous = expectedSessionId ?? this.sessions.get(sessionKey);
        if (previous && this.isSessionArchived(previous) && (expectedSessionId || roleTurn)) {
            throw new QqSessionArchivedError();
        }
        if (!expectedSessionId && !roleTurn)
            await this.resetArchivedSession(sessionKey);
        const { agent, sessionId } = await this.getOrCreateSessionAgent(sessionKey);
        if (expectedSessionId && expectedSessionId !== sessionId)
            throw new Error('QQ 会话已切换，请重试这条消息。');
        this.turnIdentities.delete(sessionKey);
        const previousEventCount = (await this.readEvents(agent, sessionId)).length;
        const delivered = roleTurn
            ? await this.dsh.deliver(agent, payload, onChunk, images, roleTurn)
            : await this.dsh.deliver(agent, payload, onChunk, images);
        const surface = await this.readEvents(agent, sessionId);
        let events = surface;
        let inputCommitted = !delivered;
        if (delivered) {
            const inputIndex = surface.findIndex(event => {
                const row = event;
                return row.type === 'user/message' && (row.data?.message ?? row.data)?.id === delivered.messageId;
            });
            const start = [...surface.slice(0, inputIndex)].reverse().find(event => event.type === 'turn/start');
            if (inputIndex >= 0 && start?.data?.turn !== undefined) {
                events = eventsForTurn(surface, start.data.turn);
                inputCommitted = true;
                this.turnIdentities.set(sessionKey, { sessionId, messageId: delivered.messageId });
            }
            else {
                // 准入失败可能在 user/message 提交前结束；先报告本次的真实错误。
                events = surface.slice(previousEventCount);
            }
        }
        const lastEnd = [...events].reverse().find(event => event?.type === 'turn/end');
        const reason = lastEnd?.data?.reason;
        if ((reason?.kind === 'blocked' || reason?.kind === 'aborted')
            && !inputCommitted && this.isSessionArchived(sessionId)) {
            throw new QqSessionArchivedError();
        }
        if (reason?.kind === 'blocked' || reason?.kind === 'error' || reason?.kind === 'aborted') {
            throw new Error(reason.error?.message ?? `DSH turn ${reason.kind}`);
        }
        if (!inputCommitted)
            throw new Error('DSH input turn was not committed');
        // Record the identity of the input this turn actually consumed, before the
        // reply is extracted: a later lookup must not pair a reply with the next
        // turn's input.
        const user = extractLastUserMessage(events);
        if (user?.id)
            this.turnIdentities.set(sessionKey, { sessionId, messageId: user.id });
        const text = extractAssistantText(events);
        if (roleTurn)
            return text ?? '';
        if (text && user?.id && this.opts.resolveResearch) {
            const feedback = await this.opts.resolveResearch(sessionId, text);
            if (feedback) {
                const [lookup] = parseQqSpells(text).spells;
                const instruction = lookup?.spell === '翻本子'
                    ? '我已经翻过本子，接下来用这些回忆回答原来的问题。'
                    : '这次查询已结束。我根据收到的资料直接回答原问题，附上支持具体结论的来源链接。';
                const id = `research:${user.id}`;
                const afterFirst = surface.length;
                agent.followup({ id, role: 'user', source: { kind: QQ_RESEARCH_SOURCE, history: feedback.history, spell: lookup?.spell },
                    content: [{ type: 'text', text: feedback.text + '\n' + instruction }] });
                await agent.whenIdle();
                const continued = (await this.readEvents(agent, sessionId)).slice(afterFirst);
                const index = continued.findIndex(event => {
                    const row = event;
                    return row.type === 'user/message' && (row.data?.message ?? row.data)?.id === id;
                });
                const start = [...continued.slice(0, Math.max(0, index))].reverse().find(event => event.type === 'turn/start');
                const turn = start?.data?.turn;
                if (turn === undefined)
                    throw new Error('资料已返回，回复未完成。');
                const finalEvents = eventsForTurn(continued, turn);
                const end = finalEvents.at(-1);
                const answer = parseQqControlBlocks(parseQqSpells(extractAssistantText(finalEvents) ?? '').visibleText).visibleText;
                if (end?.type !== 'turn/end' || end.data?.reason?.kind !== 'completed') {
                    throw new Error('资料已返回，回复未完成。');
                }
                if (!answer)
                    return '这次查询还没整理出可靠的答复。';
                const cited = new Set(Array.from(answer.matchAll(/\[(\d+)\]/gu), match => match[1]));
                const links = Array.from(feedback.history.matchAll(/^(\d+)\. (.+)\n(https?:\/\/\S+)$/gmu))
                    .filter(([, number, , url]) => cited.has(number) && !answer.includes(url))
                    .map(([, number, title, url]) => `[${number}] ${title}\n${url}`);
                return links.length ? `${answer}\n\n${links.join('\n')}` : answer;
            }
        }
        if (text === null && events.some(event => isUnexecutedDsmlToolCall(extractLastAssistantText([event]) ?? ''))) {
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
            await this.resetArchivedSession(sessionKey);
            const { agent } = await this.getOrCreateSessionAgent(sessionKey);
            const line = preset?.trim() ? `/permission ${preset.trim()}` : '/permission';
            const text = await this.opts.executeCommand(agent._commandAgent ?? agent, line);
            return text ?? '当前 host 不支持权限切换。';
        });
    }
    /** 优先读 live agent 的实时会话日志,缺省则退回持久化 surface。 */
    async readEvents(agent, sessionId) {
        if (agent.readSurface)
            return agent.readSurface();
        return this.dsh.readSurface(sessionId);
    }
    /** 释放 Agent，等宿主关闭写句柄后再清除旧映射。 */
    async disposeSession(sessionKey) {
        await this.enqueue(sessionKey, () => this.resetSession(sessionKey));
    }
    async startNewSession(sessionKey) {
        await this.disposeSession(sessionKey);
    }
    async resetSession(sessionKey) {
        const agent = this.agents.get(sessionKey);
        if (agent)
            await agent.dispose();
        this.agents.delete(sessionKey);
        this.sessions.delete(sessionKey);
        this.restoredSessions.delete(sessionKey);
        this.roleContexts.delete(sessionKey);
        this.turnIdentities.delete(sessionKey);
        this.sessionVersions.set(sessionKey, this.getSessionVersion(sessionKey) + 1);
    }
    async openSession(sessionKey) {
        await this.resetArchivedSession(sessionKey);
        return (await this.getOrCreateSessionAgent(sessionKey)).sessionId;
    }
    async resetArchivedSession(sessionKey) {
        const previous = this.sessions.get(sessionKey);
        if (previous && this.isSessionArchived(previous)) {
            await this.resetSession(sessionKey);
            this.segmentSwitchesLog.delete(sessionKey);
            this.loggerFor('[dsh-qq-bridge] starting a new QQ session after archive: ' + previous);
        }
    }
    async runSegmentSwitch(sessionKey, previousSessionId, input) {
        const policy = this.opts.segmentPolicy;
        if (!policy?.shouldStartNewSegment)
            return previousSessionId;
        let reason;
        try {
            reason = (await policy.shouldStartNewSegment(sessionKey, previousSessionId, input)) ?? undefined;
        }
        catch (error) {
            this.loggerFor('[dsh-qq-bridge] segment policy failed: ' + messageOf(error));
        }
        if (this.isSessionArchived(previousSessionId))
            return this.openSession(sessionKey);
        if (!reason)
            return previousSessionId;
        await this.resetSession(sessionKey);
        const { sessionId } = await this.getOrCreateSessionAgent(sessionKey);
        this.segmentSwitchesLog.set(sessionKey, { reason, previousSessionId, sessionId, at: Date.now() });
        this.loggerFor('[dsh-qq-bridge] segment switched (' + reason + '): ' + sessionKey + ' ' + previousSessionId + ' -> ' + sessionId);
        try {
            await policy.carryOverText?.(sessionKey, previousSessionId, sessionId, reason);
        }
        catch (error) {
            this.loggerFor('[dsh-qq-bridge] segment carry-over failed: ' + messageOf(error));
        }
        return sessionId;
    }
    /**
     * 安装/替换段判定端口。
     *
     * 与构造参数二选一:宿主插件之间的启用顺序不确定,构造期往往还拿不到对方的
     * 服务,所以允许在 executor 建好之后再装上。传 undefined 即卸载,之后行为
     * 与从未装过完全一致。
     *
     * @param policy 段判定端口,或 undefined 表示卸载。
     */
    setSegmentPolicy(policy) {
        this.opts.segmentPolicy = policy;
        if (!policy)
            this.segmentSwitchesLog.clear();
    }
    /** 最近一次换段的事实;没换过时为 undefined。只读,不产生副作用。 */
    lastSegmentSwitch(sessionKey) {
        const record = this.segmentSwitchesLog.get(sessionKey);
        return record ? { ...record } : undefined;
    }
    /** 记一行日志,但不要求宿主一定提供 logger。 */
    loggerFor(line) {
        try {
            console.warn(line);
        }
        catch { /* logging must never break a turn */ }
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
        await this.enqueue(sessionKey, async () => {
            this.sessionCwds.set(sessionKey, cwd);
            await this.resetSession(sessionKey);
        });
    }
    /** 当前 QQ 来源的工作目录;未切换时返回配置默认目录或 host cwd。 */
    getCwd(sessionKey) {
        return this.sessionCwds.get(sessionKey) ?? this.opts.defaultCwd ?? process.cwd();
    }
    /** 释放全部 live agent(插件 teardown 时调用)。 */
    async disposeAll() {
        this.stopped = true;
        const close = Promise.allSettled([...this.agents.values()].map(agent => agent.dispose()));
        await Promise.all(this.queues.values());
        const results = await close;
        this.agents.clear();
        this.sessions.clear();
        this.restoredSessions.clear();
        this.sessionCwds.clear();
        this.sessionVersions.clear();
        this.sessionSelections.clear();
        this.selectionRefs.clear();
        this.roleContexts.clear();
        this.queues.clear();
        this.turnIdentities.clear();
        this.segmentSwitchesLog.clear();
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length)
            throw new AggregateError(errors, 'QQ 会话释放失败。');
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
    restoreSessions(sessions) {
        for (const { sessionKey, sessionId } of sessions) {
            if (!this.sessions.has(sessionKey)) {
                this.sessions.set(sessionKey, sessionId);
                this.restoredSessions.add(sessionKey);
            }
        }
    }
    get liveSessionCount() {
        return this.agents.size;
    }
    async enqueue(sessionKey, task) {
        const next = (this.queues.get(sessionKey) ?? Promise.resolve()).then(() => {
            if (this.stopped)
                throw new Error('QQ 会话执行器已关闭。');
            return task();
        });
        const tail = next.then(() => undefined, () => undefined);
        this.queues.set(sessionKey, tail);
        try {
            return await next;
        }
        finally {
            if (this.queues.get(sessionKey) === tail)
                this.queues.delete(sessionKey);
        }
    }
    async getOrCreateSessionAgent(sessionKey) {
        const sessionIdExists = this.sessions.get(sessionKey);
        const sessionId = sessionIdExists ?? this.createSessionId(sessionKey);
        let agent = this.agents.get(sessionKey);
        if (agent?.isLive?.() === false) {
            this.agents.delete(sessionKey);
            this.restoredSessions.add(sessionKey);
            await agent.dispose();
            agent = undefined;
        }
        if (!agent) {
            const roleContext = this.roleContexts.get(sessionKey);
            if (!roleContext)
                this.sessions.set(sessionKey, sessionId);
            agent = await this.dsh.getOrCreate({
                sessionKey,
                sessionId,
                resume: this.restoredSessions.has(sessionKey),
                cwd: roleContext ? undefined : this.sessionCwds.get(sessionKey) ?? this.opts.defaultCwd,
                modelSelection: this.selectionRef(sessionKey),
                ...(roleContext ? { roleContext } : {}),
            });
            if (this.stopped) {
                await agent.dispose();
                throw new Error('QQ 会话执行器已关闭。');
            }
            if (roleContext)
                this.sessions.set(sessionKey, sessionId);
            this.agents.set(sessionKey, agent);
            this.restoredSessions.delete(sessionKey);
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
/** 把任意抛出物收敛成一行可读原因。 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
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
