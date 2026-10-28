import { parseQqControlBlocks, parseQqSpells, } from './control.js';
import { DeliveryStore } from '../delivery-store.js';
import { collectInboundImages } from '../onebot/images.js';
import { imageStatusText } from '../onebot/message.js';
import { replyParts } from '../message-format.js';
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
 * 普通文字按自然换行分成气泡，结构块保持整体；超长再按 Unicode 码点拆分。
 */
export function splitText(text, maxLen) {
    return replyParts(text, maxLen).parts;
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
    delays = new Map();
    constructor(executor, opts = {}) {
        this.executor = executor;
        this.opts = opts;
        this.delivery = new DeliveryStore(opts.deliveryStatePath);
    }
    async open() { await this.delivery.open(); }
    async dispose() {
        this.stopped = true;
        for (const delay of this.delays.values())
            delay.abort();
        await this.delivery.save();
    }
    async waitBetween(ctx, text) {
        const key = sessionKeyOf(ctx), controller = new AbortController();
        this.delays.set(key, controller);
        const milliseconds = Math.min(2000, 800 + Array.from(text).length * 15);
        try {
            if (this.opts.waitForBubble)
                await this.opts.waitForBubble(milliseconds, controller.signal);
            else
                await new Promise(resolve => {
                    const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
                    const timer = setTimeout(done, milliseconds);
                    controller.signal.addEventListener('abort', done, { once: true });
                });
        }
        finally {
            if (this.delays.get(key) === controller)
                this.delays.delete(key);
        }
    }
    async sendPending(ctx, parts, canSend = async () => true) {
        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            if (part.state === 'sent')
                continue;
            if (part.state !== 'pending')
                return false;
            if (index > 0 && !this.stopped)
                await this.waitBetween(ctx, part.text);
            if (this.stopped || !await canSend())
                return false;
            await this.sendPart(ctx, part);
            if (part.state !== 'sent')
                return false;
        }
        return true;
    }
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
            if (turn.externallyManaged)
                continue;
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
                    this.active.set(ctx, turn);
                    try {
                        await this.sendPending(ctx, turn.parts);
                        await this.finishDelivery(turn);
                    }
                    finally {
                        this.active.delete(ctx);
                    }
                }
            });
        }
    }
    /** Session followups have no inbound HandlerContext; reuse durable delivery. */
    async deliverOutput(input, outputId, parts, canSend) {
        if (this.stopped || !input.owner || input.scope !== 'private' || !input.sessionId || !this.opts.restoreContext) {
            throw new Error('QQ output session is unavailable');
        }
        const ctx = this.opts.restoreContext({
            scope: input.scope, userId: input.userId, owner: true, payload: '',
            messageId: outputId,
        });
        if (!ctx)
            throw new Error('QQ output route is unavailable');
        let result;
        await this.enqueue(input.sessionKey, async () => {
            if (this.stopped || this.opts.sessionIdOf?.(input.sessionKey) !== input.sessionId) {
                throw new Error('QQ output session was replaced');
            }
            const { turn } = await this.delivery.accept(ctx, {
                sessionId: input.sessionId,
                externallyManaged: true,
                parts: parts.map(part => ({ text: part.text, outputIndex: part.index, kind: 'reply', state: 'pending' })),
            });
            if (turn.retired)
                throw new Error('QQ output was retired');
            this.active.set(ctx, turn);
            try {
                let cancelled = false;
                await this.sendPending(ctx, turn.parts, async () => {
                    const allowed = await canSend();
                    if (!allowed)
                        cancelled = true;
                    return allowed;
                });
                await this.finishDelivery(turn);
                result = {
                    status: cancelled ? 'cancelled' : turn.state === 'complete' ? 'completed' : 'failed',
                    parts: turn.parts.map((part, index) => ({
                        index: part.outputIndex ?? index, ok: part.state === 'sent',
                        platformId: part.platformId, error: part.error,
                    })),
                };
            }
            finally {
                this.active.delete(ctx);
            }
        });
        if (!result)
            throw new Error('QQ output delivery did not run');
        return result;
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
            const visible = replyParts(parseQqControlBlocks(parseQqSpells(result).visibleText).visibleText).text;
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
                await this.sendPending(ctx, turn.parts);
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
        const plan = replyParts(chunk, this.opts.maxMessageLength ?? 4500, kind === 'reply');
        const staged = plan.parts.map(text => ({ text, kind, state: 'pending' }));
        const turn = this.active.get(ctx);
        if (turn) {
            turn.parts.push(...staged);
            await this.delivery.save();
        }
        await this.sendPending(ctx, staged);
        return staged.map((part, index) => ({ index, chars: Array.from(part.text).length, ok: part.state === 'sent',
            ...(part.platformId === undefined ? {} : { platformId: part.platformId }),
            ...(part.error === undefined ? {} : { error: part.error }) }));
    }
    async run(ctx) {
        if (this.stopped)
            return;
        const sessionKey = sessionKeyOf(ctx);
        if (!this.opts.deliveryStatePath) {
            await this.opts.waitForOutput?.(sessionKey);
            return this.enqueue(sessionKey, () => this.process(ctx));
        }
        await (async () => {
            const { turn, duplicate } = await this.delivery.accept(ctx);
            if (duplicate)
                return;
            await this.opts.waitForOutput?.(sessionKey);
            await this.enqueue(sessionKey, () => this.process(ctx, turn));
        })().catch(async (error) => {
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
    /**
     * 下载本条消息里的图片。
     *
     * 任何失败都只让这一张图缺席:文本照常送达,整轮不会因为图片坏掉而失败。
     * 丢弃原因写日志(不含字节、不含 base64),便于事后判断是链接过期还是类型不支持。
     * @param ctx - 含图片地址的入站上下文。
     * @returns 成功编码的图片;没有图片或全部失败时返回空数组。
     */
    async collectImages(ctx) {
        const sources = ctx.images;
        if (!sources || sources.length === 0)
            return [];
        try {
            const { images, skipped } = await collectInboundImages(sources, {
                maxImages: this.opts.maxImages,
                maxBytes: this.opts.maxImageBytes,
                timeoutMs: this.opts.imageTimeoutMs,
                ...(this.opts.fetchImpl === undefined ? {} : { fetchImpl: this.opts.fetchImpl }),
            });
            for (const reason of skipped) {
                console.warn(`[dsh-qq-bridge] inbound image skipped: ${reason}`);
            }
            return images;
        }
        catch (error) {
            console.warn(`[dsh-qq-bridge] inbound image collection failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
    async runAgentTurn(ctx, sessionKey, payload) {
        // 图片在这里才下载:确认本轮真要交给 Agent 之后,而不是在路由分流时。
        // 失败只记录,不改变文本轮次的任何行为。
        let images = await this.collectImages(ctx);
        const ackMessage = this.opts.ackMessage ?? '收到，正在处理...';
        const timeoutMs = this.opts.timeoutMs;
        const timeoutMessage = this.opts.timeoutMessage ?? 'agent 无响应，请稍后重试。';
        try {
            images = this.executor.prepareImages ? await this.executor.prepareImages(images) : images;
            ctx.payload = imageStatusText(ctx.payload, ctx.images ?? [], images);
            payload = ctx.payload;
            const sessionId = await this.executor.prepareSession?.(sessionKey);
            const stored = this.active.get(ctx);
            if (stored) {
                stored.sessionId = sessionId;
                stored.input.payload = payload;
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
            {
                // AgentExecutor.run resolve 即本轮完成标志:DSH executor 在内部等待 agent.whenIdle()。
                // 没有图片时保持两参调用:既有实现与测试都按这个形状断言。
                const result = await withTimeout(images.length === 0
                    ? this.executor.run(sessionKey, payload)
                    : this.executor.run(sessionKey, payload, undefined, images), timeoutMs);
                if (this.stopped || stored?.retired)
                    return;
                if (stored) {
                    stored.state = 'output';
                    const visible = parseQqSpells(result || '').visibleText;
                    stored.report = this.turnReport(ctx, sessionKey, replyParts(this.opts.controlDispatcher ? parseQqControlBlocks(visible).visibleText : visible).text, [], { status: 'completed', generationStatus: 'completed' });
                    await this.delivery.save();
                }
                const output = await this.respondAgentOutput(ctx, sessionKey, result || '(no output)');
                if (stored)
                    await this.finishDelivery(stored);
                else
                    this.observeTurn(ctx, sessionKey, payload, output.reply, output.parts, { status: output.status, generationStatus: 'completed' });
                return;
            }
        }
        catch (err) {
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
            const visible = replyParts(spelled.visibleText).text;
            const parts = await this.respondChunk(ctx, visible, 'reply');
            const offset = options.offset ?? 0;
            return {
                reply: visible,
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
            const visible = replyParts(parsed.visibleText).text;
            const sent = await this.respondChunk(ctx, visible, 'reply');
            for (const part of sent)
                parts.push({ ...part, index: offset + parts.length });
            reply = visible;
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
