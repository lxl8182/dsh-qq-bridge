import { describe, it, expect, vi } from 'vitest'
import { DshAgentExecutor, DshRenderedAgent, DshSegmentPolicy } from '../src/handlers/dsh-executor.js'
import type { BridgeModelSelectionRef } from '../src/handlers/model-control.js'

const KEY = 'private:10001'

/**
 * 内存 mock。
 *
 * 每个 DSH 会话有自己的事件日志,消息 id 全局递增 —— 只有这样才能证明「换段之后
 * 这一轮真的挂在另一个会话上」,并且这一轮的提交身份是新生成的,不是复用旧值。
 */
function makeMock() {
  const sessionIds: string[] = []
  const dropped: string[] = []
  const logs = new Map<string, unknown[]>()
  const agentSession = new WeakMap<DshRenderedAgent, string>()
  let messageSeq = 0

  const dsh = {
    async getOrCreate({ sessionId }: {
      sessionKey: string
      sessionId: string
      cwd?: string
      modelSelection: BridgeModelSelectionRef
    }): Promise<DshRenderedAgent> {
      sessionIds.push(sessionId)
      const events: unknown[] = []
      logs.set(sessionId, events)
      const agent: DshRenderedAgent = {
        followup: vi.fn(),
        async whenIdle() {},
        async dispose() { dropped.push(sessionId) },
        async readSurface() { return events },
      }
      agentSession.set(agent, sessionId)
      return agent
    },
    async deliver(agent: DshRenderedAgent, prompt: string) {
      const sessionId = agentSession.get(agent)!
      const events = logs.get(sessionId)!
      const id = `msg-${++messageSeq}`
      events.push(
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } },
        { type: 'assistant/message', data: { message: { id: `a-${messageSeq}`, content: [{ type: 'text', text: '好。' }] } } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      )
      return { messageId: id }
    },
    async readSurface(sessionId: string) { return logs.get(sessionId) ?? [] },
  }
  return { dsh, sessionIds, dropped, logs }
}

/** 只在开关打开后要求换段,并在换过之后自动关掉 (表达式策略,便于精确断言)。 */
function once(reason = 'budget'): DshSegmentPolicy & { enable(): void; calls: number } {
  const policy: DshSegmentPolicy & { enable(): void; calls: number } = {
    calls: 0,
    enable() { policy.calls = 0; armed = true },
    shouldStartNewSegment() {
      policy.calls += 1
      if (!armed) return undefined
      armed = false
      return reason
    },
  }
  let armed = false
  return policy
}

