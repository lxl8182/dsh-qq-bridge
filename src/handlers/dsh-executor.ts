import { AgentExecutor } from './agent.js'
import type { InboundImage } from '../onebot/images.js'
import {
  BridgeModelInfo,
  BridgeModelSelection,
  BridgeModelSelectionRef,
  ModelSelectionController,
  PermissionController,
  resolveConfiguredModels,
  SessionLifecycleController,
} from './model-control.js'

/**
 * 提取 session surface 中最后一条 assistant 消息的纯文本。
 *
 * 兼容两种事件形状:
 * - **DSH 真实形状**: `{ type, seq, data: { message: { content: [...] } }, ... }`
 *   (assistant 消息体挂在 `data.message.content`)。
 * - 简易形状(用于本地测试): `{ type: 'assistant/message', content: [...] }`。
 */
export function extractLastAssistantText(events: readonly unknown[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i] as
      | {
          type?: string
          content?: readonly unknown[]
          data?: { message?: { content?: readonly unknown[] } }
        }
      | null
      | undefined
    if (!evt || evt.type !== 'assistant/message') continue
    const blocks = evt.data?.message?.content ?? evt.content
    if (!Array.isArray(blocks)) continue
    const text = blocks
      .filter((b): b is { type: string; text: string } => {
        const blk = b as { type?: string; text?: string }
        return !!blk && blk.type === 'text' && typeof blk.text === 'string'
      })
      .map((b) => b.text)
      .join('\n')
    if (text) return text
  }
  return null
}

/** 一轮内完成的可见消息按首次出现顺序合并，相同消息 ID 只采用最后的完整版本。 */
export function extractAssistantText(events: readonly unknown[]): string | null {
  const messages = new Map<string | number, string>()
  for (const [index, event] of events.entries()) {
    const row = event as { type?: string; content?: unknown[]; data?: { interrupted?: boolean; message?: { id?: string; content?: unknown[] } } }
    if (row.type !== 'assistant/message') continue
    const id = row.data?.message?.id ?? index
    if (row.data?.interrupted) { messages.delete(id); continue }
    const text = extractLastAssistantText([event])
    if (text && !isUnexecutedDsmlToolCall(text)) messages.set(id, text)
    else messages.delete(id)
  }
  return messages.size ? [...messages.values()].join('\n') : null
}

/** Read one committed turn without mixing in later followups. */
export function eventsForTurn(events: readonly unknown[], turn: number): readonly unknown[] {
  const start = events.findIndex(event => {
    const row = event as { type?: string; data?: { turn?: number } }
    return row.type === 'turn/start' && row.data?.turn === turn
  })
  if (start < 0) return []
  const end = events.findIndex((event, index) => {
    const row = event as { type?: string; data?: { turn?: number } }
    return index > start && row.type === 'turn/end' && row.data?.turn === turn
  })
  return events.slice(start, end < 0 ? undefined : end + 1)
}

/**
 * DSH 工具调用没有被运行时识别时,模型可能把 DSML 协议文本当普通 text 输出。
 * 这类内容不是有效回复,也不应透传给 QQ 用户。
 */
export function isUnexecutedDsmlToolCall(text: string): boolean {
  return text.includes('<｜｜DSML｜｜tool_calls>')
    || text.includes('<||DSML||tool_calls>')
    || /<tool_calls>\s*(?:<tool_calls>\s*)?<invoke\s+name=/i.test(text)
}

/**
 * 提取 session surface 中最后一条 user 消息的 id 与文本。
 *
 * 这是「这次输入」在 DSH 侧的稳定标识:每条用户消息的 id 由宿主生成且唯一,
 * 因此外部可以据此把一次删除/发送与具体的 DSH 轮次对上,而不必猜轮次序号。
 *
 * 兼容两种事件形状(与 `extractLastAssistantText` 同一套):
 * `{ type, data: { message } }` 与简易的 `{ type, content }`。
 */
