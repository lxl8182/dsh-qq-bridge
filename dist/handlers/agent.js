import { parseQqControlBlocks, parseQqSpells, } from './control.js';
import { DeliveryStore } from '../delivery-store.js';
/**
 * 历史配置字段 qqReplyStyleSkill 的默认 skill 名。
 *
 * 配置仍然解析(旧 profile 不会因此报错),但桥接层不再用它注入任何 prompt:
 * QQ 入站消息的原文逐字交给 Agent,不附加来源说明、临时风格标记或自动 skill 调用。
 */
export const DEFAULT_QQ_REPLY_STYLE_SKILL_NAME = 'qq-session-reply-style';
export function sessionKeyOf(ctx) {
    return `${ctx.scope}:${ctx.scope === 'private' ? ctx.userId : ctx.groupId}`;
}
/**
 * 把文本按最大长度切分为多条,保证每条不超过 maxLen。
 * 优先在换行/标点附近切(保持可读),实在没有边界则硬切。
 */
export function splitText(text, maxLen) {
    if (maxLen <= 0 || text.length <= maxLen)
        return text === '' ? [] : [text];
    const parts = [];
    let rest = text;
    while (rest.length > maxLen) {
        // 在 maxLen-1 往前找最近的换行或标点作为切点(留一位容纳标点)
        const searchTo = maxLen - 1;
        let cut = rest.lastIndexOf('\n', searchTo);
        if (cut <= 0)
            cut = Math.max(rest.lastIndexOf('。', searchTo), rest.lastIndexOf('！', searchTo), rest.lastIndexOf('？', searchTo), rest.lastIndexOf('.', searchTo), rest.lastIndexOf('，', searchTo), rest.lastIndexOf(',', searchTo));
        if (cut <= 0)
            cut = searchTo; // 无边界,硬切(maxLen-1,保证 <= maxLen)
        parts.push(rest.slice(0, cut + 1).trimStart());
        rest = rest.slice(cut + 1);
    }
    if (rest.trim())
        parts.push(rest.trimStart());
    return parts.filter((p) => p.length > 0);
}
/**
 * A 内置 handler:QQ 消息 → 遥控 DSH Agent → 回发。
 */
