import { randomUUID } from 'node:crypto';
import { roleChatContent } from './role-chat.js';
const PERSONA_SECTION = 'qq-role:persona';
export function installRoleOnlyPrompt(agentCtx, agentSession, persona, input) {
    const scope = agentCtx;
    const session = agentSession;
    if (!scope?.on || !scope.systemPrompt?.suppressRuntimeContext || !scope.tools?.restrict || !scope.tools.guard || !session?.surface) {
        throw new Error('当前 DSH host 缺少角色会话隔离接口。');
    }
    scope.systemPrompt.section({ name: PERSONA_SECTION, order: 0, text: persona, complete: true, interpolate: false });
    scope.systemPrompt.suppressRuntimeContext();
    // The host refreshes required context after prompt assembly.
    scope.systemPrompt.context({ name: 'working-directory:current', order: 100, text: '', required: true });
    // Desktop DSH attaches registered tool declarations after the prompt waterfall.
    scope.tools.restrict({ allow: [] });
    scope.tools.guard(() => 'QQ role chat has no tools');
    scope.on('system-prompt/assemble', async () => ({
        sections: [{ name: PERSONA_SECTION, text: persona, interpolate: false }],
        contexts: [],
        tools: [],
        variables: {},
    }), { prepend: true });
    scope.on('agent/pre-step', async ({ messages }) => {
        const current = input.current;
        const message = messages.find(row => row.id === current?.id);
        if (!current || !message)
            return { kind: 'reject' };
        const header = session.requestHeader();
        if (header?.tools?.length) {
            // Repair the baseline within the open turn, before the loop can append
            // a tool-removal message for schemas logged by the previous bridge.
            const { tools: _previousTools, ...cleanHeader } = header;
            session.append('request/header', { header: cleanHeader, reason: 'series' });
        }
        const [head, ...nodes] = session.surface.nodes;
        const lastIndex = current.transcript.length - 1;
        let nextIndex = 0;
        const staleFrom = nodes.findIndex(seq => {
            const event = session.eventAt(seq);
            if (event?.type === 'system/message' && event.data.message?.content.length === 0)
                return false;
            const source = event?.data.source;
            if (event?.type !== 'user/message' || source?.kind !== 'user'
                || source.qqRoleIndex !== nextIndex || nextIndex === lastIndex)
                return true;
            nextIndex++;
            return false;
        });
        if (staleFrom !== -1)
            current.staleNodes = nodes.slice(staleFrom);
        const messagesToAppend = current.transcript.slice(nextIndex).map((entry, offset) => {
            const qqRoleIndex = nextIndex + offset;
            return {
                id: qqRoleIndex === lastIndex ? message.id : randomUUID(),
                role: 'user',
                content: qqRoleIndex === lastIndex ? message.content : roleChatContent(entry),
                source: { kind: 'user', qqRoleIndex },
            };
        });
        const personaChanged = head !== undefined && session.eventAt(head)?.data.message?.content[0]?.text !== persona;
        return { kind: 'enter', messages: messagesToAppend, ...(personaChanged ? { startsRequestSeries: true } : {}) };
    }, { prepend: true });
    scope.on('agent/request', async ({ turn, step }, next) => {
        const config = await next();
        const current = input.current;
        const nodes = current?.staleNodes;
        if (current && nodes?.length) {
            // Keep the original assistant event in the log. The shared replies are
            // admitted in QQ order, without replaying the assistant's private blocks.
            session.append('system/message', {
                turn, step,
                message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } },
            }, {
                surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes[nodes.length - 1] },
                sourceEventSeqs: nodes,
            });
            delete current.staleNodes;
        }
        return config;
    }, { prepend: true });
    scope.on('llm/stream', (request, next) => {
        if (request.sessionId !== session.id)
            return next();
        const current = input.current;
        const [system, ...chat] = request.messages;
        if (!current || request.tools?.length || chat.length !== current.transcript.length
            || system?.role !== 'system' || system.content.length !== 1 || system.content[0]?.text !== persona
            || chat.at(-1)?.id !== current.id
            || chat.some((message, index) => message.role !== 'user' || message.source?.kind !== 'user'
                || message.source.qqRoleIndex !== index)) {
            throw new Error('QQ 角色请求含有聊天记录和人设之外的上下文。');
        }
        return next();
    }, { prepend: true });
}
