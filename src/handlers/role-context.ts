import { randomUUID } from 'node:crypto'
import { roleChatContent, type RoleChatTurn } from './role-chat.js'

const PERSONA_SECTION = 'qq-role:persona'

interface RoleMessage {
  id: string
  role: string
  content: ReadonlyArray<{ type: string; text?: string }>
  source?: { kind: string; qqRoleIndex?: number }
}

interface RoleRequestHeader {
  config: Record<string, unknown>
  tools?: readonly unknown[]
}

interface RoleSession {
  id: string
  surface: { nodes: readonly number[] }
  eventAt(seq: number): { type: string; data: { message?: RoleMessage; source?: RoleMessage['source'] } } | undefined
  requestHeader(): RoleRequestHeader | undefined
  append(type: 'request/header', data: { header: RoleRequestHeader; reason: 'series' }): void
  append(
    type: 'system/message',
    data: { turn: number; step: number; message: RoleMessage },
    intent: { surfaceOp: { op: 'replace'; startSeq: number; endSeq: number }; sourceEventSeqs: number[] },
  ): void
}

export interface ActiveRoleInput {
  id: string
  transcript: RoleChatTurn
  staleNodes?: number[]
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
    const [head, ...nodes] = session.surface.nodes
    const lastIndex = current.transcript.length - 1
    let nextIndex = 0
    const staleFrom = nodes.findIndex(seq => {
      const event = session.eventAt(seq)
      if (event?.type === 'system/message' && event.data.message?.content.length === 0) return false
      const source = event?.data.source
      if (event?.type !== 'user/message' || source?.kind !== 'user'
        || source.qqRoleIndex !== nextIndex || nextIndex === lastIndex) return true
      nextIndex++
      return false
    })
    if (staleFrom !== -1) current.staleNodes = nodes.slice(staleFrom)
    const messagesToAppend = current.transcript.slice(nextIndex).map((entry, offset) => {
      const qqRoleIndex = nextIndex + offset
      return {
        id: qqRoleIndex === lastIndex ? message.id : randomUUID(),
        role: 'user',
        content: qqRoleIndex === lastIndex ? message.content : roleChatContent(entry),
        source: { kind: 'user', qqRoleIndex },
      }
    })
    const personaChanged = head !== undefined && session.eventAt(head)?.data.message?.content[0]?.text !== persona
    return { kind: 'enter', messages: messagesToAppend, ...(personaChanged ? { startsRequestSeries: true } : {}) }
  }, { prepend: true })

  scope.on('agent/request', async ({ turn, step }: { turn: number; step: number }, next: () => Promise<unknown>) => {
    const config = await next()
    const current = input.current
    const nodes = current?.staleNodes
    if (current && nodes?.length) {
      // Keep the original assistant event in the log. The shared replies are
      // admitted in QQ order, without replaying the assistant's private blocks.
      session.append('system/message', {
        turn, step,
        message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } },
      }, {
        surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes[nodes.length - 1]! },
        sourceEventSeqs: nodes,
      })
      delete current.staleNodes
    }
    return config
  }, { prepend: true })

  scope.on('llm/stream', (request: { sessionId?: string; messages: readonly RoleMessage[]; tools?: readonly unknown[] }, next: () => unknown) => {
    if (request.sessionId !== session.id) return next()
    const current = input.current
    const [system, ...chat] = request.messages
    if (!current || request.tools?.length || chat.length !== current.transcript.length
      || system?.role !== 'system' || system.content.length !== 1 || system.content[0]?.text !== persona
      || chat.at(-1)?.id !== current.id
      || chat.some((message, index) => message.role !== 'user' || message.source?.kind !== 'user'
        || message.source.qqRoleIndex !== index)) {
      throw new Error('QQ 角色请求含有聊天记录和人设之外的上下文。')
    }
    return next()
  }, { prepend: true })
}