export function extractLastUserMessage(
  events: readonly unknown[],
): { id: string; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i] as
      | {
          type?: string
          content?: readonly unknown[]
          data?: { id?: string; content?: readonly unknown[]; source?: { kind?: string }; message?: { id?: string; source?: { kind?: string }; content?: readonly unknown[] } }
        }
      | null
      | undefined
    if (!evt || evt.type !== 'user/message') continue
    // Memory or runtime-context injections are user-role but not the speaker's
    // own words; only `source.kind === 'user'` counts.
    if ((evt.data?.source ?? evt.data?.message?.source)?.kind !== 'user') continue
    const message = evt.data?.message ?? evt.data
    const blocks = message?.content ?? evt.content
    if (!Array.isArray(blocks)) continue
    const text = blocks
      .filter((b): b is { type: string; text: string } => {
        const blk = b as { type?: string; text?: string }
        return !!blk && blk.type === 'text' && typeof blk.text === 'string'
      })
      .map((b) => b.text)
      .join('\n')
    const id = typeof message?.id === 'string' ? message.id : ''
    if (id || text) return { id, text }
  }
  return null
}

/** 一个可投料、等待、可释放销毁的 DSH agent 会话。 */
export interface DshRenderedAgent {
  followup(message: { id: string; role: string; content: unknown; source: unknown }): void
  whenIdle(): Promise<void>
  /**
   * 读取该 live agent 会话的**实时**事件(即会话已提交的日志)。
   * 若实现提供,executor 优先用它提取回复,避免走持久化 corpus 的滞后;
   * 未提供则回退到 `DshServiceHandles.readSurface(sessionId)`。
   */
  readSurface?(): Promise<readonly unknown[]>
  /** 销毁该会话底层的 DSH agent(释放资源)。 */
  dispose(): Promise<void>
  /** 原始 DSH agent 对象;需要调用 host 原生命令服务时使用。 */
  _commandAgent?: unknown
}

export type DshCommandExecutor = (agent: unknown, line: string) => Promise<string | undefined>

/**
 * 上下文分段端口 —— 由外部策略(记忆插件)按需注入。
 *
 * 桥接层不知道「一段该多大」「带多少历史」;它只知道两件事:这一轮进模型之前
 * `prepareSession` 是一个安全窗口(上一轮已结束、气泡已发完、下一轮输入未受理),
 * 以及换会话的原语是 `startNewSession`。所以这里只留两个最小的问句,策略留在
 * 调用方。
 *
 * 两个方法都是**可选**的;缺失时 executor 完全退回原行为:同一个 QQ 来源从
 * 创建到卸载只有一个 DSH 会话,与未接线时逐字节相同。
 */
export interface DshSegmentPolicy {
  /**
   * 现在该不该换段。
   *
   * 调用时机:每一轮**进入模型之前**、本来源排队输入已空时精确调用一次
   * (见 `DshAgentExecutor.prepareSession`)。此刻上一轮的 `run()` 已经返回、
   * 气泡全部投递完毕,而下一轮输入还没进来 —— 因此不需要跟投递时序抢时间,
   * 也不会把一条正在生成的消息切成两段。
   *
   * @param sessionKey QQ 来源键。
   * @param sessionId 换段前这一轮原本要用的 DSH 会话 id(尚未建会话时为空串)。
   * @returns 需要换段时返回非空原因(写进日志/状态),否则 undefined。
   */
  shouldStartNewSegment?(sessionKey: string, sessionId: string): string | undefined | Promise<string | undefined>
  /**
   * 「换段已经发生」的通知,也是带上旧话的唯一时机。
   *
   * 调用时机:换段**已完成之后**、这一轮真正投给模型之前。策略在这里开新段、
   * 记下旧会话 id、准备好带进新段的那几句旧话;桥接层不保存也不解释它的内容。
   * 返回空串表示不带入。这里是通知而不是再次判定:再问一次会让两次判定不一致。
   *
   * @param sessionKey QQ 来源键。
   * @param previousSessionId 刚被归档的旧会话 id。
   * @param sessionId 新会话 id。
   */
  carryOverText?(sessionKey: string, previousSessionId: string, sessionId: string): void | Promise<void>
}

/**
 * DSH 服务句柄 —— 由插件注入,mock 可注入。
 * getOrCreate 必须返回带 dispose 的 live agent,便于 executor 统一释放。
 */