describe('dsh-qq-bridge — 上下文分段原语', () => {
  it('没有注入策略时行为与接线前完全一致:一个来源只建一个会话', async () => {
    const { dsh, sessionIds, dropped } = makeMock()
    const executor = new DshAgentExecutor(dsh as never)
    const first = await executor.prepareSession(KEY)
    expect(await executor.prepareSession(KEY)).toBe(first)
    expect(await executor.prepareSession(KEY)).toBe(first)
    expect(sessionIds).toEqual([first])
    expect(dropped).toEqual([])
    expect(executor.getSessionVersion(KEY)).toBe(0)
    expect(executor.lastSegmentSwitch(KEY)).toBeUndefined()
    await executor.disposeAll()
  })

  it('策略说不用换时也不建第二个会话', async () => {
    const { dsh, sessionIds, dropped } = makeMock()
    const shouldStartNewSegment = vi.fn(() => undefined)
    const executor = new DshAgentExecutor(dsh as never, { segmentPolicy: { shouldStartNewSegment } })
    await executor.prepareSession(KEY)
    await executor.prepareSession(KEY)
    expect(shouldStartNewSegment).toHaveBeenCalledTimes(2)
    // 判定拿到的 sessionId 是「换段前这一轮本来要用的那个」,不是空串。
    expect(shouldStartNewSegment).toHaveBeenLastCalledWith(KEY, sessionIds[0])
    expect(sessionIds).toHaveLength(1)
    expect(dropped).toEqual([])
    await executor.disposeAll()
  })

  it('策略要求换段时本次 prepareSession 就返回新的 sessionId,旧会话被释放', async () => {
    const { dsh, sessionIds, dropped } = makeMock()
    const policy = once()
    const executor = new DshAgentExecutor(dsh as never, { segmentPolicy: policy })
    const before = await executor.prepareSession(KEY)
    policy.enable()
    const after = await executor.prepareSession(KEY)
    // 关键不变量:换段那一轮必须已经挂在新会话上,否则这一轮还会读旧上下文。
    expect(after).not.toBe(before)
    expect(sessionIds).toEqual([before, after])
    expect(dropped).toEqual([before])
    expect(executor.getSessionVersion(KEY)).toBe(1)
    expect(executor.lastSegmentSwitch(KEY)).toMatchObject({ reason: 'budget', previousSessionId: before, sessionId: after })
    await executor.disposeAll()
  })

  it('换段完成后通知一次,并交出旧会话 id,让策略自己准备带入的旧话', async () => {
    const { dsh } = makeMock()
    const policy = once()
    const carryOverText = vi.fn(async () => {})
    const executor = new DshAgentExecutor(dsh as never, { segmentPolicy: { ...policy, carryOverText } })
    const first = await executor.prepareSession(KEY)
    // 不换段时绝不通知:不换段就没有「该带什么旧话」这回事。
    expect(carryOverText).not.toHaveBeenCalled()
    policy.enable()
    const second = await executor.prepareSession(KEY)
    expect(carryOverText).toHaveBeenCalledTimes(1)
    expect(carryOverText).toHaveBeenCalledWith(KEY, first, second)
    // 只在换段那一次通知,后续普通轮次不再通知。
    await executor.prepareSession(KEY)
    expect(carryOverText).toHaveBeenCalledTimes(1)
    await executor.disposeAll()
  })

  it('并发进入时只换一次段,不会几条消息各换一次丢掉一段上下文', async () => {
    const { dsh, dropped } = makeMock()
    const policy = once()
    const executor = new DshAgentExecutor(dsh as never, { segmentPolicy: policy })
    await executor.prepareSession(KEY)
    expect(executor.getSessionVersion(KEY)).toBe(0)
    policy.enable()
    const settled = await Promise.all([
      executor.prepareSession(KEY),
      executor.prepareSession(KEY),
      executor.prepareSession(KEY),
    ])
    // 三条并发只有第一次真正换了段,其余复用同一个新会话。
    expect(executor.getSessionVersion(KEY)).toBe(1)
    expect(new Set(settled).size).toBe(1)
    expect(dropped).toHaveLength(1)
    await executor.disposeAll()
  })

  it('判定本身抛错时保持原会话继续聊天,而不是每轮都换', async () => {
    const { dsh, sessionIds } = makeMock()
    const executor = new DshAgentExecutor(dsh as never, {
      segmentPolicy: { shouldStartNewSegment: () => { throw new Error('policy exploded') } },
    })
    const first = await executor.prepareSession(KEY)
    expect(await executor.prepareSession(KEY)).toBe(first)
    expect(sessionIds).toHaveLength(1)
    expect(executor.getSessionVersion(KEY)).toBe(0)
    await executor.disposeAll()
  })

  it('带旧话时抛错只丢那几句旧话,这一轮照样能进行', async () => {
    const { dsh } = makeMock()
    const policy = once()
    const executor = new DshAgentExecutor(dsh as never, {
      segmentPolicy: {
        ...policy,
        carryOverText: () => { throw new Error('carry exploded') },
      },
    })
    const before = await executor.prepareSession(KEY)
    policy.enable()
    // 通知失败不能让换段本身回滚,更不能让这一轮失败。
    const after = await executor.prepareSession(KEY)
    expect(after).not.toBe(before)
    expect(executor.getSessionVersion(KEY)).toBe(1)
    await executor.disposeAll()
  })

  it('换段清了 turnIdentity,但这一轮的提交身份仍会重建并挂在新区段上', async () => {
    const { dsh } = makeMock()
    const policy = once()
    const executor = new DshAgentExecutor(dsh as never, { segmentPolicy: policy })

    // 与生产调用顺序一致:agent.ts 每轮先 prepareSession(换段就在这里发生),
    // 再 executor.run。中间的 prepareTurn(记忆提交前置)也就发生在这两步之间。
    await executor.prepareSession(KEY)
    await executor.run(KEY, '第一句')
    const before = executor.lastTurnIdentity(KEY)
    expect(before?.messageId).toBeTruthy()

    policy.enable()
    const sessionIdThisTurn = await executor.prepareSession(KEY)
    expect(sessionIdThisTurn).not.toBe(before?.sessionId)
    // 换段后这一轮还要正常跑完并提交。
    expect(await executor.run(KEY, '第二句')).toBe('好。')

    const after = executor.lastTurnIdentity(KEY)
    // 记忆插件用这对 id 提交本轮:缺任一都会让「换段那一轮」记不上账。
    expect(after?.messageId).toBeTruthy()
    expect(after?.messageId).not.toBe(before?.messageId)
    expect(after?.sessionId).toBe(sessionIdThisTurn)
    expect(after?.sessionId).toBe(executor.currentSessionId(KEY))
    expect(executor.getSessionVersion(KEY)).toBe(1)
    await executor.disposeAll()
  })

  it('可以在 executor 建好之后再装上或卸下策略,卸下即回到原行为', async () => {
    const { dsh, sessionIds } = makeMock()
    const executor = new DshAgentExecutor(dsh as never)
    const first = await executor.prepareSession(KEY)
    // 宿主插件启用顺序不确定,所以必须支持后装。
    executor.setSegmentPolicy({ shouldStartNewSegment: () => 'budget' })
    const second = await executor.prepareSession(KEY)
    expect(second).not.toBe(first)
    // 卸下之后不再换段。
    executor.setSegmentPolicy(undefined)
    expect(await executor.prepareSession(KEY)).toBe(second)
    expect(executor.lastSegmentSwitch(KEY)).toBeUndefined()
    expect(sessionIds).toHaveLength(2)
    await executor.disposeAll()
  })
})
