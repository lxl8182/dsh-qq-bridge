import { parseQqControlBlocks, parseQqSpells } from './handlers/control.js';
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
    retirer;
    pusher;
    platform = 'official';
    replay;
    outputSender;
    setOutputSender(sender) {
        this.outputSender = sender;
        return () => { if (this.outputSender === sender)
            this.outputSender = undefined; };
    }
    normalizeOutput(text) {
        return parseQqControlBlocks(parseQqSpells(text).visibleText).visibleText;
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
    subscribeAdmission(listener) {
        this.admissions.add(listener);
        return { dispose: () => { this.admissions.delete(listener); } };
    }
    async prepare(input) {
        if (input.sessionId)
            this.bindings.set(input.sessionId, { ...input });
        for (const listener of this.admissions)
            await listener({ ...input });
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
        this.listeners.clear();
        this.admissions.clear();
        this.bindings.clear();
        this.retirer = undefined;
        this.pusher = undefined;
        this.replay = undefined;
        this.outputSender = undefined;
    }
    get listenerCount() {
        return this.listeners.size;
    }
}