export interface DshServiceHandles {
  prepareImages?(images: readonly InboundImage[]): Promise<InboundImage[]>
  /** 按 sessionKey 获取(已有)或创建(miss)一个 live agent。 */
  getOrCreate(options: {
    sessionKey: string
    sessionId: string
    resume?: boolean
    cwd?: string
    modelSelection: BridgeModelSelectionRef
  }): Promise<DshRenderedAgent>
  /**
   * 投递用户消息并等待本轮完成。
   * @param onChunk 可选分段回调:agent 产出过程中的文本增量,便于流式回发。
   */
  deliver(
    agent: DshRenderedAgent,
    prompt: string,
    onChunk?: (text: string, kind: 'text' | 'reasoning') => void,
    /** 本轮随消息下载好的图片;实现方负责把它们变成 DSH 的 ImageBlock。 */
    images?: readonly InboundImage[],
  ): Promise<{ messageId: string } | void>
  /** 读取包含 turn/start/end 的完整会话事件，以定位本轮回复。 */
  readSurface(sessionId: string): Promise<readonly unknown[]>
}

/**
 * A 内置 handler 的 DSH 实现 —— 多轮上下文版本。
 *
 * - 每个 QQ sessionKey 持有一个常驻 live agent:首次创建、之后复用 → 保留多轮上下文。
 * - 同一 sessionKey 的并发消息串行排队,避免并发驱动同一会话。
 * - disposeAll() 在插件 teardown 时释放全部 live agent。
 * - disposeSession() 可主动丢弃某个会话(如错误恢复、会话上限)。
 */
export class DshAgentExecutor implements AgentExecutor, PermissionController, SessionLifecycleController {
  private agents = new Map<string, DshRenderedAgent>()
  private sessions = new Map<string, string>() // sessionKey -> sessionId
  private restoredSessions = new Set<string>()
  private sessionCwds = new Map<string, string>()
  private sessionVersions = new Map<string, number>()
  private sessionSelections = new Map<string, BridgeModelSelection>()
  private selectionRefs = new Map<string, BridgeModelSelectionRef>()
  private queues = new Map<string, Promise<void>>()
  /** 每个 sessionKey 最近一轮在 DSH 侧的会话与用户消息 id。 */
  private turnIdentities = new Map<string, { sessionId: string; messageId: string }>()
  /** 正在进行的换段,按来源去重:并发调用只会真正换一次。 */
  private segmentSwitches = new Map<string, Promise<void>>()
  /** 最近一次换段的事实,只读输出给状态/排查。 */
  private segmentSwitchesLog = new Map<string, { reason: string; previousSessionId: string; sessionId: string; at: number }>()
  /**
   * 本 executor 实例(即一次插件挂载/一次 host boot)唯一的后缀。
   * 避免跨 host 重启复用固定 sessionId 时,与磁盘上残留的旧会话发生 id collision。
   * 同一 boot 内多轮上下文仍通过 sessionKey→sessionId 映射保持。
   */
  private readonly bootSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  constructor(
    private readonly dsh: DshServiceHandles,
    private opts: {
      defaultCwd?: string
      defaultProvider?: string
      defaultModel?: string
      defaultReasoningEffort?: string
      models?: readonly string[]
      resolveModelSelection?: (selection: BridgeModelSelection) => Promise<BridgeModelSelection>
      listModels?: (provider: string) => Promise<BridgeModelInfo[]>
      executeCommand?: DshCommandExecutor
      /** 上下文分段端口;缺失时 executor 行为与未接线时完全一致。 */
      segmentPolicy?: DshSegmentPolicy
    } = {},
  ) {}

  async run(
    sessionKey: string,
    payload: string,
    onChunk?: (text: string, kind: 'text' | 'reasoning') => void,
    images?: readonly InboundImage[],
  ): Promise<string> {
    return await this.enqueue(sessionKey, () => this.runNow(sessionKey, payload, onChunk, images))
  }

