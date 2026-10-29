import { describe, it, expect } from 'vitest'
import { MessageRouter } from '../src/router.js'
import { AccessGate } from '../src/security.js'
import { AgentRpcHandler } from '../src/handlers/agent.js'
import { QqControlDispatcher } from '../src/handlers/control.js'
import { QqBridgeEvents } from '../src/bridge-events.js'
import { readPlatformMessageId } from '../src/plugin.js'
import { OnebotMessageEvent } from '../src/onebot/types.js'

it('returns chat isolation readiness across admission copies without changing trusted input', async () => {
  const bridge = new QqBridgeEvents()
  const input = { sessionId: 'qq-friend', sessionKey: 'private:3309902729', scope: 'private' as const,
    owner: false, userId: 3309902729, input: '你好', chatOnlyReady: true }
  await bridge.prepare(input)
  expect(input.chatOnlyReady).toBe(false)
  const subscription = bridge.subscribeAdmission(async prepared => {
    expect(prepared).not.toBe(input)
    prepared.chatOnlyReady = true
    prepared.owner = true
    prepared.input = '不应回传的正文'
  })
  bridge.subscribeAdmission(async () => {})
  await bridge.prepare(input)
  expect(input.chatOnlyReady).toBe(true)
  expect(input.owner).toBe(false)
  expect(input.input).toBe('你好')
  expect(bridge.binding('qq-friend')).toMatchObject({ owner: false, input: '你好' })
  subscription.dispose()
  await bridge.prepare(input)
  expect(input.chatOnlyReady).toBe(false)
})

function makeEvent(partial: Partial<OnebotMessageEvent> & { user_id: number | string; raw_message: string }): OnebotMessageEvent {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: partial.user_id,
    raw_message: partial.raw_message,
    message_id: 7,
    ...partial,
  } as OnebotMessageEvent
}

function harness(options: { gate?: Partial<ConstructorParameters<typeof AccessGate>[0]>; withReceipt?: boolean } = {}) {
  const sent: string[] = []
  const gate = new AccessGate({
    adminQq: 10001, allowlist: [10002], commandPrefix: '', mode: 'whitelist', ...options.gate,
  })
  const outbound = async (_scope: 'private' | 'group', _id: number | string, text: string) => {
    sent.push(text)
  }
  const receipt = options.withReceipt
    ? async (_scope: 'private' | 'group', _id: number | string, text: string) => {
        sent.push(text)
        return { platformId: `msg-${sent.length}` }
      }
    : undefined
  const router = new MessageRouter(gate, outbound, undefined, receipt)
  return { router, sent, gate }
}

