import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { HandlerContext } from './router.js'
import type { QqTurnReport } from './handlers/agent.js'

export type SavedInput = Pick<HandlerContext, 'scope' | 'userId' | 'senderName' | 'groupId' | 'owner' | 'messageId' | 'payload' | 'replyTarget' | 'images'>
export interface DeliveryPart {
  outputIndex?: number
  text: string
  kind: 'reply' | 'control'
  state: 'pending' | 'sending' | 'sent' | 'unknown'
  platformId?: string
  error?: string
}
export interface DeliveryTurn {
  id: string
  input: SavedInput
  state: 'waiting' | 'running' | 'output' | 'complete' | 'failed' | 'unknown'
  parts: DeliveryPart[]
  report?: QqTurnReport
  notified?: boolean
  sessionId?: string
  retired?: boolean
  externallyManaged?: boolean
}

/**
 * 一条输出在本机的持久投递状态(RO04-B 通用投递的读侧)。
 *
 * 消费者按 outputId 取回"哪些索引已送达、哪些还要发",重启后据此续投;
 * 它不重新生成正文,也不决定该说什么——那属于消费方。
 */
export interface DeliveryOutputView {
  output_id: string
  state: DeliveryTurn['state']
  parts: Array<{ index: number; text: string; state: DeliveryPart['state']; platformId?: string; error?: string }>
  /** 仍未送达的分段索引(升序);用同一 outputId 再投这些索引即可。 */
  pending: number[]
  /** 是否还值得重试:sending/unknown 一律不自动重发。 */
  retryable: boolean
}

/** An unfinished generation is never replayed after a crash; only admitted
 * inputs and individually known-unsent text may be retried automatically. */
export class DeliveryStore {
  readonly turns: Record<string, DeliveryTurn> = {}
  private tail = Promise.resolve()
  constructor(private readonly path?: string) {}

  private inputKey(ctx: HandlerContext): string {
    return ctx.messageId === undefined ? randomUUID() : createHash('sha256')
      .update(JSON.stringify([ctx.scope, ctx.userId, ctx.groupId, ctx.messageId])).digest('hex')
  }

  async open(): Promise<void> {
    if (!this.path) return
    let saved: { schema: number; turns: Record<string, DeliveryTurn> }
    try { saved = JSON.parse(await readFile(this.path, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (saved.schema !== 1 || !saved.turns || typeof saved.turns !== 'object') throw new Error('Invalid QQ delivery state; original file preserved')
    Object.assign(this.turns, saved.turns)
    for (const turn of Object.values(this.turns)) {
      if (turn.state === 'running') turn.state = 'unknown'
      for (const part of turn.parts) if (part.state === 'sending') { part.state = 'unknown'; turn.state = 'unknown' }
    }
    await this.save()
  }

  save(): Promise<void> {
    const write = async () => {
      if (!this.path) return
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify({ schema: 1, turns: this.turns }), { mode: 0o600 })
      await rename(temporary, this.path)
    }
    const next = this.tail.then(write)
    this.tail = next.catch(() => {})
    return next
  }

  async accept(ctx: HandlerContext, output?: { sessionId: string; parts: DeliveryPart[]; externallyManaged?: boolean }): Promise<{ turn: DeliveryTurn; duplicate: boolean }> {
    const key = this.inputKey(ctx)
    if (this.turns[key]) return { turn: this.turns[key], duplicate: true }
    if (Object.values(this.turns).filter(turn => !['complete', 'failed'].includes(turn.state)).length >= 256) {
      throw new Error('QQ 待处理队列已满，请恢复连接后重试')
    }
    const input: SavedInput = {
      scope: ctx.scope, userId: ctx.userId, owner: ctx.owner, payload: ctx.payload,
      ...(ctx.senderName ? { senderName: ctx.senderName } : {}),
      ...(ctx.groupId === undefined ? {} : { groupId: ctx.groupId }),
      ...(ctx.messageId === undefined ? {} : { messageId: ctx.messageId }),
      ...(ctx.replyTarget === undefined ? {} : { replyTarget: ctx.replyTarget }),
      ...(ctx.images === undefined ? {} : { images: ctx.images }),
    }
    const turn: DeliveryTurn = { id: key, input,
      state: output ? 'output' : 'waiting', parts: output?.parts ?? [],
      ...(output ? { sessionId: output.sessionId } : {}),
      ...(output?.externallyManaged ? { externallyManaged: true } : {}),
    }
    this.turns[key] = turn
    const complete = Object.values(this.turns).filter(row => ['complete', 'failed'].includes(row.state))
    for (const row of complete.slice(0, Math.max(0, complete.length - 512))) delete this.turns[row.id]
    await this.save()
    return { turn, duplicate: false }
  }

  /** 找到某个稳定 outputId 对应的投递记录;没有时返回 undefined。 */
  outputTurn(outputId: string): DeliveryTurn | undefined {
    if (!outputId) return undefined
    for (const turn of Object.values(this.turns)) {
      if (turn.externallyManaged && turn.input.messageId === outputId) return turn
    }
    return undefined
  }

  /**
   * 读侧投影:哪个索引已送达、哪些还要续投。
   *
   * 状态是桥接自己的事实(sent/pending/unknown),不是平台的"已读";
   * unknown 不算可重试——没有确认的发出去可能已经到达,重复会变成两条消息。
   */
  outputView(outputId: string): DeliveryOutputView | undefined {
    const turn = this.outputTurn(outputId)
    if (!turn) return undefined
    const parts = turn.parts.map((part, index) => ({
      index: part.outputIndex ?? index, text: part.text, state: part.state,
      ...(part.platformId === undefined ? {} : { platformId: part.platformId }),
      ...(part.error === undefined ? {} : { error: part.error }),
    })).sort((left, right) => left.index - right.index)
    const pending = parts.filter(part => part.state !== 'sent' && part.state !== 'unknown')
      .map(part => part.index)
    return {
      output_id: outputId,
      state: turn.state,
      parts,
      pending,
      retryable: !turn.retired && pending.length > 0,
    }
  }

  /** 所有仍可续投的输出(重启后按 outputId 续投用)。 */
  pendingOutputs(): DeliveryOutputView[] {
    return Object.values(this.turns)
      .filter(turn => turn.externallyManaged && !turn.retired)
      .flatMap(turn => {
        const outputId = String(turn.input.messageId ?? '')
        const view = this.outputView(outputId)
        return view && view.pending.length > 0 ? [view] : []
      })
  }
}
