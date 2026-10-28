/**
 * 桥接层对其他 Host 插件暴露的最小事实出口。
 *
 * 记忆插件需要知道「这一轮是不是主人说的、真实输入是什么、最终发出去的文字
 * 是什么、QQ 平台接受到哪几段、对应哪个 DSH 会话」。这些事实只有桥接层知道,
 * 所以由一个只读服务发布,而不是让别的插件去解析 QQ 协议或猜 DSH 事件。
 *
 * 边界:
 * - 只暴露事实,不暴露桥接内部状态、凭据、原始出站文本队列或修改入口;
 * - 服务名固定,结构变化必须留旧字段(新增是可加,删除是破坏);
 * - 桥接未加载时这个服务不存在,订阅方必须自己处理缺失。
 */
import type { QqTurnReport } from './handlers/agent.js'
import { parseQqControlBlocks, parseQqSpells } from './handlers/control.js'
import { extractAssistantText } from './handlers/dsh-executor.js'
import { replyParts } from './message-format.js'

export interface QqTurnInput {
  sessionKey: string
  sessionId?: string
  scope: 'private' | 'group'
  owner: boolean
  userId: string | number
  groupId?: string | number
  messageId?: string | number
  input: string
}

/** 服务在 Cordis 中的名字;订阅方按这个名字注入。 */
export const QQ_BRIDGE_EVENTS_SERVICE = 'qqBridgeEvents'

export type QqTurnListener = (report: QqTurnReport) => void
export interface QqOutputDelivery {
  parts: Array<{ index: number; ok: boolean; platformId?: string; error?: string }>
  status: 'completed' | 'failed' | 'cancelled'
}
type OutputSender = (sessionId: string, outputId: string, parts: Array<{ index: number; text: string }>, canSend: () => Promise<boolean>) => Promise<QqOutputDelivery>

/**
 * 一次订阅的句柄。`dispose` 幂等:重复调用、或在服务已卸载后调用都安全。
 */
export interface QqTurnSubscription {
  dispose(): void
}

/**
 * 只读事件出口。
 *
 * `subscribe` 同步注册:注册完成后再发生的一轮一定会通知到;注册之前已经结束
 * 的轮次不会补发(补交由订阅方自己的持久队列负责,不靠桥接重放)。
 */
export class QqBridgeEvents {
  private readonly listeners = new Set<QqTurnListener>()
  private readonly admissions = new Set<(input: QqTurnInput) => Promise<void>>()
  private readonly bindings = new Map<string, QqTurnInput>()
  private retirer?: (sessionId: string) => Promise<void>
  private pusher?: (text: string) => Promise<void>
  platform: 'official' | 'napcat' = 'official'
  private replay?: () => QqTurnReport[]
  private outputSender?: OutputSender
  private maxMessageLength = 4500
  private activeOutputs = new Map<string, { promise: Promise<void>; finish: () => void }>()

  beginOutput(sessionId: string): () => void {
    if (this.activeOutputs.has(sessionId)) throw new Error('QQ session already has an active output')
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    const output = { promise, finish }
    this.activeOutputs.set(sessionId, output)
    return () => {
      if (this.activeOutputs.get(sessionId) === output) this.activeOutputs.delete(sessionId)
      finish()
    }
  }

  async waitForOutput(sessionId: string): Promise<void> {
    await this.activeOutputs.get(sessionId)?.promise
  }

  setOutputLimit(maximum: number): void { this.maxMessageLength = maximum }

  setOutputSender(sender: OutputSender): () => void {
    this.outputSender = sender
    return () => { if (this.outputSender === sender) this.outputSender = undefined }
  }

  normalizeOutput(text: string): string {
    return replyParts(parseQqControlBlocks(parseQqSpells(text).visibleText).visibleText).text
  }

  planOutput(text: string): { text: string; part_sizes: number[] } {
    const plan = replyParts(this.normalizeOutput(text), this.maxMessageLength)
    return { text: plan.text, part_sizes: plan.part_sizes }
  }

  assistantText(events: readonly unknown[]): string {
    return extractAssistantText(events) ?? ''
  }

  deliverOutput(sessionId: string, outputId: string, parts: Array<{ index: number; text: string }>, canSend: () => Promise<boolean>): Promise<QqOutputDelivery> | undefined {
    return this.outputSender?.(sessionId, outputId, parts, canSend)
  }

  setReplay(replay: () => QqTurnReport[]): () => void {
    this.replay = replay
    return () => { if (this.replay === replay) this.replay = undefined }
  }

  binding(sessionId: string): QqTurnInput | undefined {
    const binding = this.bindings.get(sessionId)
    return binding ? { ...binding } : undefined
  }

  subscribeAdmission(listener: (input: QqTurnInput) => Promise<void>): QqTurnSubscription {
    this.admissions.add(listener)
    return { dispose: () => { this.admissions.delete(listener) } }
  }

  async prepare(input: QqTurnInput): Promise<void> {
    if (input.sessionId) this.bindings.set(input.sessionId, { ...input })
    for (const listener of this.admissions) await listener({ ...input })
  }

  /**
   * 由宿主插件注册"主动给管理员发一条文字"的能力。
   *
   * 桥接自己知道该发给谁(管理员 QQ / OpenID)和怎么发,别的插件不该复制
   * 这份配置。注册者不出现时 pushPrivate 返回 undefined,调用方据此降级,
   * 而不是假装送达。
   */
  setPusher(pusher: (text: string) => Promise<void>): () => void {
    this.pusher = pusher
    return () => { if (this.pusher === pusher) this.pusher = undefined }
  }

  /** 向管理员推送一条文字。没注册推送者时返回 undefined。 */
  pushPrivate(text: string): Promise<void> | undefined {
    const body = String(text ?? '').trim()
    if (!body || !this.pusher) return undefined
    return this.pusher(body)
  }

  setRetirer(retirer: (sessionId: string) => Promise<void>): () => void {
    this.retirer = retirer
    return () => { if (this.retirer === retirer) this.retirer = undefined }
  }

  async retireSession(sessionId: string): Promise<void> {
    if (!this.retirer) throw new Error('QQ session controller is unavailable')
    await this.retirer(sessionId)
    this.bindings.delete(sessionId)
  }

  subscribe(listener: QqTurnListener): QqTurnSubscription {
    this.listeners.add(listener)
    for (const report of this.replay?.() ?? []) listener(report)
    let active = true
    return {
      dispose: () => {
        if (!active) return
        active = false
        this.listeners.delete(listener)
      },
    }
  }

  /**
   * 发布一轮的结果。监听器抛错只影响它自己:桥接的收发不能因为某个订阅方
   * 出错而失败。
   */
  publish(report: QqTurnReport): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(report)
      } catch (err) {
        console.warn(`[dsh-qq-bridge] qqBridgeEvents listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** 卸载时清空订阅,避免已销毁的服务继续持有回调。 */
  dispose(): void {
    for (const output of this.activeOutputs.values()) output.finish()
    this.activeOutputs.clear()
    this.listeners.clear()
    this.admissions.clear()
    this.bindings.clear()
    this.retirer = undefined
    this.pusher = undefined
    this.replay = undefined
    this.outputSender = undefined
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}
