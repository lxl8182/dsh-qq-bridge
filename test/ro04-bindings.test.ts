import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QqBridgeEvents, type QqBindingRecord } from '../src/bridge-events.js'
import { AccessGate } from '../src/security.js'
import { AgentRpcHandler } from '../src/handlers/agent.js'
import { DeliveryStore } from '../src/delivery-store.js'
import type { SavedInput } from '../src/delivery-store.js'
import type { HandlerContext } from '../src/router.js'

/**
 * RO04-B 接口准备:绑定恢复与通用投递。
 *
 * 全部使用假执行器 / 假平台发送,不做真实 QQ 发送。被验证的是桥接自己的事实
 * (身份是否仍然合法、哪一段已经被平台接受、重启后能否只补未送达段),不是模型
 * 行为。本文件同时锚定"未接线时行为与合入前一致"。
 */

const OWNER = 10001
const STRANGER = 10002
const SESSION_KEY = `private:${OWNER}`

function ownerGate(): AccessGate {
  return new AccessGate({ adminQq: OWNER, allowlist: [STRANGER], commandPrefix: '', mode: 'whitelist' })
}

/** 与 plugin.ts 相同的接线形状:身份复核 + 会话建立 + 复用同一投递队列。 */
function wire(events: QqBridgeEvents, handler: AgentRpcHandler, sessionId: string) {
  const offs = [
    events.setIdentityVerifier(record => ownerGate().isOwner({ user_id: record.userId })),
    events.setSessionBinder(async () => sessionId),
    events.setOutputSender(async (session, outputId, parts, canSend) => {
      const input = events.binding(session)
      if (!input) throw new Error('QQ owner session is not bound')
      return handler.deliverOutput(input, outputId, parts, canSend)
    }),
  ]
  return () => { for (const off of offs) off() }
}

function deliveryHandler(options: {
  path: string
  send: (text: string) => Promise<{ platformId?: string }>
  sessionId: string
}): AgentRpcHandler {
  const restored: HandlerContext = {
    scope: 'private', userId: OWNER, owner: true, messageId: 'ignored', payload: '',
    respond: async () => {}, send: options.send,
  }
  return new AgentRpcHandler({ run: vi.fn(async () => 'unexpected') }, {
    ackMessage: '',
    deliveryStatePath: options.path,
    sessionIdOf: () => options.sessionId,
    restoreContext: (input: SavedInput) => ({ ...restored, ...input }),
    // 气泡间隔是真实节奏,不是本卡要验证的行为。
    waitForBubble: async () => {},
  })
}

