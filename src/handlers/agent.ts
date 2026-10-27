import { Handler, HandlerContext } from '../router.js'
import {
  parseQqControlBlocks, parseQqSpells,
  QqControlDispatcher, QqSpellDispatcher,
} from './control.js'
import { AgentRunGate } from '../web-activity.js'
import { DeliveryStore, type DeliveryTurn, type DeliveryPart, type SavedInput } from '../delivery-store.js'
import type { QqTurnInput } from '../bridge-events.js'
import { collectInboundImages, type InboundImage } from '../onebot/images.js'

/**
 * 历史配置字段 qqReplyStyleSkill 的默认 skill 名。
 *
 * 配置仍然解析(旧 profile 不会因此报错),但桥接层不再用它注入任何 prompt:
 * QQ 入站消息的原文逐字交给 Agent,不附加来源说明、临时风格标记或自动 skill 调用。
 */
export const DEFAULT_QQ_REPLY_STYLE_SKILL_NAME = 'qq-session-reply-style'

/** qqReplyStyleSkill 的解析结果。仅为配置兼容保留,不再影响交给 Agent 的内容。 */
export interface QqReplyStyleSkillOptions {
  enabled?: boolean
  skillName?: string
}

export function sessionKeyOf(ctx: Pick<HandlerContext, 'scope' | 'userId' | 'groupId'>): string {
  return `${ctx.scope}:${ctx.scope === 'private' ? ctx.userId : ctx.groupId}`
}

/**
 * 把文本按最大长度切分为多条,保证每条不超过 maxLen。
 * 优先在换行/标点附近切(保持可读),实在没有边界则硬切。
 */
export function splitText(text: string, maxLen: number): string[] {
  if (maxLen <= 0 || text.length <= maxLen) return text === '' ? [] : [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > maxLen) {
    // 在 maxLen-1 往前找最近的换行或标点作为切点(留一位容纳标点)
    const searchTo = maxLen - 1
    let cut = rest.lastIndexOf('\n', searchTo)
    if (cut <= 0) cut = Math.max(
      rest.lastIndexOf('。', searchTo),
      rest.lastIndexOf('！', searchTo),
      rest.lastIndexOf('？', searchTo),
      rest.lastIndexOf('.', searchTo),
      rest.lastIndexOf('，', searchTo),
      rest.lastIndexOf(',', searchTo),
    )
    if (cut <= 0) cut = searchTo // 无边界,硬切(maxLen-1,保证 <= maxLen)
    parts.push(rest.slice(0, cut + 1).trimStart())
    rest = rest.slice(cut + 1)
  }
  if (rest.trim()) parts.push(rest.trimStart())
  return parts.filter((p) => p.length > 0)
}

/**
 * 可注入的“遥控 DSH Agent”执行器。
 * 生产环境由 Cordis 插件接入 DSH 的 agents/agentLoop 服务注入;
 * 测试时可注入一个假执行器,无需真实 DSH。
 */
export interface AgentExecutor {
  prepareSession?(sessionKey: string): Promise<string>
  /**
   * 把 payload 交给一个 DSH Agent 会话处理,返回最终文本。
   * @param sessionKey 用于把同一 QQ 会话映射到固定 AgentId(多轮上下文)
   * @param payload 用户消息
   * @param onChunk 可选:agent 产出过程中的分段回调(流式返回)。
   *        kind='text' 为最终回复文本增量;kind='reasoning' 为思考过程增量。
   */
  run(
    sessionKey: string,
    payload: string,
    onChunk?: (text: string, kind: 'text' | 'reasoning') => void,
    /**
     * 本轮随消息一起下载好的图片。缺省表示没有图片,或图片全部不可用。
     * 实现方必须容忍缺失:图片是增量能力,不是调用前提。
     */
    images?: readonly InboundImage[],
  ): Promise<string>
  /**
   * 本轮真实用户消息在 DSH 侧的身份(可选)。
   *
   * 存在时,报告里的 `turnMessageId` 就是宿主生成的用户消息 id,外部据此把
   * 保存与发送对齐到同一轮;不实现时该字段缺省,调用方不得用平台 id 冒充。
   */
  lastTurnIdentity?(sessionKey: string): { sessionId?: string; messageId?: string } | undefined
}

