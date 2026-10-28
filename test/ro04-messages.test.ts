import { it, expect, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRpcHandler, type QqTurnReport } from '../src/handlers/agent.js'
import { MessageRouter, type HandlerContext } from '../src/router.js'
import { AccessGate } from '../src/security.js'
import { makeDshExecutor } from '../src/plugin.js'
import { normalizeInboundMessage } from '../src/onebot/message.js'
import { replyParts } from '../src/message-format.js'
import { extractAssistantText } from '../src/handlers/dsh-executor.js'
import { QqBridgeEvents } from '../src/bridge-events.js'

it('normalizes media once before admission: DSH and memory share text and partial image failures', async () => {
  const admissions: string[] = [], reports: QqTurnReport[] = [], delivered: any[] = [], events: unknown[] = []
  let saves = 0
  const executor = makeDshExecutor({
    get: (name: string) => name === 'attachments' ? { saveImages: async () => {
      if (++saves === 2) throw new Error('synthetic admission failure')
      return [{ attachmentId: 'sha256:image1', mediaType: 'image/png', width: 1, height: 1, bytes: 1 }]
    } } : undefined,
    agentLoop: { createAgent: async () => ({ dispose: async () => {}, agent: {
      session: { snapshotEvents: () => events },
      followup(message: any) {
        delivered.push(message)
        events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: message },
          { type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'text', text: '看清啦' }] } } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      }, async whenIdle() {},
    } }) }, sessionQuery: { readSession: async () => ({ events }) },
  } as never)
  const handler = new AgentRpcHandler(executor, { ackMessage: '', prepareTurn: async input => { admissions.push(input.input) },
    observeTurn: report => { reports.push(report) }, fetchImpl: (async (url: string) =>
      new Response('image', { status: url.includes('bad') ? 404 : 200, headers: { 'content-type': 'image/png' } })) as typeof fetch })
  const router = new MessageRouter(new AccessGate({ adminQq: 1, allowlist: [], commandPrefix: '', mode: 'whitelist' }), async () => {})
  router.register(handler)
  const literal = '代码示例 [CQ:image,file=example]'
  try {
    await router.route({ post_type: 'message', message_type: 'private', user_id: 1, message_id: 1,
      raw_message: '看这个[CQ:image,file=secret,url=https://cdn/a?rkey=private]', message: [
        { type: 'text', data: { text: '看这个' } },
        { type: 'image', data: { url: 'https://cdn/a?rkey=private' } },
        { type: 'image', data: { url: 'https://cdn/bad' } },
        { type: 'image', data: { url: 'https://cdn/rejected' } },
        { type: 'text', data: { text: literal } },
      ] })
    const text = `看这个[图片1][图片2未能读取][图片3未能读取]${literal}`
    expect(saves).toBe(2)
    expect(admissions).toEqual([text])
    expect(delivered[0].content[0]).toEqual({ type: 'text', text })
    expect(delivered[0].content.filter((block: any) => block.type === 'image')).toHaveLength(1)
    expect(reports[0].input).toBe(text)
    expect(JSON.stringify(delivered)).not.toContain('rkey=private')
    expect(normalizeInboundMessage('[CQ:image,url=https://cdn/a?x=1&amp;y=2]')).toEqual({
      text: '[图片1]', images: [{ url: 'https://cdn/a?x=1&y=2', sourceIndex: 1 }],
    })
    expect(normalizeInboundMessage('原话', [])).toEqual({ text: '原话', images: [] })
  } finally { await handler.dispose(); await executor.disposeAll() }
})

it('preserves Unicode, structured blocks and completed assistant message boundaries', () => {
  const body = '唔……\n有一点点！\n```js\nconst emoji = "🐈"\n```\n- 第一条\n- 第二条'
  const plan = replyParts(body)
  expect(plan.parts).toEqual(['唔……\n', '有一点点！\n', '```js\nconst emoji = "🐈"\n```\n', '- 第一条\n- 第二条'])
  expect(plan.parts.join('')).toBe(body)
  expect(plan.part_sizes.reduce((sum, count) => sum + count, 0)).toBe(Array.from(body).length)
  expect(replyParts('🐈🐈🐈', 2).parts).toEqual(['🐈🐈', '🐈'])
  expect(replyParts('AAAA\nBBBB', 4).parts).toEqual(['AAAA', '\nBBB', 'B'])
  expect(replyParts('a | b\n--- | ---\n1 | 2').parts).toEqual(['a | b\n--- | ---\n1 | 2'])
  const many = Array.from({ length: 10 }, (_, index) => `第${index}句`).join('\n')
  expect(replyParts(many).parts.length).toBeLessThanOrEqual(6)
  expect(replyParts(many).parts.join('')).toBe(many)
  const message = (id: string, text: string, interrupted = false) => ({ type: 'assistant/message', data: {
    interrupted, message: { id, content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text }] },
  } })
  expect(extractAssistantText([message('a', '我先看看'), message('a', '我先看看。'),
    message('cut', '未完成的片段'), message('cut', '未完成', true),
    message('tool', '<tool_calls><invoke name="x"/>'), message('b', '看完啦')]))
    .toBe('我先看看。\n看完啦')
})

