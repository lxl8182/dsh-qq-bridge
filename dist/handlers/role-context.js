import { randomUUID } from 'node:crypto';
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
        // Keep DSH's log and its reserved system node. Replace the previous model
        // surface with the shared transcript, then let the loop admit this input.
        const nodes = session.surface.nodes.slice(1);
        if (nodes.length) {
            const historyId = randomUUID();
            session.append('user/message', {
                id: historyId, role: 'user', source: { kind: 'user' },
                content: message.content.slice(0, current.historyLength),
            }, {
                surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes[nodes.length - 1] },
                sourceEventSeqs: nodes,
            });
            current.historyId = historyId;
            return { kind: 'enter', messages: [{ ...message, content: message.content.slice(current.historyLength) }], startsRequestSeries: true };
        }
        return { kind: 'enter', messages: [message], startsRequestSeries: true };
    }, { prepend: true });
    scope.on('llm/stream', (request, next) => {
        if (request.sessionId !== session.id)
            return next();
        const current = input.current;
        const [system, first] = request.messages;
        const user = request.messages.at(-1);
        if (!current || request.tools?.length || request.messages.length !== (current.historyId ? 3 : 2)
            || system?.role !== 'system' || system.content.length !== 1 || system.content[0]?.text !== persona
            || (current.historyId && (first?.role !== 'user' || first.id !== current.historyId))
            || user?.role !== 'user' || user.id !== current.id) {
            throw new Error('QQ 角色请求含有聊天记录和人设之外的上下文。');
        }
        return next();
    }, { prepend: true });
}
