import { describe, it, expect, vi } from 'vitest'
import { DshAgentExecutor, extractLastAssistantText, hashKey, DshRenderedAgent, isUnexecutedDsmlToolCall } from '../src/handlers/dsh-executor.js'
import { BridgeModelSelectionRef, installBridgeModelSelection } from '../src/handlers/model-control.js'
import { makeDshExecutor } from '../src/plugin.js'

function surfaceEvent(type: string, content: unknown[]) {
  return { type, content }
}

interface MockState {
  createCalls: string[]
  createCwds: Array<string | undefined>
  createSessionIds: string[]
  createSelections: BridgeModelSelectionRef[]
  drops: string[]
}

/** 内存 mock:按 sessionId 记录创建/释放,readSurface 返回固定 surface 序列。 */
function makeMock(repliesBySession: Record<string, unknown[]>) {
  const live = new Map<string, DshRenderedAgent>()
  const state: MockState = { createCalls: [], createCwds: [], createSessionIds: [], createSelections: [], drops: [] }
  const dsh = {
    async getOrCreate({
      sessionKey,
      sessionId,
      cwd,
      modelSelection,
    }: {
      sessionKey: string
      sessionId: string
      cwd?: string
      modelSelection: BridgeModelSelectionRef
    }): Promise<DshRenderedAgent> {
      state.createCalls.push(sessionKey)
      state.createCwds.push(cwd)
      state.createSessionIds.push(sessionId)
      state.createSelections.push(modelSelection)
      const agent: DshRenderedAgent = {
        followup: vi.fn(),
        async whenIdle() {},
        async dispose() {
          live.delete(sessionId)
          state.drops.push(sessionId)
        },
        _commandAgent: { sessionKey, sessionId },
      }
      live.set(sessionId, agent)
      return agent
    },
    async deliver(_agent: DshRenderedAgent, _prompt: string) {},
    async readSurface(sessionId: string) {
      // executor 的 sessionId 现带 boot 后缀(`qq-<hash>-<suffix>`),按前缀匹配 mock 键。
      const key = Object.keys(repliesBySession).find((k) => sessionId.startsWith(k))
      return (key !== undefined ? repliesBySession[key] : []) as never
    },
  }
  return { dsh, state }
}