  /**
   * 每轮进模型前调用一次:先看该不该换段,再给出这一轮真正要用的会话 id。
   *
   * 换段点选在这里,是因为这是整个收发流程里**唯一**同时满足三件事的时刻:
   * 上一轮的 `run()` 已经返回(它 resolve 即本轮完成)、气泡已按投递顺序发完、
   * 而下一轮的输入还没有被受理。因此不必跟投递时序抢时间。
   *
   * 未注入 `segmentPolicy` 时这里只有一次原样的建会话调用,行为与接线前一致。
   *
   * @param sessionKey QQ 来源键。
   * @returns 这一轮应当使用的 DSH 会话 id;刚换过段时就是新的那个。
   */
  async prepareSession(sessionKey: string): Promise<string> {
    await this.maybeStartNewSegment(sessionKey)
    return (await this.getOrCreateSessionAgent(sessionKey)).sessionId
  }

  async prepareImages(images: readonly InboundImage[]): Promise<InboundImage[]> {
    return this.dsh.prepareImages ? this.dsh.prepareImages(images) : [...images]
  }

  async retireSessionId(sessionId: string): Promise<void> {
    for (const [key, id] of this.sessions) {
      if (id === sessionId) { await this.startNewSession(key); return }
    }
  }

  /**
   * 最近完成的一轮在 DSH 侧的会话与用户消息 id。
   *
   * 只读:两个 id 都由宿主生成,桥接层只是把它们报告给订阅方。没有发生过一轮
   * 时返回 undefined,而不是编造一个。
   */
  lastTurnIdentity(sessionKey: string): { sessionId: string; messageId: string } | undefined {
    const record = this.turnIdentities.get(sessionKey)
    if (!record) return undefined
    return { sessionId: record.sessionId, messageId: record.messageId }
  }

  private async runNow(
    sessionKey: string,
    payload: string,
    onChunk?: (text: string, kind: 'text' | 'reasoning') => void,
    images?: readonly InboundImage[],
  ): Promise<string> {
    const { agent, sessionId } = await this.getOrCreateSessionAgent(sessionKey)

    this.turnIdentities.delete(sessionKey)
    const previousEventCount = (await this.readEvents(agent, sessionId)).length
    const delivered = await this.dsh.deliver(agent, payload, onChunk, images)
    const surface = await this.readEvents(agent, sessionId)
    let events = surface
    let inputCommitted = !delivered
    if (delivered) {
      const inputIndex = surface.findIndex(event => {
        const row = event as { type?: string; data?: { id?: string; message?: { id?: string } } }
        return row.type === 'user/message' && (row.data?.message ?? row.data)?.id === delivered.messageId
      })
      const start = [...surface.slice(0, inputIndex)].reverse().find(event =>
        (event as { type?: string }).type === 'turn/start') as { data?: { turn?: number } } | undefined
      if (inputIndex >= 0 && start?.data?.turn !== undefined) {
        events = eventsForTurn(surface, start.data.turn)
        inputCommitted = true
        this.turnIdentities.set(sessionKey, { sessionId, messageId: delivered.messageId })
      } else {
        // 准入失败可能在 user/message 提交前结束；先报告本次的真实错误。
        events = surface.slice(previousEventCount)
      }
    }
    const lastEnd = [...events].reverse().find(event =>
      (event as { type?: string })?.type === 'turn/end') as
      { data?: { reason?: { kind?: string; error?: { message?: string } } } } | undefined
    const reason = lastEnd?.data?.reason
    if (reason?.kind === 'blocked' || reason?.kind === 'error' || reason?.kind === 'aborted') {
      throw new Error(reason.error?.message ?? `DSH turn ${reason.kind}`)
    }
    if (!inputCommitted) throw new Error('DSH input turn was not committed')
    // Record the identity of the input this turn actually consumed, before the
    // reply is extracted: a later lookup must not pair a reply with the next
    // turn's input.
    const user = extractLastUserMessage(events)
    if (user?.id) this.turnIdentities.set(sessionKey, { sessionId, messageId: user.id })
    const text = extractAssistantText(events)
    if (text === null && events.some(event => isUnexecutedDsmlToolCall(extractLastAssistantText([event]) ?? ''))) {
      return [
        'agent 生成了一个未被 DSH 执行的工具调用,已拦截原始协议文本。',
        '这通常是当前模型/工具调用模式不匹配导致的。请换用支持 native tool calling 的模型,或调整 DSH_TOOLS_MODE 后重试。',
      ].join('\n')
    }
    if (text === null) {
      // 调试图:提取不到文本时无条件落盘(写到 workspace 内,host 与开发侧都能访问)。
      try {
        const fs = await import('node:fs')
        const dir = '/home/liangyihao/temp/dsh-qq-bridge'
        fs.writeFileSync(`${dir}/.debug-surface.json`, JSON.stringify(events, null, 2))
        try {
          const persisted = await this.dsh.readSurface(sessionId)
          fs.writeFileSync(`${dir}/.debug-persisted.json`, JSON.stringify(persisted, null, 2))
        } catch { /* noop */ }
      } catch { /* noop */ }
    }
    return text ?? '(agent produced no text)'
  }