/**
 * 一次 QQ 生成轮次结束后的对外事实。
 *
 * 只为接入方(例如记忆插件)记录真实发生的事:真实用户输入、桥接层解析控制块
 * 之后真正发出去的可见文字,以及每个分段是否被平台接受。不含思考过程、工具日志
 * 或桥接自己的确认/错误提示。
 */
export interface QqTurnReport {
  sessionKey: string
  /** 这一轮所在的 DSH 会话 id;尚未建立会话时缺省。 */
  sessionId?: string
  scope: 'private' | 'group'
  userId: string | number
  groupId?: string | number
  /** 已通过 bridge 配置校验的拥有者;人格与个人记忆只跟随它。 */
  owner: boolean
  /** 入站平台消息 id,用于把一条输入与它引起的轮次关联。 */
  messageId?: string | number
  /**
   * DSH 会话里那条真实用户消息的 id。
   *
   * 这是「这次输入」在 DSH 侧的唯一稳定标识,记忆插件用它把保存与发送对上;
   * 平台消息 id 不能替代它(同一个 QQ 消息 id 不会出现在 DSH 会话里)。
   */
  turnMessageId?: string
  /** 指令前缀剥离后的真实用户输入。 */
  input: string
  /** 桥接层解析控制块后的最终对外文字;没有可发文字时为空串。 */
  reply: string
  /** 实际发送成功的分段,含平台消息 id(平台未提供时缺省)。 */
  parts: Array<{ index: number; chars: number; platformId?: string; ok: boolean; error?: string }>
  status: 'completed' | 'failed' | 'interrupted'
  generationStatus?: 'completed' | 'failed' | 'interrupted'
  /** 失败/中断原因;成功时缺省。 */
  reason?: string
}

export interface AgentTurnObserver {
  (report: QqTurnReport): void
}

/**
 * A 内置 handler:QQ 消息 → 遥控 DSH Agent → 回发。
 */
export class AgentRpcHandler implements Handler {
  name = 'agent'
  private readonly delivery: DeliveryStore
  private readonly active = new WeakMap<HandlerContext, DeliveryTurn>()
  private readonly queues = new Map<string, Promise<void>>()
  private stopped = false

  constructor(
    private readonly executor: AgentExecutor,
    private readonly opts: {
      streamReasoning?: boolean
      /** 是否边生成边回发 text 分段;默认 false,等待 agent 本轮完成后只发送最终回复。 */
      streamText?: boolean
      /** 单条 QQ 消息最大长度;超长自动拆分为多条发送。 */
      maxMessageLength?: number
      /** 收到有效指令后立即回发的确认消息;设为空字符串可关闭。 */
      ackMessage?: string
      /** Agent 超时时间(ms);未设置时不限制 QQ 对话等待时间。 */
      timeoutMs?: number
      /** Agent 长时间无响应时回发的消息。 */
      timeoutMessage?: string
      /**
       * 旧配置 qqReplyStyleSkill 的解析结果:保留字段只为配置兼容,
       * 不再参与 prompt 拼装,也不会触发任何 skill 调用。
       */
      qqReplyStyleSkill?: QqReplyStyleSkillOptions
      /** 由桥接层自己处理、不应再进入 Agent 的命令前缀。 */
      reservedCommands?: readonly string[]
      /** 单条消息最多取几张图;缺省 4。 */
      maxImages?: number
      /** 单张入站图片的字节上限;超出即丢弃,不截断。 */
      maxImageBytes?: number
      /** 单张图片的下载超时(ms);超时只损失这张图。 */
      imageTimeoutMs?: number
      /** 测试注入用的 fetch;生产留空即用全局 fetch。 */
      fetchImpl?: typeof fetch
      /** Assistant 输出控制块的执行器。存在时会先解析最终文本再回发。 */
      controlDispatcher?: QqControlDispatcher
      /** @deprecated 咒语由 companion-memory 插件执行；桥接层只剥离标签。 */
      spellDispatcher?: QqSpellDispatcher
      /** Web session 正在运行时,延后 QQ agent run 的全局 gate。 */
      webActivityGate?: AgentRunGate
      /** Web session 忙时先回发给 QQ 的提示。 */
      webBusyMessage?: string
      /** 当前 QQ 来源对应的 DSH 会话 id(只读关联,用于按会话记录/退役)。 */
      sessionIdOf?: (sessionKey: string) => string | undefined
      /** 一轮真实结束后报告对外事实;不含思考过程、工具日志或内部提示。 */
      observeTurn?: AgentTurnObserver
      prepareTurn?: (input: QqTurnInput) => Promise<void>
      deliveryStatePath?: string
      restoreContext?: (input: SavedInput) => HandlerContext | undefined
    } = {},
  ) { this.delivery = new DeliveryStore(opts.deliveryStatePath) }