describe('RO04-B 绑定恢复:重启后不需要新发言', () => {
  it('restores a legal binding and delivers with no new inbound message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qq-ro04-restore-'))
    try {
      // boot 1: a real inbound message confirms the owner binding.
      const first = new QqBridgeEvents()
      await first.prepare({
        sessionKey: SESSION_KEY, sessionId: 'qq-boot1', scope: 'private', owner: true,
        userId: OWNER, messageId: 501, input: '这是我私人的话,不要进身份记录',
      })
      const records = first.bindingRecords()
      expect(JSON.stringify(records)).not.toContain('不要进身份记录')
      expect(records).toEqual([{ sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER, messageId: 501 }])
      first.dispose()

      // boot 2: nothing new arrives.
      const sent: string[] = []
      const second = new QqBridgeEvents()
      const handler = deliveryHandler({
        path: join(root, 'delivery.json'), sessionId: 'qq-boot2',
        send: async (text: string) => { sent.push(text); return { platformId: `p${sent.length}` } },
      })
      await handler.open()
      const off = wire(second, handler, 'qq-boot2')
      try {
        expect(second.restoreBindings(records)).toMatchObject({ restored: 1, kept: 0, rejected: [] })
        // Restored identity has no DSH session yet: not deliverable, and it says why.
        expect(second.restoredBindings()).toEqual([expect.objectContaining({ sessionKey: SESSION_KEY })])
        expect(await second.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-1',
          parts: [{ index: 0, text: '第一句' }] })).toMatchObject({ status: 'unavailable', error: 'no_session' })

        expect(await second.ensureSessions()).toEqual({ bound: 1, failed: [] })
        expect(second.restoredBindings()).toEqual([])
        const outcome = await second.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-1',
          parts: [{ index: 0, text: '第一句\n' }, { index: 1, text: '第二句' }] })
        expect(outcome).toMatchObject({ status: 'completed', pending: [] })
        expect(outcome.parts.map(part => [part.index, part.ok])).toEqual([[0, true], [1, true]])
        // 分段正文保留边界换行供回执还原，QQ 发送边界会剥掉尾部空行。
        expect(sent).toEqual(['第一句', '第二句'])
      } finally { off() }
      await handler.dispose()
      second.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('is lazy: restoring a binding never creates a session until the caller asks', async () => {
    const events = new QqBridgeEvents()
    const binder = vi.fn(async () => 'qq-lazy')
    const offs = [events.setIdentityVerifier(() => true), events.setSessionBinder(binder)]
    try {
      events.restoreBindings([{ sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER }])
      // Restoring is a fact about identity, not a warm-up: no agent session yet.
      expect(binder).not.toHaveBeenCalled()
      expect(events.restoredBindings()).toHaveLength(1)
      expect(events.binding('qq-lazy')).toBeUndefined()
      await events.ensureSessions()
      expect(binder).toHaveBeenCalledOnce()
      // Idempotent: a second ask does not create another session for the same key.
      expect(await events.ensureSessions()).toEqual({ bound: 0, failed: [] })
      expect(binder).toHaveBeenCalledOnce()
    } finally { for (const off of offs) off(); events.dispose() }
  })

  it('refuses to invent an identity: whitelisted members, forged keys and non-owner claims', async () => {
    const events = new QqBridgeEvents()
    const off = events.setIdentityVerifier(record => ownerGate().isOwner({ user_id: record.userId }))
    try {
      const legal: QqBindingRecord = { sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER }
      const member: QqBindingRecord = { sessionKey: `private:${STRANGER}`, scope: 'private', owner: true, userId: STRANGER }
      const forged: QqBindingRecord = { sessionKey: 'nickname:小铃', scope: 'private', owner: true, userId: OWNER }
      const notOwner = { ...legal, owner: false as unknown as true }
      const report = events.restoreBindings([legal, member, forged, notOwner])
      expect(report.restored).toBe(1)
      expect(report.rejected).toEqual([
        { sessionKey: `private:${STRANGER}`, reason: 'identity_not_owner' },
        { sessionKey: 'nickname:小铃', reason: 'session_key_mismatch' },
        { sessionKey: SESSION_KEY, reason: 'not_owner' },
      ])
      expect(await events.deliverByIndex({ sessionKey: `private:${STRANGER}`, outputId: 'out-x',
        parts: [{ index: 0, text: '不该发送' }] }))
        .toMatchObject({ status: 'unavailable', error: 'not_bound', parts: [] })
    } finally { off(); events.dispose() }
  })

  it('rejects a group record whose platform id disagrees with its session key', async () => {
    const events = new QqBridgeEvents()
    const off = events.setIdentityVerifier(() => true)
    try {
      expect(events.restoreBindings([
        { sessionKey: 'group:7001', scope: 'group', owner: true, userId: OWNER, groupId: 7002 },
        { sessionKey: 'group:7001', scope: 'group', owner: true, userId: OWNER },
        { sessionKey: 'private:', scope: 'private', owner: true, userId: '' },
      ]).rejected).toEqual([
        { sessionKey: 'group:7001', reason: 'session_key_mismatch' },
        { sessionKey: 'group:7001', reason: 'missing_group' },
        { sessionKey: 'private:', reason: 'missing_user' },
      ])
    } finally { off(); events.dispose() }
  })

  // 行为无变化(约束 4):未接线时走原来的拒绝路径,不会因为新接口而放宽。
  it('without wiring, restore still refuses and the old binding path is unchanged', async () => {
    const events = new QqBridgeEvents()
    try {
      expect(events.restoreBindings([{ sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER }]))
        .toEqual({ restored: 0, kept: 0, rejected: [{ sessionKey: SESSION_KEY, reason: 'identity_unverified' }] })
      expect(await events.ensureSessions()).toEqual({ bound: 0, failed: [] })
      expect(await events.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-y',
        parts: [{ index: 0, text: 'a' }] })).toMatchObject({ status: 'unavailable', error: 'not_bound' })
      // The pre-existing inbound path still binds and reports exactly as before.
      await events.prepare({ sessionKey: SESSION_KEY, sessionId: 'qq-old', scope: 'private',
        owner: true, userId: OWNER, messageId: 7, input: '旧的入站' })
      expect(events.binding('qq-old')).toMatchObject({ sessionKey: SESSION_KEY, owner: true, input: '旧的入站' })
    } finally { events.dispose() }
  })

  it('a binding confirmed by a real inbound message this boot wins over the file', async () => {
    const events = new QqBridgeEvents()
    const off = events.setIdentityVerifier(() => true)
    try {
      await events.prepare({ sessionKey: SESSION_KEY, sessionId: 'qq-live', scope: 'private',
        owner: true, userId: OWNER, messageId: 900, input: '现在说的' })
      expect(events.restoreBindings([{ sessionKey: SESSION_KEY, scope: 'private',
        owner: true, userId: OWNER, messageId: 501 }])).toMatchObject({ restored: 0, kept: 1 })
      expect(events.binding('qq-live')?.messageId).toBe(900)
    } finally { off(); events.dispose() }
  })

  it('a group binding restores but is not a private delivery target', async () => {
    const events = new QqBridgeEvents()
    const offs = [events.setIdentityVerifier(() => true), events.setSessionBinder(async () => 'qq-group')]
    try {
      expect(events.restoreBindings([{ sessionKey: 'group:7001', scope: 'group', owner: true,
        userId: OWNER, groupId: 7001 }]).restored).toBe(1)
      await events.ensureSessions()
      expect(await events.deliverByIndex({ sessionKey: 'group:7001', outputId: 'out-g',
        parts: [{ index: 0, text: '群里不发' }] })).toMatchObject({ status: 'unavailable', error: 'not_private' })
    } finally { for (const off of offs) off(); events.dispose() }
  })

  it('a restore that cannot create a session reports the failure instead of pretending', async () => {
    const events = new QqBridgeEvents()
    const offs = [
      events.setIdentityVerifier(() => true),
      events.setSessionBinder(async () => { throw new Error('host refused') }),
    ]
    try {
      events.restoreBindings([{ sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER }])
      expect(await events.ensureSessions()).toEqual({ bound: 0,
        failed: [{ sessionKey: SESSION_KEY, reason: 'host refused' }] })
      expect(await events.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-z',
        parts: [{ index: 0, text: 'a' }] })).toMatchObject({ status: 'unavailable', error: 'no_session' })
    } finally { for (const off of offs) off(); events.dispose() }
  })
})

