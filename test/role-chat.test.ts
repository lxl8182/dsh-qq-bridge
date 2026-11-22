import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_QQ_AGENT_ROLES } from '../src/config.js'
import { RoleChatCoordinator, roleSessionKeyOf, type RoleChatRunner } from '../src/handlers/role-chat.js'
import { installRoleOnlyPrompt, type ActiveRoleInput } from '../src/handlers/role-context.js'
import { MessageRouter } from '../src/router.js'
import { AccessGate } from '../src/security.js'

const roles = DEFAULT_QQ_AGENT_ROLES.map(role => ({ ...role, provider: 'test', model: role.id, persona: role.id }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('QQ multi-role chat', () => {
  let directory: string
  let path: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qq-role-test-'))
    path = join(directory, 'role-chat.json')
  })
  afterEach(async () => {
    await rm(path, { force: true })
    await rmdir(directory)
  })

  function fakeRunner() {
    const sessions = new Map<string, string>()
    let count = 0
    const runner = {
      ensureRoleSession: vi.fn<RoleChatRunner['ensureRoleSession']>(async (key, role) => {
        const roleKey = roleSessionKeyOf(key, role.id)
        const id = sessions.get(roleKey) ?? `dsh-${++count}`
        sessions.set(roleKey, id)
        return id
      }),
      archiveRoleSession: vi.fn<RoleChatRunner['archiveRoleSession']>(async (key, roleId) => {
        sessions.delete(roleSessionKeyOf(key, roleId))
      }),
      restoreSessions: vi.fn<RoleChatRunner['restoreSessions']>(rows => {
        for (const row of rows) sessions.set(row.sessionKey, row.sessionId)
      }),
      runRole: vi.fn<RoleChatRunner['runRole']>(async (_key, role) => `${role.id} replied`),
      prepareImages: vi.fn(async () => []),
      isSessionArchived: vi.fn((_id: string) => false),
    }
    return runner
  }

  function routeThrough(coordinator: RoleChatCoordinator) {
    const sent: string[] = []
    const router = new MessageRouter(new AccessGate({ adminQq: 10, allowlist: [20], mode: 'whitelist', commandPrefix: '' }),
      async (_scope, _target, text) => { sent.push(text) })
    router.register(coordinator)
    return {
      sent,
      send: (message_id: number, raw_message: string, user_id = 10) => router.route({
        post_type: 'message', message_type: 'private', user_id, raw_message, message_id,
      }),
    }
  }

  it('starts all four models, sends in completion order and reloads their shared transcript', async () => {
    const runner = fakeRunner()
    const models = new Map(roles.map(role => [role.id, deferred<string>()]))
    runner.runRole.mockImplementation((_key, role) => models.get(role.id)!.promise)
    const first = new RoleChatCoordinator(path, roles, runner, 4500)
    const chat = routeThrough(first)
    expect(await chat.send(1, 'denied', 99)).toBe(false)
    const input = chat.send(1, 'first question')
    await vi.waitFor(() => expect(runner.runRole).toHaveBeenCalledTimes(4))

    for (const [index, role] of ['ds', 'gpt', 'gemini', 'claude'].entries()) {
      models.get(role)!.resolve(`answer ${role}`)
      await vi.waitFor(() => expect(chat.sent[index]).toBe(`${role}: answer ${role}`))
    }
    await input
    await first.dispose()

    const restored = new RoleChatCoordinator(path, roles, runner, 4500)
    await restored.open()
    expect(runner.restoreSessions.mock.calls[0]?.[0]).toHaveLength(4)
    const next = routeThrough(restored)
    await next.send(1, 'first question')
    expect(next.sent).toEqual([])
    await next.send(2, 'follow-up')
    const secondTurn = runner.runRole.mock.calls.slice(4)
    expect(secondTurn).toHaveLength(4)
    for (const [, , turn] of secondTurn) {
      expect(turn.map(message => message.text)).toEqual([
        'first question', 'answer ds', 'answer gpt', 'answer gemini', 'answer claude', 'follow-up',
      ])
    }
    await next.send(3, 'separate chat', 20)
    expect(runner.runRole.mock.lastCall?.[2].map(message => message.text)).toEqual(['separate chat'])
    await restored.dispose()
  })

  it('queues the reset, retains the old IDs on failure and creates four fresh sessions after archive', async () => {
    const runner = fakeRunner()
    const lastReply = deferred<string>()
    runner.runRole.mockImplementationOnce(() => lastReply.promise)
    const first = new RoleChatCoordinator(path, roles, runner, 4500)
    const chat = routeThrough(first)
    const message = chat.send(1, 'save me')
    await vi.waitFor(() => expect(runner.runRole).toHaveBeenCalledTimes(4))
    const old = (await Promise.all(runner.ensureRoleSession.mock.results.map(result => result.value))) as string[]
    runner.archiveRoleSession.mockRejectedValueOnce(new Error('archive unavailable'))
    const reset = chat.send(2, '/new-session')
    expect(runner.archiveRoleSession).not.toHaveBeenCalled()
    lastReply.resolve('last reply')
    await Promise.all([message, reset])
    expect(chat.sent.at(-1)).toContain('重开多角色会话失败')
    expect(runner.ensureRoleSession).toHaveBeenCalledTimes(4)
    await first.dispose()

    const restarted = new RoleChatCoordinator(path, roles, runner, 4500)
    await restarted.open()
    const next = routeThrough(restarted)
    await next.send(2, '/new-session')
    expect(next.sent).toEqual(['已归档旧聊天并新建四个角色会话。'])
    expect(runner.archiveRoleSession.mock.calls.slice(4).map(([, , id]) => id).sort()).toEqual(old.sort())
    expect(Math.max(...runner.archiveRoleSession.mock.invocationCallOrder))
      .toBeLessThan(runner.ensureRoleSession.mock.invocationCallOrder[4]!)
    const { conversations } = JSON.parse(await readFile(path, 'utf8'))
    const active = conversations['private:10']
    expect(Object.values(active.sessions)).toHaveLength(4)
    expect(Object.values(active.sessions).filter(id => old.includes(id as string))).toEqual([])
    expect(active.archives).toHaveLength(1)
    expect(active.archives[0].messages).toHaveLength(5)
    expect(active.messages).toEqual([])
    await next.send(2, '/new-session')
    expect(runner.archiveRoleSession).toHaveBeenCalledTimes(8)
    await next.send(3, 'after reset')
    expect(runner.runRole.mock.lastCall?.[2].map(message => message.text)).toEqual(['after reset'])
    const webArchived = Object.values(active.sessions)[0]
    runner.isSessionArchived.mockImplementation(id => id === webArchived)
    await next.send(4, 'after Web archive')
    expect(runner.archiveRoleSession).toHaveBeenCalledTimes(12)
    for (const [, , turn] of runner.runRole.mock.calls.slice(-4)) {
      expect(turn.map(message => message.text)).toEqual(['after Web archive'])
    }
    await restarted.dispose()
  })

  it('keeps the committed transcript prefix and admits only new chat entries', async () => {
    const system = { id: 'persona', role: 'system', content: [{ type: 'text', text: '角色' }] }
    const previousUser = { id: 'previous', role: 'user', source: { kind: 'user', qqRoleIndex: 0 },
      content: [{ type: 'text', text: '{"speaker":"用户","text":"first"}\n' }] }
    const previousReply = { id: 'native-reply', role: 'assistant', content: [{ type: 'reasoning', text: 'private' }] }
    const events = [
      { type: 'system/message', data: { message: system } },
      { type: 'user/message', data: previousUser },
      { type: 'assistant/message', data: { message: previousReply } },
    ]
    const session = {
      id: 'role-session',
      surface: { nodes: [0, 1, 2] },
      eventAt: (seq: number) => events[seq],
      requestHeader: () => undefined,
      append: vi.fn(),
    }
    const hooks = new Map<string, (...args: any[]) => unknown>()
    const register = () => () => {}
    const scope = {
      on: (event: string, callback: (...args: any[]) => unknown) => hooks.set(event, callback),
      systemPrompt: { section: register, context: register, suppressRuntimeContext: register },
      tools: { restrict: register, guard: register },
    }
    const input: { current?: ActiveRoleInput } = { current: { id: 'current', transcript: [
      { kind: 'user', speaker: '用户', text: 'first', at: 0 },
      { kind: 'assistant', speaker: 'gemini', text: 'peer reply', at: 1 },
      { kind: 'assistant', speaker: 'gpt', text: 'own visible reply', at: 2 },
      { kind: 'user', speaker: '用户', text: 'second', at: 3 },
    ] } }
    installRoleOnlyPrompt(scope, session, '角色', input)
    const currentUser = { id: 'current', role: 'user', content: [{ type: 'text', text: '{"speaker":"用户","text":"second"}\n' }] }
    const decision = await hooks.get('agent/pre-step')!({ messages: [currentUser] }) as { messages: Array<{
      id: string; source: { qqRoleIndex: number }; content: Array<{ text: string }>;
    }> }
    expect(decision.messages.map(message => message.source.qqRoleIndex)).toEqual([1, 2, 3])
    expect(decision.messages.map(message => JSON.parse(message.content[0]!.text).text)).toEqual([
      'peer reply', 'own visible reply', 'second',
    ])
    expect(decision.messages.at(-1)?.id).toBe('current')
    await hooks.get('agent/request')!({ turn: 2, step: 1 }, async () => ({}))
    expect(session.append).toHaveBeenCalledWith('system/message', expect.objectContaining({
      message: expect.objectContaining({ content: [] }),
    }), { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] })
    const stream = hooks.get('llm/stream')!
    const clean = [system, previousUser, ...decision.messages]
    expect(stream({ sessionId: session.id, messages: clean }, () => 'dispatched')).toBe('dispatched')
    expect(() => stream({ sessionId: session.id, messages: [...clean, previousReply] }, () => 'dispatched'))
      .toThrow('QQ 角色请求含有聊天记录和人设之外的上下文。')
  })
})
