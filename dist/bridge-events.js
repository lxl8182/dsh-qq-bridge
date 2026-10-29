import { parseQqControlBlocks, parseQqSpells } from './handlers/control.js';
import { extractAssistantText } from './handlers/dsh-executor.js';
import { replyParts } from './message-format.js';
/** 服务在 Cordis 中的名字;订阅方按这个名字注入。 */
export const QQ_BRIDGE_EVENTS_SERVICE = 'qqBridgeEvents';
/**
 * 只读事件出口。
 *
 * `subscribe` 同步注册:注册完成后再发生的一轮一定会通知到;注册之前已经结束
 * 的轮次不会补发(补交由订阅方自己的持久队列负责,不靠桥接重放)。
 */
export class QqBridgeEvents {
    listeners = new Set();
    admissions = new Set();
    bindings = new Map();
    /** 重启后恢复的合法拥有者身份;键是桥接自己生成的 sessionKey。 */
    restored = new Map();
    /** sessionKey → 本进程的 DSH 会话 id。DSH 会话 id 每次启动都会变。 */
    sessions = new Map();
    /** 身份复核钩子:由桥接在 AccessGate 就绪后注册,恢复时不信任存档里的 owner 声明。 */
    identityVerifier;
    /** 会话建立钩子:恢复绑定后由桥接自己的执行器建本进程会话。 */
    sessionBinder;
    retirer;
    pusher;
    platform = 'official';
    replay;
    outputSender;
    maxMessageLength = 4500;
    activeOutputs = new Map();
    beginOutput(sessionId) {
        if (this.activeOutputs.has(sessionId))
            throw new Error('QQ session already has an active output');
        let finish;
        const promise = new Promise(resolve => { finish = resolve; });
        const output = { promise, finish };
        this.activeOutputs.set(sessionId, output);
        return () => {
            if (this.activeOutputs.get(sessionId) === output)
                this.activeOutputs.delete(sessionId);
            finish();
        };
    }
    async waitForOutput(sessionId) {
        await this.activeOutputs.get(sessionId)?.promise;
    }
    setOutputLimit(maximum) { this.maxMessageLength = maximum; }
    setOutputSender(sender) {
        this.outputSender = sender;
        return () => { if (this.outputSender === sender)
            this.outputSender = undefined; };
    }
    normalizeOutput(text) {
        return replyParts(parseQqControlBlocks(parseQqSpells(text).visibleText).visibleText).text;
    }
    planOutput(text) {
        const plan = replyParts(this.normalizeOutput(text), this.maxMessageLength);
        return { text: plan.text, part_sizes: plan.part_sizes };
    }
    assistantText(events) {
        return extractAssistantText(events) ?? '';
    }
    deliverOutput(sessionId, outputId, parts, canSend) {
        return this.outputSender?.(sessionId, outputId, parts, canSend);
    }
    setReplay(replay) {
        this.replay = replay;
        return () => { if (this.replay === replay)
            this.replay = undefined; };
    }
    binding(sessionId) {
        const binding = this.bindings.get(sessionId);
        return binding ? { ...binding } : undefined;
    }
    // -- RO04-B:绑定恢复 ---------------------------------------------------
    /**
     * 会话键的唯一生成规则。订阅方不要在别处重算:字符串一旦不同,恢复出来的
     * 绑定就会指向另一个人,而不是同一个主人。
     */
    sessionKeyOf(scope, userId, groupId) {
        return `${scope}:${scope === 'private' ? userId : groupId}`;
    }
    /**
     * 由桥接注册身份复核(通常包住 AccessGate.isOwner)。
     *
     * 存档里的 owner 只是当时的结论;重启后必须用当前配置重新确认,否则改过的
     * 白名单会让旧文件继续冒充主人。没有注册复核时恢复一律拒绝。
     */
    setIdentityVerifier(verifier) {
        this.identityVerifier = verifier;
        return () => { if (this.identityVerifier === verifier)
            this.identityVerifier = undefined; };
    }
    /**
     * 重启后恢复已有合法绑定,不需要主人再发一条消息。
     *
     * 只接受能自证的事实:会话键必须等于本类生成的规则,scope 与平台 id 必须
     * 对得上,owner 恒为 true,并且当前配置仍认这个身份。四项任一不成立就进
     * rejected,调用方据此删掉自己的旧记录——绝不按昵称、群名片或会话前缀去猜。
     *
     * 已由真实入站确认的绑定不会被覆盖(kept),恢复只补空的那些。
     */
    restoreBindings(records) {
        const report = { restored: 0, kept: 0, rejected: [] };
        for (const record of records) {
            const reject = (reason) => report.rejected.push({ sessionKey: String(record?.sessionKey ?? ''), reason });
            if (!record || typeof record !== 'object') {
                reject('invalid_record');
                continue;
            }
            const scope = record.scope;
            if (scope !== 'private' && scope !== 'group') {
                reject('invalid_scope');
                continue;
            }
            if (record.owner !== true) {
                reject('not_owner');
                continue;
            }
            const userId = record.userId;
            if (userId === undefined || userId === null || `${userId}`.trim() === '') {
                reject('missing_user');
                continue;
            }
            if (scope === 'group' && (record.groupId === undefined || record.groupId === null)) {
                reject('missing_group');
                continue;
            }
            if (record.sessionKey !== this.sessionKeyOf(scope, userId, record.groupId)) {
                reject('session_key_mismatch');
                continue;
            }
            const live = [...this.bindings.values()].find(binding => binding.sessionKey === record.sessionKey);
            if (live) {
                // A binding confirmed by a real inbound message this boot wins over the file.
                report.kept++;
                continue;
            }
            if (this.restored.has(record.sessionKey)) {
                // Same identity restored twice (e.g. an older snapshot): last one wins.
                this.restored.set(record.sessionKey, { ...record });
                continue;
            }
            const verifier = this.identityVerifier;
            if (!verifier) {
                reject('identity_unverified');
                continue;
            }
            let trusted = false;
            try {
                trusted = verifier({ ...record });
            }
            catch {
                trusted = false;
            }
            if (!trusted) {
                reject('identity_not_owner');
                continue;
            }
            this.restored.set(record.sessionKey, { ...record });
            report.restored++;
        }
        return report;
    }
    /** 已恢复但本进程还没有 DSH 会话的绑定。 */
    restoredBindings() {
        return [...this.restored.values()]
            .filter(record => !this.sessions.has(record.sessionKey))
            .map(record => ({ ...record }));
    }
    /**
     * 把本进程新建的 DSH 会话挂到已恢复的绑定上。
     *
     * DSH 会话 id 每次启动都会变,存档里那个已经失效;恢复的是身份,会话由
     * 桥接在本进程重新创建后回填。挂上之后 deliverByIndex 就能不经新入站投递。
     */
    bindSession(sessionKey, sessionId) {
        const record = this.restored.get(sessionKey);
        if (!record || !sessionId)
            return false;
        this.sessions.set(sessionKey, sessionId);
        this.bindings.set(sessionId, {
            sessionKey, sessionId, scope: record.scope, owner: true, userId: record.userId,
            ...(record.groupId === undefined ? {} : { groupId: record.groupId }),
            ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
            input: '',
        });
        return true;
    }
    /**
     * 由桥接注册"为这个会话键建一个本进程的 DSH 会话"(通常接 executor.prepareSession)。
     *
     * 恢复的是身份,不是会话:DSH 会话 id 每次启动都会变,所以重启后必须由桥接
     * 自己的执行器重新建一次,恢复出来的绑定才真的能投递。注册者不出现时
     * ensureSessions 会明确失败,而不是假装已经可投。
     */
    setSessionBinder(binder) {
        this.sessionBinder = binder;
        return () => { if (this.sessionBinder === binder)
            this.sessionBinder = undefined; };
    }
    /**
     * 为已恢复但还没有会话的绑定建立本进程会话,不需要主人再发一条消息。
     *
     * 逐条独立:某一条建不起来只让它自己进 failed,不影响其它绑定;调用方按
     * failed 决定是重试还是等真实入站。
     */
    async ensureSessions() {
        const result = { bound: 0, failed: [] };
        const binder = this.sessionBinder;
        for (const record of this.restored.values()) {
            if (this.sessions.has(record.sessionKey))
                continue;
            if (!binder) {
                result.failed.push({ sessionKey: record.sessionKey, reason: 'binder_unavailable' });
                continue;
            }
            let sessionId;
            try {
                sessionId = await binder({ ...record });
            }
            catch (error) {
                result.failed.push({ sessionKey: record.sessionKey, reason: error instanceof Error ? error.message : String(error) });
                continue;
            }
            if (!sessionId || !this.bindSession(record.sessionKey, sessionId)) {
                result.failed.push({ sessionKey: record.sessionKey, reason: 'session_unavailable' });
                continue;
            }
            result.bound++;
        }
        return result;
    }
    /** 导出可持久化的身份记录(不含任何输入文本或凭据)。 */
    bindingRecords() {
        const rows = new Map();
        for (const record of this.restored.values())
            rows.set(record.sessionKey, { ...record });
        for (const binding of this.bindings.values()) {
            if (!binding.owner)
                continue;
            rows.set(binding.sessionKey, {
                sessionKey: binding.sessionKey, scope: binding.scope, owner: true, userId: binding.userId,
                ...(binding.groupId === undefined ? {} : { groupId: binding.groupId }),
                ...(binding.messageId === undefined ? {} : { messageId: binding.messageId }),
            });
        }
        return [...rows.values()];
    }
    /**
     * 通用投递(RO04-B):按固定 output/part 索引把正文送到合法绑定。
     *
     * 与候选无关:正文来自哪里、为什么现在说,都不在这里判断。这里只做三件
     * 桥接才有资格做的事——确认绑定仍是当前合法主人、复用同一份 delivery-store
     * 让已送达段不重发、把平台回执按原索引报回去。部分失败返回 pending 索引,
     * 调用方用同一个 outputId 再投一次只会发送未送达的段。
     */
    async deliverByIndex(request, canSend) {
        const unavailable = (error) => ({ status: 'unavailable', parts: [], pending: [], error });
        if (!request || typeof request !== 'object')
            return unavailable('invalid_request');
        if (typeof request.outputId !== 'string' || !request.outputId.trim())
            return unavailable('missing_output_id');
        const parts = Array.isArray(request.parts) ? request.parts : [];
        if (parts.length === 0)
            return unavailable('missing_parts');
        const indices = new Set();
        for (const part of parts) {
            if (!part || typeof part.text !== 'string' || !part.text.trim())
                return unavailable('invalid_part_text');
            if (typeof part.index !== 'number' || !Number.isInteger(part.index) || part.index < 0)
                return unavailable('invalid_part_index');
            if (indices.has(part.index))
                return unavailable('duplicate_part_index');
            indices.add(part.index);
        }
        const sessionId = request.sessionId ?? this.sessions.get(request.sessionKey);
        if (!sessionId)
            return unavailable(this.restored.has(request.sessionKey) ? 'no_session' : 'not_bound');
        const live = this.bindings.get(sessionId);
        if (!live || !live.owner || live.sessionKey !== request.sessionKey)
            return unavailable('binding_mismatch');
        if (live.scope !== 'private')
            return unavailable('not_private');
        if (!this.outputSender)
            return unavailable('transport_unavailable');
        const ordered = [...parts].sort((left, right) => left.index - right.index)
            .map(part => ({ index: part.index, text: part.text }));
        let delivery;
        try {
            delivery = await this.outputSender(sessionId, request.outputId, ordered, canSend ?? (async () => true));
        }
        catch (error) {
            return { status: 'failed', parts: [], pending: [...indices].sort((left, right) => left - right),
                error: error instanceof Error ? error.message : String(error) };
        }
        const pending = delivery.parts.filter(part => !part.ok)
            .map(part => part.index).sort((left, right) => left - right);
        return { status: delivery.status, parts: delivery.parts, pending };
    }
    subscribeAdmission(listener) {
        this.admissions.add(listener);
        return { dispose: () => { this.admissions.delete(listener); } };
    }
    async prepare(input) {
        if (input.sessionId)
            this.bindings.set(input.sessionId, { ...input });
        if (input.sessionId && input.sessionKey)
            this.sessions.set(input.sessionKey, input.sessionId);
        let chatOnlyReady = false;
        for (const listener of this.admissions) {
            const prepared = { ...input, chatOnlyReady: false };
            await listener(prepared);
            chatOnlyReady ||= prepared.chatOnlyReady === true;
        }
        // 订阅者仍只拿输入副本；仅回传准入确认，不接受它们改写来源或正文。
        input.chatOnlyReady = chatOnlyReady;
    }
    /**
     * 由宿主插件注册"主动给管理员发一条文字"的能力。
     *
     * 桥接自己知道该发给谁(管理员 QQ / OpenID)和怎么发,别的插件不该复制
     * 这份配置。注册者不出现时 pushPrivate 返回 undefined,调用方据此降级,
     * 而不是假装送达。
     */
    setPusher(pusher) {
        this.pusher = pusher;
        return () => { if (this.pusher === pusher)
            this.pusher = undefined; };
    }
    /** 向管理员推送一条文字。没注册推送者时返回 undefined。 */
    pushPrivate(text) {
        const body = String(text ?? '').trim();
        if (!body || !this.pusher)
            return undefined;
        return this.pusher(body);
    }
    setRetirer(retirer) {
        this.retirer = retirer;
        return () => { if (this.retirer === retirer)
            this.retirer = undefined; };
    }
    async retireSession(sessionId) {
        if (!this.retirer)
            throw new Error('QQ session controller is unavailable');
        await this.retirer(sessionId);
        this.bindings.delete(sessionId);
        // 会话被弃用意味着那条 DSH 会话不能再投递;身份本身仍可重新绑定。
        for (const [key, id] of this.sessions)
            if (id === sessionId)
                this.sessions.delete(key);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        for (const report of this.replay?.() ?? [])
            listener(report);
        let active = true;
        return {
            dispose: () => {
                if (!active)
                    return;
                active = false;
                this.listeners.delete(listener);
            },
        };
    }
    /**
     * 发布一轮的结果。监听器抛错只影响它自己:桥接的收发不能因为某个订阅方
     * 出错而失败。
     */
    publish(report) {
        for (const listener of [...this.listeners]) {
            try {
                listener(report);
            }
            catch (err) {
                console.warn(`[dsh-qq-bridge] qqBridgeEvents listener failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    /** 卸载时清空订阅,避免已销毁的服务继续持有回调。 */
    dispose() {
        for (const output of this.activeOutputs.values())
            output.finish();
        this.activeOutputs.clear();
        this.listeners.clear();
        this.admissions.clear();
        this.bindings.clear();
        this.sessions.clear();
        this.restored.clear();
        this.identityVerifier = undefined;
        this.sessionBinder = undefined;
        this.retirer = undefined;
        this.pusher = undefined;
        this.replay = undefined;
        this.outputSender = undefined;
    }
    get listenerCount() {
        return this.listeners.size;
    }
}