  async open(): Promise<void> { await this.delivery.open() }
  async dispose(): Promise<void> { this.stopped = true; await this.delivery.save() }
  completedReports(): QqTurnReport[] {
    return Object.values(this.delivery.turns).flatMap(turn => turn.report ? [turn.report] : [])
  }

  async retireSession(sessionId: string): Promise<void> {
    for (const turn of Object.values(this.delivery.turns)) {
      if (turn.sessionId !== sessionId && turn.report?.sessionId !== sessionId) continue
      if (turn.state === 'waiting') {
        delete turn.sessionId
        turn.parts = []
        continue
      }
      turn.retired = true
      turn.state = 'complete'
      turn.input.payload = ''
      turn.parts = []
      delete turn.report
    }
    await this.delivery.save()
  }

  private enqueue(key: string, run: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(run)
    const settled = next.catch(() => {})
    this.queues.set(key, settled)
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key) })
    return next
  }

  async retryPending(): Promise<void> {
    if (this.stopped || !this.opts.restoreContext) return
    for (const turn of Object.values(this.delivery.turns)) {
      if (turn.externallyManaged) continue
      if (turn.state !== 'waiting' && turn.state !== 'output') continue
      const ctx = this.opts.restoreContext(turn.input)
      if (!ctx) { turn.state = 'failed'; await this.delivery.save(); continue }
      await this.enqueue(sessionKeyOf(ctx), async () => {
        if (this.stopped) return
        if (turn.state === 'waiting') await this.process(ctx, turn)
        else if (turn.state === 'output') {
          for (const part of turn.parts) if (part.state === 'pending') await this.sendPart(ctx, part)
          await this.finishDelivery(turn)
        }
      })
    }
  }

  /** Session followups have no inbound HandlerContext; reuse durable delivery. */
  async deliverOutput(input: QqTurnInput, outputId: string, parts: Array<{ index: number; text: string }>, canSend: () => Promise<boolean>) {
    if (this.stopped || !input.owner || input.scope !== 'private' || !input.sessionId || !this.opts.restoreContext) {
      throw new Error('QQ output session is unavailable')
    }
    const ctx = this.opts.restoreContext({
      scope: input.scope, userId: input.userId, owner: true, payload: '',
      messageId: outputId,
    })
    if (!ctx) throw new Error('QQ output route is unavailable')
    let result: { status: 'completed' | 'failed' | 'cancelled'; parts: Array<{ index: number; ok: boolean; platformId?: string; error?: string }> } | undefined
    await this.enqueue(input.sessionKey, async () => {
      if (this.stopped || this.opts.sessionIdOf?.(input.sessionKey) !== input.sessionId) {
        throw new Error('QQ output session was replaced')
      }
      const { turn } = await this.delivery.accept(ctx, {
        sessionId: input.sessionId!,
        externallyManaged: true,
        parts: parts.map(part => ({ text: part.text, outputIndex: part.index, kind: 'reply', state: 'pending' })),
      })
      if (turn.retired) throw new Error('QQ output was retired')
      this.active.set(ctx, turn)
      try {
        let cancelled = false
        for (const part of turn.parts) if (part.state === 'pending') {
          if (!await canSend()) { cancelled = true; break }
          await this.sendPart(ctx, part)
        }
        await this.finishDelivery(turn)
        result = {
          status: cancelled ? 'cancelled' : turn.state === 'complete' ? 'completed' : 'failed',
          parts: turn.parts.map((part, index) => ({
            index: part.outputIndex ?? index, ok: part.state === 'sent',
            platformId: part.platformId, error: part.error,
          })),
        }
      } finally { this.active.delete(ctx) }
    })
    if (!result) throw new Error('QQ output delivery did not run')
    return result
  }

  /** Session followups have no inbound HandlerContext; reuse durable delivery. */
  async sendSessionOutput(input: QqTurnInput, turnNumber: number, result: string): Promise<void> {
    if (this.stopped || !input.sessionId || !this.opts.restoreContext) return
    const ctx = this.opts.restoreContext({ scope: input.scope, userId: input.userId,
      groupId: input.groupId, owner: input.owner, payload: '',
      messageId: `dsh-output:${input.sessionId}:${turnNumber}` })
    if (!ctx) return
    await this.enqueue(input.sessionKey, async () => {
      if (this.stopped || this.opts.sessionIdOf?.(input.sessionKey) !== input.sessionId) return
      const visible = parseQqControlBlocks(parseQqSpells(result).visibleText).visibleText
      const parts: DeliveryPart[] = splitText(visible, this.opts.maxMessageLength ?? 4500)
        .map(text => ({ text, kind: 'reply', state: 'pending' }))
      // The first persisted state already contains the output. A crash must
      // never turn generated feedback into an empty input waiting for a model.
      const { turn, duplicate } = await this.delivery.accept(ctx, { sessionId: input.sessionId!, parts })
      if (duplicate) return
      this.active.set(ctx, turn)
      try {
        // No user-turn report: feedback is not a new statement by the user.
        for (const part of turn.parts) await this.sendPart(ctx, part)
        await this.finishDelivery(turn)
      } finally { this.active.delete(ctx) }
    })
  }

  private async sendPart(ctx: HandlerContext, part: DeliveryPart): Promise<void> {
    if (this.stopped || this.active.get(ctx)?.retired) return
    part.state = 'sending'
    await this.delivery.save()
    try {
      const receipt = ctx.send ? await ctx.send(part.text) : (await ctx.respond(part.text), {})
      part.state = 'sent'
      part.platformId = receipt?.platformId
      delete part.error
    } catch (error) {
      const fault = error as { name?: string; code?: string }
      part.state = fault.name === 'TimeoutError' || fault.name === 'AbortError'
        || ['ETIMEDOUT', 'ECONNRESET'].includes(fault.code ?? '') ? 'unknown' : 'pending'
      part.error = error instanceof Error ? error.message : String(error)
    }
    await this.delivery.save()
  }

  private async finishDelivery(turn: DeliveryTurn): Promise<void> {
    if (turn.retired) return
    turn.state = turn.parts.some(part => part.state === 'unknown') ? 'unknown'
      : (turn.parts.every(part => part.state === 'sent') ? 'complete' : 'output')
    if (turn.report) {
      const parts = turn.parts.filter(part => part.kind === 'reply')
      turn.report = { ...turn.report,
        status: turn.state === 'complete' ? 'completed' : 'failed',
        parts: parts.map((part, index) => ({ index, chars: Array.from(part.text).length,
          ok: part.state === 'sent', ...(part.platformId === undefined ? {} : { platformId: part.platformId }),
          ...(part.error === undefined ? {} : { error: part.error }) })),
      }
      this.opts.observeTurn?.(turn.report)
    }
    await this.delivery.save()
  }

  test(payload: string): boolean {
    if (this.opts.reservedCommands?.some((command) => payload === command || payload.startsWith(`${command} `))) {
      return false
    }
    // 默认所有有效载荷都交给 Agent(可扩展:保留特定子命令给其它 handler)。
    // 若不希望 Agent 吞掉所有指令,可改成匹配某前缀,例如 payload 以 `ask ` 开头。
    return true
  }

  /** 把一段文本按 maxLen 切分后逐条回发,并带回每段的平台回执。 */
  private async respondChunk(
    ctx: HandlerContext,
    chunk: string,
    kind: 'reply' | 'control' = 'control',
  ): Promise<Array<{ index: number; chars: number; platformId?: string; ok: boolean; error?: string }>> {
    const maxLen = this.opts.maxMessageLength ?? 4500
    const parts = splitText(chunk, maxLen)
    const sent: Array<{ index: number; chars: number; platformId?: string; ok: boolean; error?: string }> = []
    const turn = this.active.get(ctx)
    if (turn) {
      const staged: DeliveryPart[] = parts.map(text => ({ text, kind, state: 'pending' }))
      turn.parts.push(...staged)
      await this.delivery.save()
      for (const part of staged) {
        await this.sendPart(ctx, part)
        sent.push({ index: sent.length, chars: Array.from(part.text).length, ok: part.state === 'sent',
          ...(part.platformId === undefined ? {} : { platformId: part.platformId }),
          ...(part.error === undefined ? {} : { error: part.error }) })
      }
      return sent
    }
    for (const part of parts) {
      const index = sent.length
      try {
        const receipt = ctx.send ? await ctx.send(part) : (await ctx.respond(part), {})
        sent.push({
          index,
          chars: Array.from(part).length,
          ...(receipt && typeof receipt === 'object' && receipt.platformId !== undefined
            ? { platformId: String(receipt.platformId) } : {}),
          ok: true,
        })
      } catch (err) {
        // Keep the remaining parts unsent: a split reply that failed midway is
        // retried from the failed segment, never resent in full.
        sent.push({
          index,
          chars: Array.from(part).length,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return sent
  }

  async run(ctx: HandlerContext): Promise<void> {
    if (this.stopped) return
    if (!this.opts.deliveryStatePath) return this.process(ctx)
    await this.enqueue(sessionKeyOf(ctx), async () => {
      const { turn, duplicate } = await this.delivery.accept(ctx)
      if (duplicate) return
      await this.process(ctx, turn)
    }).catch(async error => {
      const full = String(error?.message).includes('队列已满')
      console.warn(`[dsh-qq-bridge] delivery state failed: ${error instanceof Error ? error.message : String(error)}`)
      await ctx.respond(full ? 'QQ 待处理队列已满，本条尚未受理，请稍后重发。'
        : '本机消息状态保存失败，本轮已停止，请检查 DSH 存储后核对结果。')
    })
  }

  private async process(ctx: HandlerContext, turn?: DeliveryTurn): Promise<void> {
    if (this.stopped) return
    if (turn) this.active.set(ctx, turn)
    const sessionKey = sessionKeyOf(ctx)
    // The agent receives exactly the user's words: no source banner, no style
    // marker, no auto-invoked skill. Anything the bridge wrapped in would become
    // part of what the model reads, so the payload stays verbatim.
    const payload = ctx.payload
    const gate = this.opts.webActivityGate
    if (gate?.isBusy()) {
      await this.respondChunk(ctx, this.opts.webBusyMessage ?? '当前 Web 会话正在运行，请稍后...')
      await gate.enqueueWhenIdle(() => this.runAgentTurn(ctx, sessionKey, payload))
      return
    }
    await this.runAgentTurn(ctx, sessionKey, payload)
    this.active.delete(ctx)
  }

  /**
   * 下载本条消息里的图片。
   *
   * 任何失败都只让这一张图缺席:文本照常送达,整轮不会因为图片坏掉而失败。
   * 丢弃原因写日志(不含字节、不含 base64),便于事后判断是链接过期还是类型不支持。
   * @param ctx - 含图片地址的入站上下文。
   * @returns 成功编码的图片;没有图片或全部失败时返回空数组。
   */
  private async collectImages(ctx: HandlerContext): Promise<InboundImage[]> {
    const sources = ctx.images
    if (!sources || sources.length === 0) return []
    try {
      const { images, skipped } = await collectInboundImages(sources, {
        maxImages: this.opts.maxImages,
        maxBytes: this.opts.maxImageBytes,
        timeoutMs: this.opts.imageTimeoutMs,
        ...(this.opts.fetchImpl === undefined ? {} : { fetchImpl: this.opts.fetchImpl }),
      })
      for (const reason of skipped) {
        console.warn(`[dsh-qq-bridge] inbound image skipped: ${reason}`)
      }
      return images
    } catch (error) {
      console.warn(`[dsh-qq-bridge] inbound image collection failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private async runAgentTurn(ctx: HandlerContext, sessionKey: string, payload: string): Promise<void> {
    // 图片在这里才下载:确认本轮真要交给 Agent 之后,而不是在路由分流时。
    // 失败只记录,不改变文本轮次的任何行为。
    const images = await this.collectImages(ctx)
    const ackMessage = this.opts.ackMessage ?? '收到，正在处理...'
    const timeoutMs = this.opts.timeoutMs
    const timeoutMessage = this.opts.timeoutMessage ?? 'agent 无响应，请稍后重试。'
    let active = true
    try {
      const sessionId = await this.executor.prepareSession?.(sessionKey)
      const stored = this.active.get(ctx)
      if (stored) { stored.sessionId = sessionId; await this.delivery.save() }
      await this.opts.prepareTurn?.({ sessionKey, sessionId, scope: ctx.scope, owner: ctx.owner,
        userId: ctx.userId, groupId: ctx.groupId, messageId: ctx.messageId, input: ctx.payload })
      if (this.stopped) return
      if (stored) { stored.state = 'running'; await this.delivery.save() }
      if (ackMessage) await this.respondChunk(ctx, ackMessage)
      const canStreamText = this.opts.streamText && !this.opts.controlDispatcher && !this.opts.deliveryStatePath
      if (!canStreamText) {
        // AgentExecutor.run resolve 即本轮完成标志:DSH executor 在内部等待 agent.whenIdle()。
        // 没有图片时保持两参调用:既有实现与测试都按这个形状断言。
        const result = await withTimeout(
          images.length === 0
            ? this.executor.run(sessionKey, payload)
            : this.executor.run(sessionKey, payload, undefined, images),
          timeoutMs,
        )
        active = false
        if (this.stopped || stored?.retired) return
        if (stored) {
          stored.state = 'output'
          const visible = parseQqSpells(result || '').visibleText
          stored.report = this.turnReport(ctx, sessionKey,
            this.opts.controlDispatcher ? parseQqControlBlocks(visible).visibleText : visible,
            [], { status: 'completed', generationStatus: 'completed' })
          await this.delivery.save()
        }
        const output = await this.respondAgentOutput(ctx, sessionKey, result || '(no output)')
        if (stored) await this.finishDelivery(stored)
        else this.observeTurn(ctx, sessionKey, payload, output.reply, output.parts, { status: output.status, generationStatus: 'completed' })
        return
      }

      const streamedText: string[] = []
      const parts: Array<{ index: number; chars: number; platformId?: string; ok: boolean; error?: string }> = []
      // 分段返回:agent 边产出边回发,用户不必等整轮结束。
      // 默认只回发「思考结果」(kind='text');思考过程(reasoning)默认忽略,
      // 避免逐 token 的思考增量在聊天框刷屏。可用 streamReasoning 开启。
      const onChunk = (chunk: string, kind: 'text' | 'reasoning') => {
        if (!active) return
        if (kind === 'reasoning' && !this.opts.streamReasoning) return
        if (kind === 'text') streamedText.push(chunk)
        void this.respondChunk(ctx, chunk).then(sent => {
          for (const part of sent) parts.push({ ...part, index: parts.length })
        })
      }
      const result = await withTimeout(
        images.length === 0
          ? this.executor.run(sessionKey, payload, onChunk)
          : this.executor.run(sessionKey, payload, onChunk, images),
        timeoutMs,
      )
      active = false
      const final = result || '(no output)'
      // 若流式 text 分段已经覆盖最终结果,不再重复发送最终完整版。
      if (streamedText.join('').trim() === final.trim()) {
        this.observeTurn(ctx, sessionKey, payload, final, parts, { status: 'completed' })
        return
      }
      // 最终结果(若与已分段内容不同,回发最终完整版作为收尾;超长自动拆分)。
      const tail = await this.respondAgentOutput(ctx, sessionKey, final, { report: ctx, remember: false, offset: parts.length })
      this.observeTurn(ctx, sessionKey, payload, tail.reply || final, [...parts, ...tail.parts], { status: tail.status })
    } catch (err) {
      active = false
      const stored = this.active.get(ctx)
      if (this.stopped || stored?.retired) return
      if (stored) {
        stored.state = String(err instanceof Error ? err.message : err).includes('MEMORY_REQUIRED') ? 'waiting' : 'failed'
        await this.delivery.save()
        if (stored.state === 'waiting' && stored.notified) return
        stored.notified = true
        await this.delivery.save()
      }
      const message = err instanceof AgentTimeoutError
        ? timeoutMessage
        : (stored?.state === 'waiting' ? '记忆服务暂时不可用，消息已保留，恢复后会继续处理。'
          : `agent error: ${err instanceof Error ? err.message : String(err)}`)
      await this.respondChunk(ctx, message)
      // A generation that failed is not a completed exchange: the report says
      // what happened so the caller neither saves it nor invents a reply.
      this.observeTurn(ctx, sessionKey, payload, message, [],
        { status: 'failed', reason: err instanceof Error ? err.message : String(err) })
    }
  }

  private observeTurn(
    ctx: HandlerContext,
    sessionKey: string,
    payload: string,
    reply: string,
    parts: Array<{ index: number; chars: number; platformId?: string; ok: boolean; error?: string }>,
    outcome: { status: 'completed' | 'failed' | 'interrupted'; generationStatus?: 'completed' | 'failed' | 'interrupted'; reason?: string },
  ): void {
    if (!this.opts.observeTurn) return
    try {
      this.opts.observeTurn(this.turnReport(ctx, sessionKey, reply, parts, outcome))
    } catch (err) {
      console.warn(`[dsh-qq-bridge] turn observer failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private turnReport(ctx: HandlerContext, sessionKey: string, reply: string, parts: QqTurnReport['parts'],
    outcome: Pick<QqTurnReport, 'status' | 'generationStatus' | 'reason'>): QqTurnReport {
      const sessionId = this.opts.sessionIdOf?.(sessionKey)
      const turnMessageId = this.executor.lastTurnIdentity?.(sessionKey)?.messageId
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
      }
  }


  /**
   * 解析控制块后回发,并报告真正对外可见的文字与每段平台回执。
   *
   * 控制块动作的回执、解析错误提示都是 bridge 自己的输出,不属于“助手回复”,
   * 因此只有 `parsed.visibleText` 计入 `reply`;但它们的发送结果仍逐段返回,
   * 便于调用方知道哪些平台消息已经产生。
   */
  private async respondAgentOutput(
    ctx: HandlerContext,
    sessionKey: string,
    result: string,
    options: { report?: HandlerContext; remember?: boolean; offset?: number } = {},
  ): Promise<{
    reply: string
    parts: Array<{ index: number; chars: number; platformId?: string; ok: boolean; error?: string }>
    status: 'completed' | 'failed'
  }> {
    const dispatcher = this.opts.controlDispatcher
    // 咒语先拆:标签属于「模型还没说完」的部分,不能出现在主人看到的正文里。
    // 拆完仍是纯文本,所以下面有没有控制块分发器都能走同一条路。
    const spelled = parseQqSpells(result)
    if (!dispatcher) {
      const parts = await this.respondChunk(ctx, spelled.visibleText, 'reply')
      const offset = options.offset ?? 0
      return {
        reply: spelled.visibleText,
        parts: parts.map(part => ({ ...part, index: part.index + offset })),
        status: parts.every(part => part.ok) ? 'completed' : 'failed',
      }
    }

    const parsed = parseQqControlBlocks(spelled.visibleText)
    const parts: Array<{ index: number; chars: number; platformId?: string; ok: boolean; error?: string }> = []
    let offset = options.offset ?? 0
    for (const error of parsed.errors) {
      const sent = await this.respondChunk(ctx, error)
      for (const part of sent) parts.push({ ...part, index: offset + parts.length })
      offset = 0
    }
    for (const action of parsed.actions) {
      if (!dispatcher) continue
      const message = await dispatcher.dispatch(action, { sessionKey, source: ctx })
      if (!message) continue
      const sent = await this.respondChunk(ctx, message)
      for (const part of sent) parts.push({ ...part, index: offset + parts.length })
      offset = 0
    }
    let reply = ''
    if (parsed.visibleText) {
      const sent = await this.respondChunk(ctx, parsed.visibleText, 'reply')
      for (const part of sent) parts.push({ ...part, index: offset + parts.length })
      reply = parsed.visibleText
    } else if (parts.length === 0) {
      const sent = await this.respondChunk(ctx, '(no output)')
      for (const part of sent) parts.push({ ...part, index: offset + parts.length })
    }
    return {
      reply,
      parts,
      status: parts.every(part => part.ok) ? 'completed' : 'failed',
    }
  }
}


export class AgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`agent timed out after ${timeoutMs}ms`)
    this.name = 'AgentTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentTimeoutError(timeoutMs)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