describe('RO04-B 接线:只注册钩子,不在启动时碰恢复', () => {
  it('plugin.ts only registers the two hooks and never runs a restore or warm-up', async () => {
    const plugin = await readFile(join(process.cwd(), 'src', 'plugin.ts'), 'utf8')
    // Exactly two call sites, both inside the wiring slot.
    expect(plugin.match(/setIdentityVerifier\(/g)).toHaveLength(1)
    expect(plugin.match(/setSessionBinder\(/g)).toHaveLength(1)
    // Lazy by construction: the plugin must never restore or create sessions on boot.
    expect(plugin).not.toContain('restoreBindings(')
    expect(plugin).not.toContain('ensureSessions(')
    // The pre-existing session-output forwarder is untouched.
    expect(plugin).toContain('registerQqSessionOutput(ctx, executor, events, agentHandler)')
  })
})

describe('RO04-B 通用投递:按 output/part 索引分段、部分失败可续', () => {
  it('sends fixed indices, reports the failed one, and resumes only that one after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qq-ro04-deliver-'))
    const statePath = join(root, 'delivery.json')
    try {
      const attempts: string[] = []
      const send = async (text: string) => {
        attempts.push(text)
        if (attempts.length === 2) throw new Error('offline')
        return { platformId: `p${attempts.length}` }
      }
      const events = new QqBridgeEvents()
      const handler = deliveryHandler({ path: statePath, sessionId: 'qq-out', send })
      await handler.open()
      const off = wire(events, handler, 'qq-out')
      try {
        expect(events.restoreBindings([{ sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER }]).restored).toBe(1)
        await events.ensureSessions()
        const first = await events.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-42',
          source: 'task_result',
          parts: [{ index: 0, text: '第一段\n' }, { index: 1, text: '第二段' }, { index: 2, text: '第三段' }] })
        // Every part of the turn is reported: what arrived, and what still owes a send
        // (index 2 was never attempted because the transport stopped after the failure).
        expect(first.parts.map(part => [part.index, part.ok])).toEqual([[0, true], [1, false], [2, false]])
        expect(first.pending).toEqual([1, 2])
        expect(first.status).toBe('failed')
        // Read back by output id, without re-generating anything.
        const store = new DeliveryStore(statePath)
        await store.open()
        expect(store.outputView('out-42')).toMatchObject({ output_id: 'out-42', pending: [1, 2], retryable: true })
        expect(store.pendingOutputs().map(view => view.output_id)).toEqual(['out-42'])
      } finally { off() }
      await handler.dispose()
      events.dispose()

      // restart: same output id, only the missing indices are asked for.
      const resumed: string[] = []
      const second = new QqBridgeEvents()
      const restarted = deliveryHandler({ path: statePath, sessionId: 'qq-out-2',
        send: async (text: string) => { resumed.push(text); return { platformId: `r${resumed.length}` } } })
      await restarted.open()
      const off2 = wire(second, restarted, 'qq-out-2')
      try {
        second.restoreBindings([{ sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER }])
        await second.ensureSessions()
        const outcome = await second.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-42',
          parts: [{ index: 1, text: '第二段' }, { index: 2, text: '第三段' }] })
        expect(outcome).toMatchObject({ status: 'completed', pending: [] })
        expect(resumed).toEqual(['第二段', '第三段'])
        // 同一规则：attempts 记录的是实际发到平台的文本。
        expect(attempts).toEqual(['第一段', '第二段'])
      } finally { off2() }
      await restarted.dispose()
      second.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps the original part indices even when handed out of order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qq-ro04-order-'))
    try {
      const sent: string[] = []
      const events = new QqBridgeEvents()
      const handler = deliveryHandler({ path: join(root, 'delivery.json'), sessionId: 'qq-order',
        send: async (text: string) => { sent.push(text); return { platformId: `p${sent.length}` } } })
      await handler.open()
      const off = wire(events, handler, 'qq-order')
      try {
        events.restoreBindings([{ sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER }])
        await events.ensureSessions()
        const outcome = await events.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-order',
          parts: [{ index: 2, text: 'C' }, { index: 0, text: 'A' }, { index: 1, text: 'B' }] })
        // Bubbles leave in index order; the caller's array order is not the contract.
        expect(sent).toEqual(['A', 'B', 'C'])
        expect(outcome.parts.map(part => part.index)).toEqual([0, 1, 2])
      } finally { off() }
      await handler.dispose()
      events.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('a delivery refused by the caller check is cancelled and the body is kept for a later attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qq-ro04-cancel-'))
    try {
      const sent: string[] = []
      const events = new QqBridgeEvents()
      const handler = deliveryHandler({ path: join(root, 'delivery.json'), sessionId: 'qq-cancel',
        send: async (text: string) => { sent.push(text); return {} } })
      await handler.open()
      const off = wire(events, handler, 'qq-cancel')
      try {
        events.restoreBindings([{ sessionKey: SESSION_KEY, scope: 'private', owner: true, userId: OWNER }])
        await events.ensureSessions()
        const cancelled = await events.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-c',
          parts: [{ index: 0, text: '过期正文' }] }, async () => false)
        expect(cancelled.status).toBe('cancelled')
        expect(sent).toEqual([])
        const later = await events.deliverByIndex({ sessionKey: SESSION_KEY, outputId: 'out-c',
          parts: [{ index: 0, text: '过期正文' }] })
        expect(later.status).toBe('completed')
        expect(sent).toEqual(['过期正文'])
      } finally { off() }
      await handler.dispose()
      events.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects malformed requests before touching the transport', async () => {
    const events = new QqBridgeEvents()
    const sender = vi.fn()
    const offs = [events.setIdentityVerifier(() => true), events.setSessionBinder(async () => 'qq-m'),
      events.setOutputSender(sender)]
    try {
      await events.prepare({ sessionKey: SESSION_KEY, sessionId: 'qq-m', scope: 'private',
        owner: true, userId: OWNER, input: '' })
      const cases: Array<[unknown, string]> = [
        [{ sessionKey: SESSION_KEY }, 'missing_output_id'],
        [{ sessionKey: SESSION_KEY, outputId: 'x', parts: [] }, 'missing_parts'],
        [{ sessionKey: SESSION_KEY, outputId: 'x', parts: [{ index: 0, text: '  ' }] }, 'invalid_part_text'],
        [{ sessionKey: SESSION_KEY, outputId: 'x', parts: [{ index: -1, text: 'a' }] }, 'invalid_part_index'],
        [{ sessionKey: SESSION_KEY, outputId: 'x', parts: [{ index: 0, text: 'a' }, { index: 0, text: 'b' }] }, 'duplicate_part_index'],
      ]
      for (const [request, error] of cases) {
        expect(await events.deliverByIndex(request as never)).toMatchObject({ status: 'unavailable', error })
      }
      expect(await events.deliverByIndex({ sessionKey: 'private:99999', outputId: 'x',
        parts: [{ index: 0, text: 'a' }] })).toMatchObject({ status: 'unavailable', error: 'not_bound' })
      expect(sender).not.toHaveBeenCalled()
    } finally { for (const off of offs) off(); events.dispose() }
  })

  it('keeps an unconfirmed send out of the retry list: no duplicate bubble', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qq-ro04-unknown-'))
    try {
      const store = new DeliveryStore(join(root, 'delivery.json'))
      const ctx: HandlerContext = { scope: 'private', userId: OWNER, owner: true, messageId: 'out-u',
        payload: '', respond: async () => {}, send: async () => ({}) }
      const { turn } = await store.accept(ctx, { sessionId: 'qq-u', externallyManaged: true,
        parts: [{ outputIndex: 0, text: '已发', kind: 'reply', state: 'sent', platformId: 'p1' },
                { outputIndex: 1, text: '未确认', kind: 'reply', state: 'unknown' }] })
      turn.state = 'unknown'
      await store.save()
      expect(store.outputView('out-u')).toMatchObject({ pending: [], retryable: false })
      expect(store.pendingOutputs()).toEqual([])
      // A part that never left is the only one a resume may send.
      const reopened = new DeliveryStore(join(root, 'delivery.json'))
      await reopened.open()
      reopened.outputTurn('out-u')!.parts[1].state = 'pending'
      await reopened.save()
      expect(reopened.outputView('out-u')).toMatchObject({ pending: [1], retryable: true })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