  async runPermissionCommand(sessionKey: string, preset?: string): Promise<string> {
    return await this.enqueue(sessionKey, async () => {
      if (!this.opts.executeCommand) return '当前 host 不支持权限切换。'
      const { agent } = await this.getOrCreateSessionAgent(sessionKey)
      const line = preset?.trim() ? `/permission ${preset.trim()}` : '/permission'
      const text = await this.opts.executeCommand(agent._commandAgent ?? agent, line)
      return text ?? '当前 host 不支持权限切换。'
    })
  }

  /** 优先读 live agent 的实时会话日志,缺省则退回持久化 surface。 */
  private async readEvents(agent: DshRenderedAgent, sessionId: string): Promise<readonly unknown[]> {
    if (typeof agent.readSurface === 'function') {
      const live = await agent.readSurface()
      if (live && live.length) return live
    }
    return this.dsh.readSurface(sessionId)
  }

  /** 主动丢弃某个会话的 live agent。 */
  async disposeSession(sessionKey: string): Promise<void> {
    const agent = this.agents.get(sessionKey)
    if (agent) {
      this.agents.delete(sessionKey)
      await agent.dispose()
    }
    this.sessions.delete(sessionKey)
    this.restoredSessions.delete(sessionKey)
    this.queues.delete(sessionKey)
    // The identity belonged to the session that is gone; a new session must not
    // inherit it.
    this.turnIdentities.delete(sessionKey)
  }

  async startNewSession(sessionKey: string): Promise<void> {
    this.sessionVersions.set(sessionKey, this.getSessionVersion(sessionKey) + 1)
    await this.disposeSession(sessionKey)
  }

  /**
   * 按策略判定并在需要时换段。
   *
   * 三条不变量:
   * 1. **未注入策略时零行为变化**:直接返回,不建会话、不问任何问题;
   * 2. 并发调用只真正换一次(按来源去重),否则两条消息会各换一次、白白丢掉
   *    一段还在用的上下文;
   * 3. 换段后调用方必须拿到新 sessionId —— 由 `prepareSession` 保证:换段把
   *    `sessions` 里的映射清掉,紧接着的建会话必然产出新 id。
   *
   * 这里刻意不把换段塞进 `queues`:换段的原语 `disposeSession` 会删掉队列尾巴,
   * 在队列任务内部调用它会让后续消息绕过仍在收尾的这一次。单独的
   * `segmentSwitches` 表既能去重,也不干扰投递队列。
   */
  private async maybeStartNewSegment(sessionKey: string): Promise<void> {
    if (!this.opts.segmentPolicy?.shouldStartNewSegment) return
    const inFlight = this.segmentSwitches.get(sessionKey)
    if (inFlight) { await inFlight; return }
    const switchTask = this.runSegmentSwitch(sessionKey).finally(() => {
      if (this.segmentSwitches.get(sessionKey) === switchTask) this.segmentSwitches.delete(sessionKey)
    })
    this.segmentSwitches.set(sessionKey, switchTask)
    await switchTask
  }

