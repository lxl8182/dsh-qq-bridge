import { randomUUID } from 'node:crypto'

const PERSONA_SECTION = 'qq-role:persona'

interface RoleMessage {
  id: string
  role: string
  content: ReadonlyArray<{ type: string; text?: string }>
}

interface RoleRequestHeader {
  config: Record<string, unknown>
  tools?: readonly unknown[]
}

interface RoleSession {
  id: string
  surface: { nodes: readonly number[] }
  requestHeader(): RoleRequestHeader | undefined
  append(type: 'request/header', data: { header: RoleRequestHeader; reason: 'series' }): void
  append(
    type: 'user/message',
    data: RoleMessage & { source: { kind: 'user' } },
    intent: { surfaceOp: { op: 'replace'; startSeq: number; endSeq: number }; sourceEventSeqs: number[] },
  ): void
}

export interface ActiveRoleInput {
  id: string
  historyLength: number
  historyId?: string
}

interface RoleScope {
  on(event: string, handler: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => void
  systemPrompt?: {
    section(section: { name: string; order: number; text: string; complete: true; interpolate: false }): () => void
    suppressRuntimeContext(): () => void
    context(context: { name: string; order: number; text: string; required: true }): () => void
  }
  tools?: {
    restrict(filter: { allow: readonly string[] }): () => void
    guard(guard: () => string): () => void
  }
}

export function installRoleOnlyPrompt(agentCtx: unknown, agentSession: unknown, persona: string, input: { current?: ActiveRoleInput }): void {
  const scope = agentCtx as RoleScope
  const session = agentSession as RoleSession
  if (!scope?.on || !scope.systemPrompt?.suppressRuntimeContext || !scope.tools?.restrict || !scope.tools.guard || !session?.surface) {
    throw new Error('当前 DSH host 缺少角色会话隔离接口。')
  }
  scope.systemPrompt.section({ name: PERSONA_SECTION, order: 0, text: persona, complete: true, interpolate: false })
  scope.systemPrompt.suppressRuntimeContext()
  // The host refreshes required context after prompt assembly.
  scope.systemPrompt.context({ name: 'working-directory:current', order: 100, text: '', required: true })
  // Desktop DSH attaches registered tool declarations after the prompt waterfall.
  scope.tools.restrict({ allow: [] })
  scope.tools.guard(() => 'QQ role chat has no tools')
  scope.on('system-prompt/assemble', async () => ({
    sections: [{ name: PERSONA_SECTION, text: persona, interpolate: false }],
    contexts: [],
    tools: [],
    variables: {},
  }), { prepend: true })

  scope.on('agent/pre-step', async ({ messages }: { messages: RoleMessage[] }) => {
    const current = input.current
    const message = messages.find(row => row.id === current?.id)
    if (!current || !message) return { kind: 'reject' }
    const header = session.requestHeader()
    if (header?.tools?.length) {
      // Repair the baseline within the open turn, before the loop can append
      // a tool-removal message for schemas logged by the previous bridge.
      const { tools: _previousTools, ...cleanHeader } = header
      session.append('request/header', { header: cleanHeader, reason: 'series' })
    }
    // Keep DSH's log and its reserved system node. Replace the previous model
    // surface with the shared transcript, then let the loop admit this input.
    const nodes = session.surface.nodes.slice(1)
    if (nodes.length) {
      const historyId = randomUUID()
      session.append('user/message', {
        id: historyId, role: 'user', source: { kind: 'user' },
        content: message.content.slice(0, current.historyLength),
      }, {
        surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes[nodes.length - 1]! },
        sourceEventSeqs: nodes,
      })
      current.historyId = historyId
      return { kind: 'enter', messages: [{ ...message, content: message.content.slice(current.historyLength) }], startsRequestSeries: true }
    }
    return { kind: 'enter', messages: [message], startsRequestSeries: true }
  }, { prepend: true })

  scope.on('llm/stream', (request: { sessionId?: string; messages: readonly RoleMessage[]; tools?: readonly unknown[] }, next: () => unknown) => {
    if (request.sessionId !== session.id) return next()
    const current = input.current
    const [system, first] = request.messages
    const user = request.messages.at(-1)
    if (!current || request.tools?.length || request.messages.length !== (current.historyId ? 3 : 2)
      || system?.role !== 'system' || system.content.length !== 1 || system.content[0]?.text !== persona
      || (current.historyId && (first?.role !== 'user' || first.id !== current.historyId))
      || user?.role !== 'user' || user.id !== current.id) {
      throw new Error('QQ 角色请求含有聊天记录和人设之外的上下文。')
    }
    return next()
  }, { prepend: true })
}