describe('bridge turn report — facts other plugins may rely on', () => {
  it('ordinary and followup replies keep contact metadata out of both QQ and turn reports', async () => {
    const { router, sent } = harness({ withReceipt: true })
    const reports: string[] = []
    const raw = '明天再聊<下次联系>明天20:30｜面试</下次联系><选题>c1</选题>'
    router.register(new AgentRpcHandler({ run: async () => raw }, {
      ackMessage: '', observeTurn: report => reports.push(report.reply),
    }))
    await router.route(makeEvent({ user_id: 10001, raw_message: '好呀' }))
    expect(sent).toEqual(['明天再聊'])
    expect(reports).toEqual(['明天再聊'])

    const followup = new AgentRpcHandler({ run: async () => 'unexpected' }, {
      sessionIdOf: () => 'qq-followup',
      restoreContext: input => ({ ...input, respond: async text => { sent.push(text) } }),
    })
    try {
      await followup.sendSessionOutput({ sessionKey: 'private:10001', sessionId: 'qq-followup',
        scope: 'private', owner: true, userId: 10001, input: '' }, 2, raw)
      expect(sent).toEqual(['明天再聊', '明天再聊'])
      expect(reports).toEqual(['明天再聊'])
    } finally { await followup.dispose() }
  })

  it('reports the owner flag from the configured admin identity only', async () => {
    const { router } = harness()
    const seen: Array<{ owner: boolean; user: string | number }> = []
    router.register(new AgentRpcHandler(
      { run: async () => '好' },
      { ackMessage: '', observeTurn: (report) => { seen.push({ owner: report.owner, user: report.userId }) } },
    ))
    await router.route(makeEvent({ user_id: 10001, raw_message: '主人' }))
    await router.route(makeEvent({ user_id: 10002, raw_message: '白名单成员' }))
    expect(seen).toEqual([{ owner: true, user: 10001 }, { owner: false, user: 10002 }])
  })

  it('open access mode still does not make a stranger the owner', async () => {
    const { router } = harness({ gate: { mode: 'open' } })
    const owners: boolean[] = []
    router.register(new AgentRpcHandler(
      { run: async () => '好' },
      { ackMessage: '', observeTurn: (report) => owners.push(report.owner) },
    ))
    await router.route(makeEvent({ user_id: 99999, raw_message: '陌生' }))
    expect(owners).toEqual([false])
  })

  it('reports the final visible text and the platform ids actually accepted', async () => {
    const { router, sent } = harness({ withReceipt: true })
    const reports: Array<{ reply: string; input: string; parts: unknown[] }> = []
    const dispatcher = new QqControlDispatcher()
    dispatcher.register({
      action: 'set_cwd',
      run: async () => '已切换工作区',
    })
    router.register(new AgentRpcHandler(
      { run: async () => '看见这条<b>粗体</b>。\n<dsh-qq-bridge-control>{"action":"set_cwd","path":"/"}</dsh-qq-bridge-control>' },
      {
        ackMessage: '',
        controlDispatcher: dispatcher,
        // Tight enough that the visible text splits into several parts, wide
        // enough that the bridge's own control notice is not shredded too.
        maxMessageLength: 7,
        observeTurn: (report) => reports.push({ reply: report.reply, input: report.input, parts: report.parts }),
      },
    ))
    await router.route(makeEvent({ user_id: 10001, raw_message: '换目录' }))
    expect(reports).toHaveLength(1)
    const [report] = reports
    // The control block is bridge scaffolding: it must never become the
    // assistant reply a memory may store.
    expect(report.reply).toBe('看见这条<b>粗体</b>。')
    expect(report.reply).not.toContain('dsh-qq-bridge-control')
    expect(report.input).toBe('换目录')
    // A split reply records one accepted part per platform message, with the
    // id the transport returned.
    expect(report.parts.length).toBeGreaterThan(1)
    expect(report.parts.every((part: any) => part.ok === true)).toBe(true)
    expect(report.parts.every((part: any) => typeof part.platformId === 'string')).toBe(true)
    expect(sent).toContain('已切换工作区')
  })

  it('a failed generation reports failure instead of a fabricated reply', async () => {
    const { router } = harness()
    const reports: Array<{ status: string; reply: string }> = []
    router.register(new AgentRpcHandler(
      { run: async () => { throw new Error('模型超时') } },
      { ackMessage: '', observeTurn: (report) => reports.push({ status: report.status, reply: report.reply }) },
    ))
    await router.route(makeEvent({ user_id: 10001, raw_message: '在吗' }))
    expect(reports).toHaveLength(1)
    expect(reports[0].status).toBe('failed')
    // The user still sees the bridge's error notice, but it is not presented as
    // a completed assistant turn with its own reply body.
    expect(reports[0].reply).toContain('agent error')
  })

  it('the agent gets the user words verbatim: no source banner, style marker, or auto-invoked skill', async () => {
    const seen: Array<{ input: string; payload: string }> = []
    const raw = '本条用户消息来自 dsh-qq-bridge QQ 会话。\nUser QQ Message:\n你好'
    for (const qqReplyStyleSkill of [undefined, { enabled: true, skillName: 'qq-session-reply-style' }]) {
      const { router } = harness()
      const payloads: string[] = []
      router.register(new AgentRpcHandler(
        { run: async (_key: string, payload: string) => { payloads.push(payload); return '好' } },
        {
          ackMessage: '',
          ...(qqReplyStyleSkill ? { qqReplyStyleSkill } : {}),
          observeTurn: (report) => seen.push({ input: report.input, payload: payloads[0] }),
        },
      ))
      await router.route(makeEvent({ user_id: 10001, raw_message: raw }))
      // The payload is byte-for-byte the user's message, even when it already
      // looks like the old wrapper: nothing is stripped and nothing is added.
      expect(payloads).toEqual([raw])
      expect(seen.at(-1)?.input).toBe(raw)
    }
    expect(seen.map(s => s.input)).toEqual([raw, raw])
  })
  it('subscribers are isolated: one throwing listener cannot break the bridge or its peers', async () => {
    const events = new QqBridgeEvents()
    const seen: string[] = []
    events.subscribe(() => { throw new Error('bad subscriber') })
    const subscription = events.subscribe((report) => seen.push(report.reply))
    events.publish({
      sessionKey: 'private:10001', scope: 'private', userId: 10001, owner: true,
      input: 'hi', reply: '哦', parts: [], status: 'completed',
    })
    expect(seen).toEqual(['哦'])
    subscription.dispose()
    subscription.dispose()
    events.publish({
      sessionKey: 'private:10001', scope: 'private', userId: 10001, owner: true,
      input: 'again', reply: '嗯', parts: [], status: 'completed',
    })
    expect(seen).toEqual(['哦'])
    expect(events.listenerCount).toBe(1)
    events.dispose()
    expect(events.listenerCount).toBe(0)
  })

  it('extracts a platform id from every transport shape, without inventing one', () => {
    expect(readPlatformMessageId({ data: { message_id: 123 } })).toBe('123')
    expect(readPlatformMessageId({ id: 'abc' })).toBe('abc')
    expect(readPlatformMessageId({ messageId: 'm-1' })).toBe('m-1')
    expect(readPlatformMessageId({ msgId: 'g-2' })).toBe('g-2')
    expect(readPlatformMessageId({ status: 'ok', retcode: 0, data: null })).toBeUndefined()
    expect(readPlatformMessageId(undefined)).toBeUndefined()
    expect(readPlatformMessageId({})).toBeUndefined()
  })
})