it('finishes every bubble before responding to a new input and never repeats sent parts after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-bubbles-'))
  const path = join(root, 'delivery.json'), sent: string[] = [], reports: QqTurnReport[] = []
  let waiting!: () => void
  let resume!: () => void, waits = 0
  const paused = new Promise<void>(resolve => { waiting = resolve })
  const send = async (text: string) => { sent.push(text); return { platformId: 'p' + sent.length } }
  const make = (id: string, payload: string): HandlerContext => ({ scope: 'private', userId: 1, owner: true,
    messageId: id, payload, respond: async () => {}, send })
  const executor = { run: vi.fn(async (_key: string, payload: string) => payload === 'first' ? '第一句\n\n第二句\n第三句' : '收到新消息'),
    prepareSession: async () => 'qq-test', lastTurnIdentity: () => ({ messageId: 'dsh-input' }) }
  const opts = { ackMessage: '', deliveryStatePath: path, sessionIdOf: () => 'qq-test',
    observeTurn: (report: QqTurnReport) => { reports.push(report) },
    restoreContext: (input: any) => ({ ...make('restore', ''), ...input }),
    waitForBubble: async () => {
      if (++waits !== 1) return
      const held = new Promise<void>(resolve => { resume = resolve })
      waiting()
      await held
    } }
  const handler = new AgentRpcHandler(executor, opts)
  try {
    await handler.open()
    const first = handler.run(make('1', 'first'))
    await paused
    const second = handler.run(make('2', 'second'))
    expect(executor.run).toHaveBeenCalledTimes(1)
    resume()
    await Promise.all([first, second])
    expect(sent).toEqual(['第一句', '第二句', '第三句', '收到新消息'])
    expect(reports.find(report => report.input === 'first')).toMatchObject({ status: 'completed',
      reply: '第一句\n\n第二句\n第三句',
      parts: [{ index: 0, chars: 5, ok: true }, { index: 1, chars: 4, ok: true }, { index: 2, chars: 3, ok: true }] })
    expect(Object.values(JSON.parse(await readFile(path, 'utf8')).turns).every((turn: any) => turn.state === 'complete')).toBe(true)
    await handler.dispose()
    const recovered = new AgentRpcHandler(executor, { ...opts, waitForBubble: async () => {} })
    await recovered.open(); await recovered.retryPending(); await recovered.dispose()
    expect(sent).toEqual(['第一句', '第二句', '第三句', '收到新消息'])
    expect(executor.run).toHaveBeenCalledTimes(2)
  } finally { await handler.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each(['proactive', 'followup'])('%s bubbles finish before the queued human input', async kind => {
  const sent: string[] = []
  const bridge = new QqBridgeEvents(), finish = bridge.beginOutput('qq-test')
  let ready!: () => void, resume!: () => void, waits = 0
  const paused = new Promise<void>(resolve => { ready = resolve })
  const send = async (text: string) => { sent.push(text); return { platformId: 'p' + sent.length } }
  const human: HandlerContext = { scope: 'private', userId: 1, owner: true, messageId: 'human',
    payload: '新消息', respond: async () => {}, send }
  const executor = { run: vi.fn(async () => '接你的新消息'), prepareSession: async () => 'qq-test' }
  const handler = new AgentRpcHandler(executor, { ackMessage: '', sessionIdOf: () => 'qq-test',
    waitForOutput: () => bridge.waitForOutput('qq-test'),
    restoreContext: input => ({ ...human, ...input }), waitForBubble: async () => {
      if (++waits !== 1) return
      const held = new Promise<void>(resolve => { resume = resolve })
      ready(); await held
    } })
  try {
    const incoming = handler.run(human)
    await Promise.resolve()
    expect(executor.run).not.toHaveBeenCalled()
    const binding = { scope: 'private' as const, owner: true, userId: 1, sessionId: 'qq-test', sessionKey: 'private:1', input: '' }
    const output = kind === 'proactive'
      ? handler.deliverOutput(binding, 'out-1', [{ index: 0, text: '第一句\n' }, { index: 1, text: '第二句' }], async () => true)
      : handler.sendSessionOutput(binding, 1, '第一句\n第二句')
    await paused
    expect(executor.run).not.toHaveBeenCalled()
    resume()
    await output
    finish()
    await incoming
    expect(sent).toEqual(['第一句', '第二句', '接你的新消息'])
  } finally { finish(); bridge.dispose(); await handler.dispose() }
})

it.each(['send', 'respond'] as const)('removes boundary blank lines through %s without changing saved parts or block layout', async transport => {
  const root = await mkdtemp(join(tmpdir(), 'qq-blank-lines-'))
  const path = join(root, 'delivery.json'), sent: string[] = []
  const send = async (text: string) => { sent.push(text); return { platformId: 'p' + sent.length } }
  const parts = [
    { index: 2, text: '第一句\n\n' },
    { index: 3, text: '\r\n  缩进内容\r\n \r\n' },
    { index: 4, text: '```text\n  代码\n\n  下一行\n```\n\n' },
  ]
  const input = { sessionKey: 'private:1', sessionId: 'qq-test', scope: 'private' as const, owner: true, userId: 1, input: '' }
  const handler = new AgentRpcHandler({ run: vi.fn() }, { deliveryStatePath: path, sessionIdOf: () => 'qq-test',
    restoreContext: saved => ({ ...saved, respond: async text => { await send(text) },
      ...(transport === 'send' ? { send } : {}) }), waitForBubble: async () => {} })
  try {
    await handler.open()
    const result = await handler.deliverOutput(input, 'blank-lines', parts, async () => true)
    expect(result.status).toBe('completed')
    expect(result.parts.map(part => part.index)).toEqual([2, 3, 4])
    expect(sent).toEqual(['第一句', '  缩进内容', '```text\n  代码\n\n  下一行\n```'])
    const saved = Object.values(JSON.parse(await readFile(path, 'utf8')).turns)[0] as any
    expect(saved.parts.map((part: any) => part.text)).toEqual(parts.map(part => part.text))
  } finally { await handler.dispose(); await rm(root, { recursive: true, force: true }) }
})