export class AgentRpcHandler {
    executor;
    opts;
    name = 'agent';
    delivery;
    active = new WeakMap();
    queues = new Map();
    stopped = false;
    constructor(executor, opts = {}) {
        this.executor = executor;
        this.opts = opts;
        this.delivery = new DeliveryStore(opts.deliveryStatePath);
    }
    async open() { await this.delivery.open(); }
    async dispose() { this.stopped = true; await this.delivery.save(); }
    completedReports() {
        return Object.values(this.delivery.turns).flatMap(turn => turn.report ? [turn.report] : []);
    }
    async retireSession(sessionId) {
        for (const turn of Object.values(this.delivery.turns)) {
            if (turn.sessionId !== sessionId && turn.report?.sessionId !== sessionId)
                continue;
            if (turn.state === 'waiting') {
                delete turn.sessionId;
                turn.parts = [];
                continue;
            }
            turn.retired = true;
            turn.state = 'complete';
            turn.input.payload = '';
            turn.parts = [];
            delete turn.report;
        }
        await this.delivery.save();
    }
    enqueue(key, run) {
        const next = (this.queues.get(key) ?? Promise.resolve()).then(run);
        const settled = next.catch(() => { });
        this.queues.set(key, settled);
        void settled.then(() => { if (this.queues.get(key) === settled)
            this.queues.delete(key); });
        return next;
    }
    async retryPending() {
        if (this.stopped || !this.opts.restoreContext)
            return;
        for (const turn of Object.values(this.delivery.turns)) {
            if (turn.state !== 'waiting' && turn.state !== 'output')
                continue;
            const ctx = this.opts.restoreContext(turn.input);
            if (!ctx) {
                turn.state = 'failed';
                await this.delivery.save();
                continue;
            }
            await this.enqueue(sessionKeyOf(ctx), async () => {
                if (this.stopped)
                    return;
                if (turn.state === 'waiting')
                    await this.process(ctx, turn);
                else if (turn.state === 'output') {
                    for (const part of turn.parts)
                        if (part.state === 'pending')
                            await this.sendPart(ctx, part);
                    await this.finishDelivery(turn);
                }
            });
        }
    }
    /** Session followups have no inbound HandlerContext; reuse durable delivery. */
    async sendSessionOutput(input, turnNumber, result) {
        if (this.stopped || !input.sessionId || !this.opts.restoreContext)
            return;
        const ctx = this.opts.restoreContext({ scope: input.scope, userId: input.userId,
            groupId: input.groupId, owner: input.owner, payload: '',
            messageId: `dsh-output:${input.sessionId}:${turnNumber}` });
        if (!ctx)
            return;
        await this.enqueue(input.sessionKey, async () => {
            if (this.stopped || this.opts.sessionIdOf?.(input.sessionKey) !== input.sessionId)
                return;
            const visible = parseQqControlBlocks(parseQqSpells(result).visibleText).visibleText;
            const parts = splitText(visible, this.opts.maxMessageLength ?? 4500)
                .map(text => ({ text, kind: 'reply', state: 'pending' }));
            // The first persisted state already contains the output. A crash must
            // never turn generated feedback into an empty input waiting for a model.
            const { turn, duplicate } = await this.delivery.accept(ctx, { sessionId: input.sessionId, parts });
            if (duplicate)
                return;
            this.active.set(ctx, turn);
            try {
                // No user-turn report: feedback is not a new statement by the user.
                for (const part of turn.parts)
                    await this.sendPart(ctx, part);
                await this.finishDelivery(turn);
            }
            finally {
                this.active.delete(ctx);
            }
        });
    }
    async sendPart(ctx, part) {
        if (this.stopped || this.active.get(ctx)?.retired)
            return;
        part.state = 'sending';
        await this.delivery.save();
        try {
            const receipt = ctx.send ? await ctx.send(part.text) : (await ctx.respond(part.text), {});
            part.state = 'sent';
            part.platformId = receipt?.platformId;
            delete part.error;
        }
        catch (error) {
            const fault = error;
            part.state = fault.name === 'TimeoutError' || fault.name === 'AbortError'
                || ['ETIMEDOUT', 'ECONNRESET'].includes(fault.code ?? '') ? 'unknown' : 'pending';
            part.error = error instanceof Error ? error.message : String(error);
        }
        await this.delivery.save();
    }
    async finishDelivery(turn) {
        if (turn.retired)
            return;
        turn.state = turn.parts.some(part => part.state === 'unknown') ? 'unknown'
            : (turn.parts.every(part => part.state === 'sent') ? 'complete' : 'output');
        if (turn.report) {
            const parts = turn.parts.filter(part => part.kind === 'reply');
            turn.report = { ...turn.report,
                status: turn.state === 'complete' ? 'completed' : 'failed',
                parts: parts.map((part, index) => ({ index, chars: Array.from(part.text).length,
                    ok: part.state === 'sent', ...(part.platformId === undefined ? {} : { platformId: part.platformId }),
                    ...(part.error === undefined ? {} : { error: part.error }) })),
            };
            this.opts.observeTurn?.(turn.report);
        }
        await this.delivery.save();
    }
    test(payload) {
        if (this.opts.reservedCommands?.some((command) => payload === command || payload.startsWith(`${command} `))) {
            return false;
        }
        // 默认所有有效载荷都交给 Agent(可扩展:保留特定子命令给其它 handler)。
        // 若不希望 Agent 吞掉所有指令,可改成匹配某前缀,例如 payload 以 `ask ` 开头。
        return true;
    }
    /** 把一段文本按 maxLen 切分后逐条回发,并带回每段的平台回执。 */
    async respondChunk(ctx, chunk, kind = 'control') {
        const maxLen = this.opts.maxMessageLength ?? 4500;
        const parts = splitText(chunk, maxLen);
        const sent = [];
        const turn = this.active.get(ctx);
        if (turn) {
            const staged = parts.map(text => ({ text, kind, state: 'pending' }));
            turn.parts.push(...staged);
            await this.delivery.save();
            for (const part of staged) {
                await this.sendPart(ctx, part);
                sent.push({ index: sent.length, chars: Array.from(part.text).length, ok: part.state === 'sent',
                    ...(part.platformId === undefined ? {} : { platformId: part.platformId }),
                    ...(part.error === undefined ? {} : { error: part.error }) });
            }
            return sent;
        }
        for (const part of parts) {
            const index = sent.length;
            try {
                const receipt = ctx.send ? await ctx.send(part) : (await ctx.respond(part), {});
                sent.push({
                    index,
                    chars: Array.from(part).length,
                    ...(receipt && typeof receipt === 'object' && receipt.platformId !== undefined
                        ? { platformId: String(receipt.platformId) } : {}),
                    ok: true,
                });
            }
            catch (err) {
                // Keep the remaining parts unsent: a split reply that failed midway is
                // retried from the failed segment, never resent in full.
                sent.push({
                    index,
                    chars: Array.from(part).length,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return sent;
    }
    async run(ctx) {
        if (this.stopped)
            return;
        if (!this.opts.deliveryStatePath)
            return this.process(ctx);
        await this.enqueue(sessionKeyOf(ctx), async () => {
            const { turn, duplicate } = await this.delivery.accept(ctx);
            if (duplicate)
                return;
            await this.process(ctx, turn);
        }).catch(async (error) => {
            const full = String(error?.message).includes('队列已满');
            console.warn(`[dsh-qq-bridge] delivery state failed: ${error instanceof Error ? error.message : String(error)}`);
            await ctx.respond(full ? 'QQ 待处理队列已满，本条尚未受理，请稍后重发。'
                : '本机消息状态保存失败，本轮已停止，请检查 DSH 存储后核对结果。');
        });
    }
    async process(ctx, turn) {
        if (this.stopped)
            return;
        if (turn)
            this.active.set(ctx, turn);
        const sessionKey = sessionKeyOf(ctx);
        // The agent receives exactly the user's words: no source banner, no style
        // marker, no auto-invoked skill. Anything the bridge wrapped in would become
        // part of what the model reads, so the payload stays verbatim.
        const payload = ctx.payload;
        const gate = this.opts.webActivityGate;
        if (gate?.isBusy()) {
            await this.respondChunk(ctx, this.opts.webBusyMessage ?? '当前 Web 会话正在运行，请稍后...');
            await gate.enqueueWhenIdle(() => this.runAgentTurn(ctx, sessionKey, payload));
            return;
        }
        await this.runAgentTurn(ctx, sessionKey, payload);
        this.active.delete(ctx);
    }
    async runAgentTurn(ctx, sessionKey, payload) {
        const ackMessage = this.opts.ackMessage ?? '收到，正在处理...';
        const timeoutMs = this.opts.timeoutMs;
        const timeoutMessage = this.opts.timeoutMessage ?? 'agent 无响应，请稍后重试。';
        let active = true;
        try {
            const sessionId = await this.executor.prepareSession?.(sessionKey);
            const stored = this.active.get(ctx);
            if (stored) {
                stored.sessionId = sessionId;
                await this.delivery.save();
            }
            await this.opts.prepareTurn?.({ sessionKey, sessionId, scope: ctx.scope, owner: ctx.owner,
                userId: ctx.userId, groupId: ctx.groupId, messageId: ctx.messageId, input: ctx.payload });
            if (this.stopped)
                return;
            if (stored) {
                stored.state = 'running';
                await this.delivery.save();
            }
            if (ackMessage)
                await this.respondChunk(ctx, ackMessage);
            const canStreamText = this.opts.streamText && !this.opts.controlDispatcher && !this.opts.deliveryStatePath;
            if (!canStreamText) {
                // AgentExecutor.run resolve 即本轮完成标志:DSH executor 在内部等待 agent.whenIdle()。
                const result = await withTimeout(this.executor.run(sessionKey, payload), timeoutMs);
                active = false;
                if (this.stopped || stored?.retired)
                    return;
                if (stored) {
                    stored.state = 'output';
                    const visible = parseQqSpells(result || '').visibleText;
                    stored.report = this.turnReport(ctx, sessionKey, this.opts.controlDispatcher ? parseQqControlBlocks(visible).visibleText : visible, [], { status: 'completed', generationStatus: 'completed' });
                    await this.delivery.save();
                }
                const output = await this.respondAgentOutput(ctx, sessionKey, result || '(no output)');
                if (stored)
                    await this.finishDelivery(stored);
                else
                    this.observeTurn(ctx, sessionKey, payload, output.reply, output.parts, { status: output.status, generationStatus: 'completed' });
                return;
            }
            const streamedText = [];
            const parts = [];
            // 分段返回:agent 边产出边回发,用户不必等整轮结束。
            // 默认只回发「思考结果」(kind='text');思考过程(reasoning)默认忽略,
            // 避免逐 token 的思考增量在聊天框刷屏。可用 streamReasoning 开启。
            const result = await withTimeout(this.executor.run(sessionKey, payload, (chunk, kind) => {
                if (!active)
                    return;
                if (kind === 'reasoning' && !this.opts.streamReasoning)
                    return;
                if (kind === 'text')
                    streamedText.push(chunk);
                void this.respondChunk(ctx, chunk).then(sent => {
                    for (const part of sent)
                        parts.push({ ...part, index: parts.length });
                });
            }), timeoutMs);
            active = false;
            const final = result || '(no output)';
            // 若流式 text 分段已经覆盖最终结果,不再重复发送最终完整版。
            if (streamedText.join('').trim() === final.trim()) {
                this.observeTurn(ctx, sessionKey, payload, final, parts, { status: 'completed' });
                return;
            }
            // 最终结果(若与已分段内容不同,回发最终完整版作为收尾;超长自动拆分)。
            const tail = await this.respondAgentOutput(ctx, sessionKey, final, { report: ctx, remember: false, offset: parts.length });
            this.observeTurn(ctx, sessionKey, payload, tail.reply || final, [...parts, ...tail.parts], { status: tail.status });
        }
        catch (err) {
            active = false;
            const stored = this.active.get(ctx);
            if (this.stopped || stored?.retired)
                return;
            if (stored) {
                stored.state = String(err instanceof Error ? err.message : err).includes('MEMORY_REQUIRED') ? 'waiting' : 'failed';
                await this.delivery.save();
                if (stored.state === 'waiting' && stored.notified)
                    return;
                stored.notified = true;
                await this.delivery.save();
            }
            const message = err instanceof AgentTimeoutError
                ? timeoutMessage
                : (stored?.state === 'waiting' ? '记忆服务暂时不可用，消息已保留，恢复后会继续处理。'
                    : `agent error: ${err instanceof Error ? err.message : String(err)}`);
            await this.respondChunk(ctx, message);
            // A generation that failed is not a completed exchange: the report says
            // what happened so the caller neither saves it nor invents a reply.
            this.observeTurn(ctx, sessionKey, payload, message, [], { status: 'failed', reason: err instanceof Error ? err.message : String(err) });
        }
    }
    observeTurn(ctx, sessionKey, payload, reply, parts, outcome) {
        if (!this.opts.observeTurn)
            return;
        try {
            this.opts.observeTurn(this.turnReport(ctx, sessionKey, reply, parts, outcome));
        }
        catch (err) {
            console.warn(`[dsh-qq-bridge] turn observer failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    turnReport(ctx, sessionKey, reply, parts, outcome) {
        const sessionId = this.opts.sessionIdOf?.(sessionKey);
        const turnMessageId = this.executor.lastTurnIdentity?.(sessionKey)?.messageId;
        return {
            sessionKey,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(turnMessageId === undefined ? {} : { turnMessageId }),
            scope: ctx.scope,
            userId: ctx.userId,
            ...(ctx.groupId === undefined ? {} : { groupId: ctx.groupId }),
            owner: ctx.owner,
            ...(ctx.messageId === undefined ? {} : { messageId: ctx.messageId }),
            // The wrapper is bridge scaffolding; only the user's own words belong
            // in a memory record.
            input: ctx.payload,
            reply,
            parts: parts.map(part => ({ ...part })),
            ...outcome,
        };
    }
    /**
     * 解析控制块后回发,并报告真正对外可见的文字与每段平台回执。
     *
     * 控制块动作的回执、解析错误提示都是 bridge 自己的输出,不属于“助手回复”,
     * 因此只有 `parsed.visibleText` 计入 `reply`;但它们的发送结果仍逐段返回,
     * 便于调用方知道哪些平台消息已经产生。
     */
    async respondAgentOutput(ctx, sessionKey, result, options = {}) {
        const dispatcher = this.opts.controlDispatcher;
        // 咒语先拆:标签属于「模型还没说完」的部分,不能出现在主人看到的正文里。
        // 拆完仍是纯文本,所以下面有没有控制块分发器都能走同一条路。
        const spelled = parseQqSpells(result);
        if (!dispatcher) {
            const parts = await this.respondChunk(ctx, spelled.visibleText, 'reply');
            const offset = options.offset ?? 0;
            return {
                reply: spelled.visibleText,
                parts: parts.map(part => ({ ...part, index: part.index + offset })),
                status: parts.every(part => part.ok) ? 'completed' : 'failed',
            };
        }
        const parsed = parseQqControlBlocks(spelled.visibleText);
        const parts = [];
        let offset = options.offset ?? 0;
        for (const error of parsed.errors) {
            const sent = await this.respondChunk(ctx, error);
            for (const part of sent)
                parts.push({ ...part, index: offset + parts.length });
            offset = 0;
        }
        for (const action of parsed.actions) {
            if (!dispatcher)
                continue;
            const message = await dispatcher.dispatch(action, { sessionKey, source: ctx });
            if (!message)
                continue;
            const sent = await this.respondChunk(ctx, message);
            for (const part of sent)
                parts.push({ ...part, index: offset + parts.length });
            offset = 0;
        }
        let reply = '';
        if (parsed.visibleText) {
            const sent = await this.respondChunk(ctx, parsed.visibleText, 'reply');
            for (const part of sent)
                parts.push({ ...part, index: offset + parts.length });
            reply = parsed.visibleText;
        }
        else if (parts.length === 0) {
            const sent = await this.respondChunk(ctx, '(no output)');
            for (const part of sent)
                parts.push({ ...part, index: offset + parts.length });
        }
        return {
            reply,
            parts,
            status: parts.every(part => part.ok) ? 'completed' : 'failed',
        };
    }
}
export class AgentTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`agent timed out after ${timeoutMs}ms`);
        this.name = 'AgentTimeoutError';
    }
}
function withTimeout(promise, timeoutMs) {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AgentTimeoutError(timeoutMs)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer)
            clearTimeout(timer);
    });
}