  /** 问一次策略、换一个会话、再通知一次。任何一步失败都只记录,不阻断聊天。 */
  private async runSegmentSwitch(sessionKey: string): Promise<void> {
    const policy = this.opts.segmentPolicy
    if (!policy?.shouldStartNewSegment) return
    const previousSessionId = this.sessions.get(sessionKey) ?? ''
    let reason: string | undefined
    try {
      reason = (await policy.shouldStartNewSegment(sessionKey, previousSessionId)) ?? undefined
    } catch (error) {
      // 判定失败不等于该换段:策略坏了应当保持原会话继续聊天,而不是每轮换一次。
      this.loggerFor(`[dsh-qq-bridge] segment policy failed: ${messageOf(error)}`)
      return
    }
    if (!reason) return
    await this.startNewSession(sessionKey)
    const sessionId = (await this.getOrCreateSessionAgent(sessionKey)).sessionId
    this.segmentSwitchesLog.set(sessionKey, { reason, previousSessionId, sessionId, at: Date.now() })
    this.loggerFor(`[dsh-qq-bridge] segment switched (${reason}): ${sessionKey} ${previousSessionId || '(none)'} -> ${sessionId}`)
    if (!policy.carryOverText) return
    try {
      await policy.carryOverText(sessionKey, previousSessionId, sessionId)
    } catch (error) {
      // 通知失败只会让新段少几句旧话,不影响这一轮能不能回。
      this.loggerFor(`[dsh-qq-bridge] segment carry-over failed: ${messageOf(error)}`)
    }
  }

  /**
   * 安装/替换段判定端口。
   *
   * 与构造参数二选一:宿主插件之间的启用顺序不确定,构造期往往还拿不到对方的
   * 服务,所以允许在 executor 建好之后再装上。传 undefined 即卸载,之后行为
   * 与从未装过完全一致。
   *
   * @param policy 段判定端口,或 undefined 表示卸载。
   */
  setSegmentPolicy(policy: DshSegmentPolicy | undefined): void {
    this.opts.segmentPolicy = policy
    if (!policy) this.segmentSwitchesLog.clear()
  }

  /** 最近一次换段的事实;没换过时为 undefined。只读,不产生副作用。 */
  lastSegmentSwitch(sessionKey: string): { reason: string; previousSessionId: string; sessionId: string; at: number } | undefined {
    const record = this.segmentSwitchesLog.get(sessionKey)
    return record ? { ...record } : undefined
  }

  /** 记一行日志,但不要求宿主一定提供 logger。 */
  private loggerFor(line: string): void {
    try { console.warn(line) } catch { /* logging must never break a turn */ }
  }

  getSessionVersion(sessionKey: string): number {
    return this.sessionVersions.get(sessionKey) ?? 0
  }

  getModelSelection(sessionKey: string): BridgeModelSelection {
    return this.selectionRef(sessionKey).current
  }

  async selectModel(sessionKey: string, model: string): Promise<BridgeModelSelection> {
    const current = this.getModelSelection(sessionKey)
    const selected = await this.resolveSelection({
      provider: current.provider,
      model,
    })
    this.setSelection(sessionKey, selected)
    return selected
  }

  async selectReasoningEffort(sessionKey: string, effort: string): Promise<BridgeModelSelection> {
    const current = this.getModelSelection(sessionKey)
    const selected = await this.resolveSelection({
      provider: current.provider,
      model: current.model,
      reasoningEffort: effort,
    })
    this.setSelection(sessionKey, selected)
    return selected
  }

  async listModels(sessionKey: string): Promise<BridgeModelInfo[]> {
    const provider = this.getModelSelection(sessionKey).provider
    if (this.opts.listModels) {
      const models = await this.opts.listModels(provider)
      if (models.length > 0) return models
    }
    return resolveConfiguredModels(this.opts.defaultModel ?? 'deepseek-v4-flash', this.opts.models)
      .map(id => ({ provider, id, name: id }))
  }

  /** 切换某个 QQ 来源的工作目录;下一轮会创建新的 DSH session。 */
  async setCwd(sessionKey: string, cwd: string): Promise<void> {
    this.sessionCwds.set(sessionKey, cwd)
    await this.startNewSession(sessionKey)
  }

  /** 当前 QQ 来源的工作目录;未切换时返回配置默认目录或 host cwd。 */
  getCwd(sessionKey: string): string {
    return this.sessionCwds.get(sessionKey) ?? this.opts.defaultCwd ?? process.cwd()
  }

