import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_QQ_AGENT_ROLES } from '../src/config.js'
import { RoleChatCoordinator, roleSessionKeyOf, type RoleChatRunner } from '../src/handlers/role-chat.js'
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
      isSessionArchived: vi.fn(() => false),
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
      expect(turn.history.map(block => block.type === 'text' && JSON.parse(block.text).text)).toEqual([
        'first question', 'answer ds', 'answer gpt', 'answer gemini', 'answer claude',
      ])
      expect(turn.current).toEqual([{ type: 'text', text: '{"speaker":"用户","text":"follow-up"}\n' }])
    }
    await next.send(3, 'separate chat', 20)
    expect(runner.runRole.mock.lastCall?.[2].history).toEqual([])
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
    expect(runner.runRole.mock.lastCall?.[2].history).toEqual([])
    const webArchived = Object.values(active.sessions)[0]
    runner.isSessionArchived.mockImplementation((id?: string) => id === webArchived)
    await next.send(4, 'after Web archive')
    expect(runner.archiveRoleSession).toHaveBeenCalledTimes(12)
    expect(runner.runRole.mock.calls.slice(-4).every(([, , turn]) => turn.history.length === 0)).toBe(true)
    await restarted.dispose()
  })
})
