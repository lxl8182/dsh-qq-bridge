/**
 * C 骨架:消息分发器。注册 handler,按前缀 + 匹配路由。
 */
export class MessageRouter {
    gate;
    outbound;
    pendingReply;
    outboundWithReceipt;
    handlers = new Map();
    constructor(gate, outbound, pendingReply, 
    /**
     * 带平台回执的发送器。缺省时 `ctx.send` 退化为 `respond` 且不带 id:
     * 旧调用方与旧传输层不需要改动,新调用方拿不到 id 时也知道自己拿不到。
     */
    outboundWithReceipt) {
        this.gate = gate;
        this.outbound = outbound;
        this.pendingReply = pendingReply;
        this.outboundWithReceipt = outboundWithReceipt;
    }
    register(handler) {
        this.handlers.set(handler.name, handler);
        return () => this.handlers.delete(handler.name);
    }
    /**
     * 处理一条入站消息:
     * 1. 白名单过滤
     * 2. 前缀剥离
     * 3. 按注册顺序匹配 handler。
     * 返回是否被消费(被 router 处理且至少一个 handler 匹配)。
     */
    async route(evt) {
        if (!this.gate.allow(evt))
            return false;
        const scope = evt.message_type === 'private' ? 'private' : 'group';
        const payload = this.gate.stripPrefix(evt.raw_message);
        if (payload === null)
            return false;
        const targetId = scope === 'private' ? evt.user_id : evt.group_id;
        const respond = async (text) => {
            try {
                await this.outbound(scope, targetId, text, evt.reply_target);
            }
            catch (err) {
                console.warn(`[dsh-qq-bridge] failed to send ${scope} message to ${targetId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        };
        const ctx = {
            userId: evt.user_id,
            scope,
            groupId: evt.group_id,
            payload,
            owner: this.gate.isOwner(evt),
            messageId: evt.message_id,
            replyTarget: evt.reply_target,
            respond,
            send: this.outboundWithReceipt
                ? async (text) => {
                    try {
                        const receipt = await this.outboundWithReceipt(scope, targetId, text, evt.reply_target);
                        return receipt && typeof receipt === 'object' ? receipt : {};
                    }
                    catch (err) {
                        // A failed send is a fact the caller must see; it is not the
                        // same as "sent without an id".
                        console.warn(`[dsh-qq-bridge] failed to send ${scope} message to ${targetId}: ${err instanceof Error ? err.message : String(err)}`);
                        throw err;
                    }
                }
                : async (text) => {
                    await respond(text);
                    return {};
                },
        };
        if (await this.pendingReply?.handle(ctx))
            return true;
        let consumed = false;
        for (const handler of this.handlers.values()) {
            if (handler.test(payload)) {
                consumed = true;
                await handler.run(ctx);
                if (!handler.continueAfterRun)
                    return true;
            }
        }
        return consumed;
    }
}