  /** 释放全部 live agent(插件 teardown 时调用)。 */
  async disposeAll(): Promise<void> {
    const agents = [...this.agents.values()]
    this.agents.clear()
    this.sessions.clear()
    this.restoredSessions.clear()
    this.sessionCwds.clear()
    this.sessionVersions.clear()
    this.sessionSelections.clear()
    this.selectionRefs.clear()
    this.queues.clear()
    this.turnIdentities.clear()
    this.segmentSwitches.clear()
    this.segmentSwitchesLog.clear()
    await Promise.all(agents.map((a) => a.dispose()))
  }

  /**
   * 当前 QQ 会话对应的 DSH session id,尚未建会话时为 undefined。
   *
   * 只读:把「同一 QQ 来源」和「同一 DSH 会话」关联起来,供外部按会话记录或退役;
   * 它不创建会话也不改变映射。
   */
  currentSessionId(sessionKey: string): string | undefined {
    return this.sessions.get(sessionKey)
  }

  restoreSessions(sessions: readonly { sessionKey: string; sessionId: string }[]): void {
    for (const { sessionKey, sessionId } of sessions) {
      if (!this.sessions.has(sessionKey)) {
        this.sessions.set(sessionKey, sessionId)
        this.restoredSessions.add(sessionKey)
      }
    }
  }

  get liveSessionCount(): number {
    return this.agents.size
  }

  private async enqueue<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionKey) ?? Promise.resolve()
    const next = prev.then(task)
    // 吞掉队列尾部错误,避免串行链断掉后续消息
    this.queues.set(sessionKey, next.then(() => undefined, () => undefined))
    return await next
  }

  private async getOrCreateSessionAgent(sessionKey: string): Promise<{ agent: DshRenderedAgent; sessionId: string }> {
    const sessionIdExists = this.sessions.get(sessionKey)
    const sessionId = sessionIdExists ?? this.createSessionId(sessionKey)
    this.sessions.set(sessionKey, sessionId)

    let agent = this.agents.get(sessionKey)
    if (!agent) {
      agent = await this.dsh.getOrCreate({
        sessionKey,
        sessionId,
        resume: this.restoredSessions.has(sessionKey),
        cwd: this.sessionCwds.get(sessionKey) ?? this.opts.defaultCwd,
        modelSelection: this.selectionRef(sessionKey),
      })
      this.agents.set(sessionKey, agent)
      this.restoredSessions.delete(sessionKey)
    }
    return { agent, sessionId }
  }

  private createSessionId(sessionKey: string): string {
    const version = this.sessionVersions.get(sessionKey) ?? 0
    return `qq-${hashKey(sessionKey)}-${this.bootSuffix}-${version}`
  }

  private selectionRef(sessionKey: string): BridgeModelSelectionRef {
    const existing = this.selectionRefs.get(sessionKey)
    if (existing) return existing
    const ref: BridgeModelSelectionRef = {
      current: this.sessionSelections.get(sessionKey) ?? this.defaultSelection(),
    }
    this.selectionRefs.set(sessionKey, ref)
    return ref
  }

  private setSelection(sessionKey: string, selection: BridgeModelSelection): void {
    this.sessionSelections.set(sessionKey, selection)
    this.selectionRef(sessionKey).current = selection
  }

  private async resolveSelection(selection: BridgeModelSelection): Promise<BridgeModelSelection> {
    if (this.opts.resolveModelSelection) return await this.opts.resolveModelSelection(selection)
    return selection
  }

  private defaultSelection(): BridgeModelSelection {
    return {
      provider: this.opts.defaultProvider ?? 'deepseek-official',
      model: this.opts.defaultModel ?? 'deepseek-v4-flash',
      // 显式默认思考强度:不传时,部分 provider(裸 openai-completions)会完全不
      // 思考,表现为"同一个模型在 QQ 里变笨"。配置留空则保持适配器自身行为。
      ...(this.opts.defaultReasoningEffort
        ? { reasoningEffort: this.opts.defaultReasoningEffort }
        : {}),
    }
  }
}

/** 把任意抛出物收敛成一行可读原因。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 确定性哈希,把任意 sessionKey 映射到固定长度可用的 session id。 */
export function hashKey(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
