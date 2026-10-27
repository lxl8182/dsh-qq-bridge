import { it, expect, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRpcHandler, type QqTurnReport } from '../src/handlers/agent.js'
import { DeliveryStore, type SavedInput } from '../src/delivery-store.js'
import type { HandlerContext } from '../src/router.js'
import { parseQqSpells, QqSpellDispatcher } from '../src/handlers/control.js'
import { registerQqSessionOutput } from '../src/plugin.js'
import { QqBridgeEvents } from '../src/bridge-events.js'

function context(send: NonNullable<HandlerContext['send']>): HandlerContext {
  return { scope: 'private', userId: 'owner', owner: true, messageId: 'in-1',
    payload: '真实用户输入', send, respond: async () => {} }
}

it('external output retries keep stable indices and require a fresh permission check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-external-'))
  const sent: string[] = []
  const input = { sessionKey: 'private:owner', sessionId: 'qq-test', scope: 'private' as const, owner: true, userId: 'owner', input: '' }
  const opts = { deliveryStatePath: join(root, 'queue.json'), sessionIdOf: () => 'qq-test',
    restoreContext: (saved: SavedInput) => ({ ...context(async text => {
      sent.push(text)
      if (sent.length === 2) throw new Error('offline')
      return { platformId: 'p' + sent.length }
    }), ...saved }) }
  let handler = new AgentRpcHandler({ run: vi.fn() }, opts)
  try {
    await handler.open()
    const first = await handler.deliverOutput(input, 'out1', [{ index: 4, text: 'first' }, { index: 5, text: 'second' }], async () => true)
    expect(first.parts.map(part => [part.index, part.ok])).toEqual([[4, true], [5, false]])
    await handler.dispose()
    handler = new AgentRpcHandler({ run: vi.fn() }, opts)
    await handler.open()
    await handler.retryPending()
    expect(sent).toEqual(['first', 'second'])
    expect((await handler.deliverOutput(input, 'out1', [{ index: 5, text: 'second' }], async () => false)).status).toBe('cancelled')
    const recovered = await handler.deliverOutput(input, 'out1', [{ index: 5, text: 'second' }], async () => true)
    expect(recovered.status).toBe('completed')
    expect(recovered.parts.map(part => part.index)).toEqual([4, 5])
    expect(sent).toEqual(['first', 'second', 'second'])
  } finally { await handler.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('delivers a bound session followup once, strips spells, and retries only its failed output parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-followup-'))
  const bridge = new QqBridgeEvents()
  const sessionId = 'qq-followup', sessionKey = 'private:owner'
  let listener: (session: { id: string; events: unknown[] }, event: unknown) => void = () => {}
  const unsubscribe = vi.fn()
  const attempts: string[] = []
  const send = async (text: string) => {
    attempts.push(text)
    if (attempts.length === 2) throw new Error('offline')
    return { platformId: `p-${attempts.length}` }
  }
  const run = vi.fn(async () => 'unexpected')
  const options = { deliveryStatePath: join(root, 'delivery.json'), ackMessage: '', maxMessageLength: 4,
    sessionIdOf: () => sessionId, restoreContext: (input: SavedInput) => ({ ...context(send), ...input }), observeTurn: vi.fn() }
  const handler = new AgentRpcHandler({ run }, options)
  try {
    await handler.open()
    await bridge.prepare({ sessionKey, sessionId, scope: 'private', owner: true, userId: 'owner', input: '执行任务' })
    const pending: Promise<void>[] = []
    const dispose = registerQqSessionOutput({ on: (_event, callback) => {
      listener = callback as typeof listener
      return unsubscribe
    } } as never, { currentSessionId: () => sessionId }, bridge, {
      sendSessionOutput: (...args) => { const result = handler.sendSessionOutput(...args); pending.push(result); return result },
    })
    const end = (turn: number) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { id: 'in-1', source: { kind: 'user' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '去做了。' }] } } }, end(1),
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: { id: 'feedback-1', source: { kind: 'companion-spell' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'abcdefghij<执行>secret</执行>' }] } } }, end(2),
    ]
    listener({ id: sessionId, events }, end(1))
    listener({ id: 'unbound-session', events }, end(2))
    listener({ id: sessionId, events }, end(2))
    listener({ id: sessionId, events }, end(2))
    await Promise.all(pending)
    expect(attempts).toEqual(['abcd', 'efgh', 'ij'])
    await handler.dispose()
    const restarted = new AgentRpcHandler({ run }, options)
    await restarted.open()
    await restarted.retryPending()
    expect(attempts).toEqual(['abcd', 'efgh', 'ij', 'efgh'])
    expect(run).not.toHaveBeenCalled()
    expect(options.observeTurn).not.toHaveBeenCalled()
    expect(await readFile(options.deliveryStatePath, 'utf8')).not.toContain('secret')
    await restarted.dispose()
    dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  } finally {
    await handler.dispose()
    bridge.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('QQ stripping includes built-in, meta and learned names while retaining HTML and incomplete tags', () => {
  const result = parseQqSpells('好了<b>粗体</b><执行>echo hi</执行><学咒语>说话 ||| 说明 ||| 执行 ||| echo {body}</学咒语><说话>你好</说话><忘掉咒语>说话</忘掉咒语><读取></读取>')
  expect(result.visibleText).toBe('好了<b>粗体</b>')
  expect(result.spells.map(spell => spell.spell)).toEqual(['执行', '学咒语', '说话', '忘掉咒语'])
  expect(parseQqSpells('<执行>还没写完').visibleText).toBe('<执行>还没写完')
})

it('QQ only strips spells, never executes or sends the old terminal feedback', async () => {
  const run = vi.fn(async () => '不该执行')
  const dispatcher = new QqSpellDispatcher()
  dispatcher.register({ spell: '执行', run })
  const sent: string[] = [], reports: QqTurnReport[] = []
  const handler = new AgentRpcHandler({ run: async () => '去看看。<执行>echo hi</执行><说话>你好</说话>' }, {
    ackMessage: '', spellDispatcher: dispatcher, observeTurn: report => { reports.push(report) },
  })
  await handler.run(context(async text => { sent.push(text); return {} }))
  expect(run).not.toHaveBeenCalled()
  expect(sent).toEqual(['去看看。'])
  expect(reports[0].reply).toBe('去看看。')
  await handler.dispose()
})

it('persisted and retried QQ output excludes spell bodies and does not repeat generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-spell-strip-'))
  try {
    const path = join(root, 'delivery.json')
    let attempts = 0
    const ctx = context(async () => { if (++attempts === 1) throw new Error('offline'); return { platformId: 'p1' } })
    const executor = { run: vi.fn(async () => '已出发。<执行>private-command</执行>'),
      prepareSession: async () => 'qq-test', lastTurnIdentity: () => ({ messageId: 'm1' }) }
    const handler = new AgentRpcHandler(executor, { ackMessage: '', deliveryStatePath: path, restoreContext: () => ctx })
    await handler.open()
    await handler.run(ctx)
    const saved = await readFile(path, 'utf8')
    expect(saved).not.toContain('private-command')
    expect(saved).not.toContain('<执行>')
    await handler.retryPending()
    expect(attempts).toBe(2)
    expect(executor.run).toHaveBeenCalledTimes(1)
    await handler.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('an input blocked before generation survives restart, then runs once after memory recovers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-admission-'))
  try {
    const sent: string[] = []
    const send = async (text: string) => { sent.push(text); return { platformId: `p-${sent.length}` } }
    const ctx = context(send)
    const executor = { run: vi.fn(async () => '恢复后回复'), prepareSession: async () => 'qq-test',
      lastTurnIdentity: () => ({ messageId: 'm-1' }) }
    const common = { deliveryStatePath: join(root, 'delivery.json'), ackMessage: '',
      restoreContext: () => ctx, sessionIdOf: () => 'qq-test' }
    const before = new AgentRpcHandler(executor, { ...common,
      prepareTurn: async () => { throw new Error('MEMORY_REQUIRED: synthetic offline') } })
    await before.open()
    await before.run(ctx)
    expect(executor.run).not.toHaveBeenCalled()
    expect(Object.values(JSON.parse(await readFile(common.deliveryStatePath, 'utf8')).turns)[0]).toMatchObject({ state: 'waiting' })
    await before.dispose()
    const after = new AgentRpcHandler(executor, { ...common, prepareTurn: async () => {} })
    await after.open()
    await after.retryPending()
    await after.run(ctx)
    expect(executor.run).toHaveBeenCalledTimes(1)
    expect(sent.filter(text => text === '恢复后回复')).toHaveLength(1)
    await after.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('a split reply resumes only failed parts after restart without running the model again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-delivery-'))
  try {
    const attempts: string[] = []
    const reports: QqTurnReport[] = []
    const send = async (text: string) => {
      attempts.push(text)
      if (attempts.length === 2) throw new Error('synthetic transport failure')
      return { platformId: `p-${attempts.length}` }
    }
    const ctx = context(send)
    const executor = { run: vi.fn(async () => 'abcdefghij'), prepareSession: async () => 'qq-test',
      lastTurnIdentity: () => ({ messageId: 'm-1' }) }
    const options = { deliveryStatePath: join(root, 'delivery.json'), ackMessage: '', maxMessageLength: 4,
      restoreContext: () => ctx, sessionIdOf: () => 'qq-test', observeTurn: (report: QqTurnReport) => { reports.push(report) } }
    const before = new AgentRpcHandler(executor, options)
    await before.open()
    await before.run(ctx)
    expect(attempts).toEqual(['abcd', 'efgh', 'ij'])
    expect(reports.at(-1)).toMatchObject({ status: 'failed', generationStatus: 'completed' })
    expect(reports.at(-1)?.parts.filter(part => part.ok)).toHaveLength(2)
    await before.dispose()
    const after = new AgentRpcHandler(executor, options)
    await after.open()
    await after.retryPending()
    expect(attempts).toEqual(['abcd', 'efgh', 'ij', 'efgh'])
    expect(executor.run).toHaveBeenCalledTimes(1)
    expect(reports.at(-1)?.parts.every(part => part.ok)).toBe(true)
    await after.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('a crash during generation or an unconfirmed send is kept unknown and never replayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-unknown-'))
  try {
    const ctx = context(vi.fn(async () => ({ platformId: 'unexpected' })))
    const path = join(root, 'delivery.json')
    const store = new DeliveryStore(path)
    const { turn } = await store.accept(ctx)
    turn.sessionId = 'qq-test'
    turn.state = 'running'
    await store.save()
    const executor = { run: vi.fn(async () => 'unexpected') }
    const handler = new AgentRpcHandler(executor, { deliveryStatePath: path, restoreContext: () => ctx })
    await handler.open()
    await handler.retryPending()
    expect(executor.run).not.toHaveBeenCalled()
    await handler.dispose()
    turn.state = 'output'
    turn.parts = [{ text: 'unknown', kind: 'reply', state: 'sending' }]
    await store.save()
    const reopened = new DeliveryStore(path)
    await reopened.open()
    expect(reopened.turns[turn.id].parts[0].state).toBe('unknown')
    expect(ctx.send).not.toHaveBeenCalled()
    const scrubber = new AgentRpcHandler(executor, { deliveryStatePath: path, restoreContext: () => ctx })
    await scrubber.open()
    await scrubber.retireSession('qq-test')
    const cleaned = await readFile(path, 'utf8')
    expect(cleaned).not.toContain('真实用户输入')
    expect(cleaned).not.toContain('"text":"unknown"')
    await scrubber.run(ctx)
    expect(executor.run).not.toHaveBeenCalled()
    await scrubber.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})
