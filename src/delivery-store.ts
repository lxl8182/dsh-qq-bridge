import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { HandlerContext } from './router.js'
import type { QqTurnReport } from './handlers/agent.js'

export type SavedInput = Pick<HandlerContext, 'scope' | 'userId' | 'groupId' | 'owner' | 'messageId' | 'payload' | 'replyTarget'>
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

/** An unfinished generation is never replayed after a crash; only admitted
 * inputs and individually known-unsent text may be retried automatically. */
export class DeliveryStore {
  readonly turns: Record<string, DeliveryTurn> = {}
  private tail = Promise.resolve()
  constructor(private readonly path?: string) {}

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
    const key = ctx.messageId === undefined ? randomUUID() : createHash('sha256')
      .update(JSON.stringify([ctx.scope, ctx.userId, ctx.groupId, ctx.messageId])).digest('hex')
    if (this.turns[key]) return { turn: this.turns[key], duplicate: true }
    if (Object.values(this.turns).filter(turn => turn.state !== 'complete' && turn.state !== 'failed').length >= 256) {
      throw new Error('QQ 待处理队列已满，请恢复连接后重试')
    }
    const input: SavedInput = {
      scope: ctx.scope, userId: ctx.userId, owner: ctx.owner, payload: ctx.payload,
      ...(ctx.groupId === undefined ? {} : { groupId: ctx.groupId }),
      ...(ctx.messageId === undefined ? {} : { messageId: ctx.messageId }),
      ...(ctx.replyTarget === undefined ? {} : { replyTarget: ctx.replyTarget }),
    }
    const turn: DeliveryTurn = { id: key, input,
      state: output ? 'output' : 'waiting', parts: output?.parts ?? [],
      ...(output ? { sessionId: output.sessionId } : {}),
      ...(output?.externallyManaged ? { externallyManaged: true } : {}),
    }
    this.turns[key] = turn
    const complete = Object.values(this.turns).filter(row => row.state === 'complete' || row.state === 'failed')
    for (const row of complete.slice(0, Math.max(0, complete.length - 512))) delete this.turns[row.id]
    await this.save()
    return { turn, duplicate: false }
  }
}
