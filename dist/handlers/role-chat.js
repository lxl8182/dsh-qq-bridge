import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collectInboundImages } from '../onebot/images.js';
import { imageStatusText } from '../onebot/message.js';
import { replyParts } from '../message-format.js';
import { sessionKeyOf } from './agent.js';
import { NEW_SESSION_COMMAND } from './model-control.js';
export function roleSessionKeyOf(sessionKey, roleId) {
    return `${sessionKey}::qq-role::${roleId}`;
}
export function roleConfigurationError(roles) {
    if (roles.length !== 4)
        return '多角色模式需要配置四个角色。';
    const ids = new Set(roles.map(role => role.id));
    if (ids.size !== 4 || roles.some(role => !/^[a-zA-Z0-9_-]+$/.test(role.id))) {
        return '四个角色的 id 必须互不重复，且只能包含字母、数字、下划线或连字符。';
    }
    for (const role of roles) {
        if (!role.name.trim() || /[\r\n]/.test(role.name) || !role.provider.trim() || !role.model.trim() || !role.persona.trim()) {
            return `请为 ${role.name.trim() || role.id} 填写单行名称、Provider、Model 和人设。`;
        }
    }
}
/** Each QQ chat has one transcript and four independently persisted DSH sessions. */
export class RoleChatCoordinator {
    path;
    roles;
    runner;
    maxMessageLength;
    name = 'agent';
    conversations = new Map();
    queues = new Map();
    writeTail = Promise.resolve();
    stopped = false;
    constructor(path, roles, runner, maxMessageLength) {
        this.path = path;
        this.roles = roles;
        this.runner = runner;
        this.maxMessageLength = maxMessageLength;
        const error = roleConfigurationError(roles);
        if (error)
            throw new Error(error);
    }
    async open() {
        let saved;
        try {
            saved = JSON.parse(await readFile(this.path, 'utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        if (saved?.schema !== 1 || !saved.conversations || typeof saved.conversations !== 'object') {
            throw new Error('QQ 多角色聊天记录格式无效。');
        }
        const sessions = [];
        for (const [sessionKey, conversation] of Object.entries(saved.conversations)) {
            if (!conversation?.sessions || !Array.isArray(conversation.messages) || !Array.isArray(conversation.archives)) {
                throw new Error(`QQ 多角色聊天记录格式无效（${sessionKey}）。`);
            }
            this.conversations.set(sessionKey, conversation);
            for (const [roleId, sessionId] of Object.entries(conversation.sessions)) {
                sessions.push({ sessionKey: roleSessionKeyOf(sessionKey, roleId), sessionId });
            }
        }
        this.runner.restoreSessions(sessions);
    }
    test(payload) { return payload.trim() !== ''; }
    run(ctx) {
        if (this.stopped)
            return Promise.resolve();
        const key = sessionKeyOf(ctx);
        const previous = this.queues.get(key) ?? Promise.resolve();
        const next = previous.then(async () => {
            if (this.stopped)
                return;
            try {
                await this.handleMessage(key, ctx);
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                console.warn(`[dsh-qq-bridge] role chat failed: ${reason}`);
                await ctx.respond(ctx.payload.trim() === NEW_SESSION_COMMAND
                    ? `重开多角色会话失败：${reason}`
                    : '多角色聊天处理失败，请稍后重试。');
            }
        }).finally(() => {
            if (this.queues.get(key) === next)
                this.queues.delete(key);
        });
        this.queues.set(key, next);
        return next;
    }
    async dispose() {
        this.stopped = true;
        await Promise.allSettled(this.queues.values());
    }
    async handleMessage(key, ctx) {
        let conversation = this.conversations.get(key);
        if (!conversation) {
            conversation = { sessions: {}, messages: [], archives: [] };
            this.conversations.set(key, conversation);
        }
        const platformKey = ctx.messageId === undefined ? undefined : JSON.stringify([String(ctx.userId), String(ctx.messageId)]);
        if (ctx.payload.trim() === NEW_SESSION_COMMAND) {
            if (platformKey !== undefined && platformKey === conversation.resetMessageKey && !conversation.reset)
                return;
            conversation.reset ??= 'archive';
            conversation.resetMessageKey = platformKey;
            await this.finishReset(key, conversation);
            await ctx.respond('已归档旧聊天并新建四个角色会话。');
            return;
        }
        if (conversation.reset)
            await this.finishReset(key, conversation);
        if (platformKey !== undefined && (conversation.messages.some(message => message.platformKey === platformKey)
            || conversation.archives.some(archive => archive.messages.some(message => message.platformKey === platformKey))))
            return;
        if (Object.values(conversation.sessions).some(id => this.runner.isSessionArchived?.(id))) {
            conversation.reset = 'archive';
            await this.finishReset(key, conversation);
        }
        const sources = ctx.images ?? [];
        const images = sources.length
            ? await this.runner.prepareImages((await collectInboundImages(sources)).images)
            : [];
        const attachments = images.flatMap(image => image.attachment ? [image.attachment] : []);
        const userMessage = {
            kind: 'user',
            speaker: ctx.scope === 'group' ? ctx.senderName || '用户' : '用户',
            text: imageStatusText(ctx.payload, sources, images),
            at: Date.now(),
            platformKey,
            ...(attachments.length ? { attachments } : {}),
        };
        const contentOf = (message) => [
            { type: 'text', text: JSON.stringify({ speaker: message.speaker, text: message.text }) + '\n' },
            ...(message.attachments ?? []).map(attachment => ({ type: 'image', attachment })),
        ];
        const turn = { history: conversation.messages.flatMap(contentOf), current: contentOf(userMessage) };
        conversation.messages.push(userMessage);
        await this.save();
        let sendTail = Promise.resolve();
        const results = await Promise.all(this.roles.map(async (role) => {
            try {
                await this.ensureSession(key, conversation, role);
                const text = (await this.runner.runRole(key, role, turn)).trim();
                if (!text)
                    throw new Error('模型未返回正文。');
                const message = { kind: 'assistant', speaker: role.name.trim(), text, at: Date.now(), delivery: 'pending' };
                conversation.messages.push(message);
                const persisted = this.save();
                const sent = sendTail.then(async () => {
                    try {
                        await persisted;
                        await this.sendReply(ctx, message);
                        message.delivery = 'sent';
                    }
                    catch (error) {
                        message.delivery = 'failed';
                        throw error;
                    }
                    finally {
                        await this.save();
                    }
                });
                sendTail = sent.catch(() => { });
                await sent;
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                console.warn(`[dsh-qq-bridge] role ${role.id} failed: ${reason}`);
                return role;
            }
        }));
        const failed = results.filter(role => role !== undefined);
        if (failed.length)
            await ctx.respond(`${failed.map(role => role.name).join('、')} 回复失败，请稍后重试。`);
    }
    async sendReply(ctx, message) {
        const prefix = `${message.speaker}: `;
        const limit = Math.max(1, this.maxMessageLength - Array.from(prefix).length);
        for (const part of replyParts(message.text, limit, false).parts) {
            await (ctx.send ?? ctx.respond)(prefix + part.trim());
        }
    }
    async ensureSession(key, conversation, role) {
        const sessionId = await this.runner.ensureRoleSession(key, role);
        if (conversation.sessions[role.id] === sessionId)
            return;
        conversation.sessions = { ...conversation.sessions, [role.id]: sessionId };
        await this.save();
    }
    async finishReset(key, conversation) {
        // Keep the old identities until all native archives succeed. Archival is idempotent.
        await this.save();
        if (conversation.reset === 'archive') {
            await this.finishAll(Object.entries(conversation.sessions).map(([id, sessionId]) => this.runner.archiveRoleSession(key, id, sessionId)));
            if (conversation.messages.length || Object.keys(conversation.sessions).length) {
                conversation.archives.push({ archivedAt: Date.now(), sessions: conversation.sessions, messages: conversation.messages });
            }
            conversation.sessions = {};
            conversation.messages = [];
            conversation.reset = 'create';
            await this.save();
        }
        await this.finishAll(this.roles.map(role => this.ensureSession(key, conversation, role)));
        delete conversation.reset;
        await this.save();
    }
    async finishAll(tasks) {
        const failed = (await Promise.allSettled(tasks)).find(result => result.status === 'rejected');
        if (failed)
            throw failed.reason;
    }
    save() {
        const body = JSON.stringify({ schema: 1, conversations: Object.fromEntries(this.conversations) });
        const write = async () => {
            await mkdir(dirname(this.path), { recursive: true });
            const temporary = `${this.path}.${randomUUID()}.tmp`;
            await writeFile(temporary, body, { mode: 0o600 });
            await rename(temporary, this.path);
        };
        const next = this.writeTail.then(write);
        this.writeTail = next.catch(() => { });
        return next;
    }
}