describe('dsh-qq-bridge — DshAgentExecutor(多轮上下文)', () => {
  it('reopens saved friend and group session IDs without sharing their histories', async () => {
    const saved = new Map<string, { header: { cwd: string }; snapshotEvents(): unknown[] }>()
    const create = vi.fn(async (_ctx: unknown, options: { sessionId: string }) => {
      const session = { header: { cwd: '/original' }, snapshotEvents: () => [{ type: 'user/message', data: 'old history' }] }
      saved.set(options.sessionId, session)
      return { agent: { session, followup() {}, async whenIdle() {} }, async dispose() {} }
    })
    const resume = vi.fn(async (_ctx: unknown, options: { resumeSessionId: string }) => ({
      agent: { session: saved.get(options.resumeSessionId)!, followup() {}, async whenIdle() {} }, async dispose() {},
    }))
    const ctx = { agentLoop: { createAgent: create, resume } } as never
    const first = makeDshExecutor(ctx)
    const friend = await first.prepareSession('private:10002')
    const group = await first.prepareSession('group:90001')
    await first.disposeAll()
    const restarted = makeDshExecutor(ctx)
    restarted.restoreSessions([{ sessionKey: 'private:10002', sessionId: friend }, { sessionKey: 'group:90001', sessionId: group }])
    expect(await restarted.prepareSession('private:10002')).toBe(friend)
    expect(await restarted.prepareSession('group:90001')).toBe(group)
    expect(await restarted.prepareSession('private:10003')).not.toBe(friend)
    expect(resume.mock.calls.map(([, options]) => options.resumeSessionId)).toEqual([friend, group])
    expect(create).toHaveBeenCalledTimes(3)
    await restarted.disposeAll()
  })

  it('reads the rc.3 live log, retaining turn boundaries and the original input before spell followups', async () => {
    const events: unknown[] = []
    const session = { id: '', snapshotEvents: () => events }
    const readSession = vi.fn(async () => ({ events: [] }))
    const dispose = vi.fn(async () => {})
    const executor = makeDshExecutor({
      agentLoop: { createAgent: async (_ctx: unknown, options: { sessionId: string }) => {
        session.id = options.sessionId
        return { dispose, agent: {
          session,
          followup(message: unknown) {
            events.push(
              { type: 'turn/start', data: { turn: 1 } },
              { type: 'user/message', data: message },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我先看看。' }] } } },
              { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
              { type: 'turn/start', data: { turn: 2 } },
              { type: 'user/message', data: { id: 'feedback', source: { kind: 'companion-spell' } } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '看完了。' }] } } },
              { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
            )
          },
          async whenIdle() {},
        } }
      } },
      sessionQuery: { readSession },
    } as never)
    expect(await executor.run('private:owner', '帮我看看')).toBe('我先看看。')
    const input = events[1] as { data: { id: string } }
    expect(executor.lastTurnIdentity('private:owner')).toEqual({ sessionId: session.id, messageId: input.data.id })
    await executor.disposeAll()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('reports the current admission failure before input commit instead of hiding it behind the commit check', async () => {
    const events: unknown[] = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'old failure' } } } },
    ]
    const executor = makeDshExecutor({ agentLoop: { createAgent: async () => ({
      agent: {
        session: { snapshotEvents: () => events },
        followup() {
          events.push(
            { type: 'turn/start', data: { turn: 2 } },
            { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'current admission failed' } } } },
          )
        },
        async whenIdle() {},
      },
      async dispose() {},
    }) } } as never)
    await expect(executor.run('private:owner', '新消息')).rejects.toThrow('current admission failed')
    expect(executor.lastTurnIdentity('private:owner')).toBeUndefined()
    await executor.disposeAll()
  })

  it('binds the reply and identity to the delivered turn even when followups finish before idle', async () => {
    const sid = `qq-${hashKey('private:10001')}`
    const message = (id: string, kind: string, text: string) => ({ type: 'user/message',
      data: { id, source: { kind }, content: [{ type: 'text', text }] } })
    const reply = (text: string) => ({ type: 'assistant/message', data: {
      message: { content: [{ type: 'text', text }] } } })
    const { dsh } = makeMock({ [sid]: [
      { type: 'turn/start', data: { turn: 1 } }, message('in-1', 'user', '执行任务'), reply('我去执行。'),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } }, message('feedback-1', 'companion-spell', '任务完成'), reply('执行好了。'),
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 3 } }, message('in-2', 'user', '下一件事'),
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'error' } } },
    ] })
    const executor = new DshAgentExecutor({ ...dsh, deliver: async () => ({ messageId: 'in-1' }) })
    expect(await executor.run('private:10001', '执行任务')).toBe('我去执行。')
    expect(executor.lastTurnIdentity('private:10001')?.messageId).toBe('in-1')
    await executor.disposeAll()
  })

  it('同一 sessionKey 复用同一 live agent,不重复创建', async () => {
    const { dsh, state } = makeMock({})
    const exec = new DshAgentExecutor(dsh as never)
    await exec.run('private:10001', '第一句')
    expect(state.createCalls).toEqual(['private:10001'])
    await exec.run('private:10001', '第二句')
    // 复用,不再创建
    expect(state.createCalls).toEqual(['private:10001'])
    expect(exec.liveSessionCount).toBe(1)
  })

  it('默认思考强度写进新会话的模型选择,留空则完全不带该字段', async () => {
    const withEffort = makeMock({})
    const exec = new DshAgentExecutor(withEffort.dsh as never, {
      defaultProvider: 'd1api',
      defaultModel: 'deepseek-v4.1-flash',
      defaultReasoningEffort: 'high',
    })
    await exec.run('private:20001', 'hi')
    expect(withEffort.state.createSelections[0].current).toEqual({
      provider: 'd1api',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'high',
    })

    // 留空(settings 的默认值)必须等价于"沿用适配器行为",不能发一个字面空串。
    const withoutEffort = makeMock({})
    const plain = new DshAgentExecutor(withoutEffort.dsh as never, {
      defaultProvider: 'd1api',
      defaultModel: 'deepseek-v4.1-flash',
      defaultReasoningEffort: '',
    })
    await plain.run('private:20002', 'hi')
    expect(withoutEffort.state.createSelections[0].current).toEqual({
      provider: 'd1api',
      model: 'deepseek-v4.1-flash',
    })
  })

  it('多轮:每轮返回该会话的回复内容', async () => {
    const sid = `qq-${hashKey('private:10001')}`
    const { dsh } = makeMock({
      [sid]: [surfaceEvent('assistant/message', [{ type: 'text', text: 'reply for this turn' }])],
    })
    const exec = new DshAgentExecutor(dsh as never)
    const out = await exec.run('private:10001', 'q1')
    expect(out).toBe('reply for this turn')
    // 第二次复用同一 agent,仍能取到回复
    const out2 = await exec.run('private:10001', 'q2')
    expect(out2).toBe('reply for this turn')
  })

  it('不同 sessionKey 拥有独立 live agent', async () => {
    const { dsh } = makeMock({})
    const exec = new DshAgentExecutor(dsh as never)
    await exec.run('private:10001', 'hi')
    await exec.run('private:10002', 'hi')
    expect(exec.liveSessionCount).toBe(2)
  })

  it('disposeAll 释放全部常驻 agent', async () => {
    const { dsh, state } = makeMock({})
    const exec = new DshAgentExecutor(dsh as never)
    await exec.run('private:10001', 'x')
    await exec.run('group:555', 'y')
    expect(exec.liveSessionCount).toBe(2)
    await exec.disposeAll()
    expect(exec.liveSessionCount).toBe(0)
    expect(new Set(state.drops).size).toBe(2)
  })

  it('disposeSession 释放单个会话', async () => {
    const sid = `qq-${hashKey('private:10001')}`
    const { dsh, state } = makeMock({})
    const exec = new DshAgentExecutor(dsh as never)
    await exec.run('private:10001', 'x')
    await exec.run('private:10002', 'y')
    expect(exec.liveSessionCount).toBe(2)
    await exec.disposeSession('private:10001')
    expect(exec.liveSessionCount).toBe(1)
    expect(state.drops.some((s) => s.startsWith(sid))).toBe(true)
  })

  it('setCwd 释放当前会话,并让下一轮用新目录创建新 session', async () => {
    const { dsh, state } = makeMock({})
    const exec = new DshAgentExecutor(dsh as never, { defaultCwd: '/default' })

    await exec.run('private:10001', 'before')
    await exec.setCwd('private:10001', '/tmp')
    await exec.run('private:10001', 'after')

    expect(state.createCalls).toEqual(['private:10001', 'private:10001'])
    expect(state.createCwds).toEqual(['/default', '/tmp'])
    expect(state.createSessionIds[0]).not.toBe(state.createSessionIds[1])
    expect(state.drops).toContain(state.createSessionIds[0])
  })

  it('startNewSession 释放当前会话,保留 cwd,并让下一轮创建新 session', async () => {
    const { dsh, state } = makeMock({})
    const exec = new DshAgentExecutor(dsh as never, { defaultCwd: '/default' })

    await exec.setCwd('private:10001', '/project')
    await exec.run('private:10001', 'before')
    const previousVersion = exec.getSessionVersion('private:10001')
    await exec.startNewSession('private:10001')
    await exec.run('private:10001', 'after')

    expect(exec.getSessionVersion('private:10001')).toBe(previousVersion + 1)
    expect(state.createCalls).toEqual(['private:10001', 'private:10001'])
    expect(state.createCwds).toEqual(['/project', '/project'])
    expect(state.createSessionIds[0]).not.toBe(state.createSessionIds[1])
    expect(state.drops).toContain(state.createSessionIds[0])
  })

  it('getCwd 返回当前 session cwd,未切换时使用默认目录', async () => {
    const { dsh } = makeMock({})
    const exec = new DshAgentExecutor(dsh as never, { defaultCwd: '/default' })

    expect(exec.getCwd('private:10001')).toBe('/default')
    await exec.setCwd('private:10001', '/tmp')
    expect(exec.getCwd('private:10001')).toBe('/tmp')
  })

  it('selectModel 更新当前 live agent 的 selection ref,不销毁 session', async () => {
    const { dsh, state } = makeMock({})
    const dispose = vi.fn()
    const exec = new DshAgentExecutor(dsh as never, {
      defaultProvider: 'deepseek-official',
      defaultModel: 'deepseek-v4-flash',
      resolveModelSelection: async (selection) => ({
        ...selection,
        reasoningEffort: selection.model === 'deepseek-v4-pro' ? 'high' : selection.reasoningEffort,
      }),
    })

    await exec.run('private:10001', 'before')
    state.createSelections[0].current.model = 'deepseek-v4-flash'
    ;(exec as unknown as { agents: Map<string, { dispose(): Promise<void> }> }).agents.get('private:10001')!.dispose = async () => {
      dispose()
    }

    const selected = await exec.selectModel('private:10001', 'deepseek-v4-pro')

    expect(selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
    expect(state.createSelections[0].current).toEqual(selected)
    expect(dispose).not.toHaveBeenCalled()
    expect(exec.liveSessionCount).toBe(1)
  })

  it('runPermissionCommand 通过当前 live agent 执行 DSH 原生命令且不投递用户消息', async () => {
    const { dsh, state } = makeMock({})
    const deliver = vi.spyOn(dsh, 'deliver')
    const executeCommand = vi.fn(async (_agent: unknown, line: string) => `权限命令执行成功: ${line}`)
    const exec = new DshAgentExecutor(dsh as never, { executeCommand })

    const out = await exec.runPermissionCommand('private:10001', 'workspace-write')

    expect(out).toBe('权限命令执行成功: /permission workspace-write')
    expect(state.createCalls).toEqual(['private:10001'])
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'private:10001' }),
      '/permission workspace-write',
    )
    expect(deliver).not.toHaveBeenCalled()
    expect(exec.liveSessionCount).toBe(1)
  })

  it('installBridgeModelSelection 在下一次 request 边界应用快照', async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>()
    const agentCtx = {
      on: vi.fn((event: string, cb: (...args: never[]) => unknown) => {
        listeners.set(event, cb)
        return () => listeners.delete(event)
      }),
    }
    const selection: BridgeModelSelectionRef = {
      current: { provider: 'alpha', model: 'a1', reasoningEffort: 'high' },
    }

    const dispose = installBridgeModelSelection(agentCtx, selection)
    const assemble = listeners.get('system-prompt/assemble')!
    const request = listeners.get('agent/request')!

    const assembled = await assemble({}, {}, async () => ({ variables: { cwd: '/work' } })) as { variables: Record<string, unknown> }
    expect(assembled.variables).toEqual({ cwd: '/work', provider: 'alpha', model: 'a1' })

    selection.current = { provider: 'beta', model: 'b1' }
    await expect(request({}, async () => ({
      provider: 'seed',
      model: 'seed',
      reasoningEffort: 'old',
      temperature: 0.2,
    }))).resolves.toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: 'high',
      temperature: 0.2,
    })

    await assemble({}, {}, async () => ({ variables: {} }))
    await expect(request({}, async () => ({
      provider: 'seed',
      model: 'seed',
      reasoningEffort: 'old',
      temperature: 0.2,
    }))).resolves.toEqual({
      provider: 'beta',
      model: 'b1',
      temperature: 0.2,
    })

    dispose()
    expect(listeners.size).toBe(0)
  })

  it('并发消息按 sessionKey 串行,不并驱同一会话', async () => {
    const { dsh } = makeMock({})
    const exec = new DshAgentExecutor(dsh as never)
    const results = await Promise.all([
      exec.run('private:10001', 'q1'),
      exec.run('private:10001', 'q2'),
    ])
    expect(results).toHaveLength(2)
    expect(exec.liveSessionCount).toBe(1) // 只建一个 live agent
  })

  it('extractLastAssistantText 提取最后一条 assistant 文本', () => {
    const events = [
      surfaceEvent('user/message', [{ type: 'text', text: 'hi' }]),
      surfaceEvent('assistant/message', [{ type: 'text', text: 'hello' }]),
      surfaceEvent('assistant/message', [{ type: 'text', text: 'final' }]),
    ]
    expect(extractLastAssistantText(events)).toBe('final')
  })

  it('拦截未执行的 DSML 工具调用协议文本,避免透传给 QQ', async () => {
    const sid = `qq-${hashKey('private:10001')}`
    const { dsh } = makeMock({
      [sid]: [
        surfaceEvent('assistant/message', [{
          type: 'text',
          text: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="Bash">',
        }]),
      ],
    })
    const exec = new DshAgentExecutor(dsh as never)
    const out = await exec.run('private:10001', '当前工作目录是什么')
    expect(out).toContain('未被 DSH 执行的工具调用')
    expect(out).not.toContain('<｜｜DSML｜｜tool_calls>')
  })

  it('isUnexecutedDsmlToolCall 识别 DSML tool_calls 标记', () => {
    expect(isUnexecutedDsmlToolCall('<｜｜DSML｜｜tool_calls>')).toBe(true)
    expect(isUnexecutedDsmlToolCall('<tool_calls>\n<invoke name="run_shell">')).toBe(true)
    expect(isUnexecutedDsmlToolCall('normal answer')).toBe(false)
  })

  it('hashKey 稳定且区分', () => {
    expect(hashKey('a')).toBe(hashKey('a'))
    expect(hashKey('a')).not.toBe(hashKey('b'))
  })
})
