import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSegmentPolicyAccess } from '../src/plugin.js'
import type { DshSegmentPolicy } from '../src/handlers/dsh-executor.js'

/**
 * 段端口接线(记忆插件发布、桥接取用)。
 *
 * 方向与 qqBridgeEvents 相反,所以这里验的是"取用"这一侧:
 * 服务缺失时不装、出现时装上同一对象、消失时卸干净。
 */

interface FakeCtx {
  inject?: (services: readonly string[], cb: (ctx: unknown) => void, label?: string) => { dispose(): void } | void
  get?: (name: string) => unknown
  effect?: (cb: () => void | (() => void), label?: string) => unknown
  companionSegmentPolicy?: DshSegmentPolicy
}

function fakeExecutor() {
  const calls: Array<DshSegmentPolicy | undefined> = []
  return {
    calls,
    setSegmentPolicy(policy: DshSegmentPolicy | undefined) { calls.push(policy) },
  }
}

/**
 * 最小 cordis 替身:inject 记住回调,并可模拟"服务出现"与"fiber 卸载"。
 *
 * get 只认已提供的服务,未提供时返回 undefined —— 与 cordis 的 ctx.get 一致
 * (不存在的服务不抛错;只有代理属性读才会抛)。
 */
function fakeHost() {
  let provided: DshSegmentPolicy | undefined
  let injected: ((ctx: unknown) => void) | undefined
  let effectDispose: (() => void) | undefined
  let fiberDisposed = false
  const ctx: FakeCtx = {
    inject: (_services, cb) => {
      injected = cb
      return { dispose: () => { fiberDisposed = true } }
    },
    get: () => provided,
    effect: (cb) => { effectDispose = cb() ?? undefined },
  }
  return {
    ctx,
    provide(policy: DshSegmentPolicy) { provided = policy },
    remove() { provided = undefined },
    /** 模拟宿主把服务交给了 fiber:回调执行一次。 */
    activate() { injected?.(ctx) },
    /** 模拟 fiber 卸载:执行 effect 注册的清理函数。 */
    teardown() { effectDispose?.() },
    get fiberDisposed() { return fiberDisposed },
    get injected() { return injected },
  }
}

describe('RO02-CTX 段端口接线:记忆插件发布、桥接取用', () => {
  it('without the service nothing is installed and behaviour is unchanged', () => {
    const host = fakeHost()
    const executor = fakeExecutor()
    const access = createSegmentPolicyAccess(host.ctx as never, executor)
    try {
      // fiber 已经注册(等端口出现),但端口没出现:一次都不许动 executor。
      expect(host.injected).toBeTypeOf('function')
      expect(executor.calls).toEqual([])
    } finally { access.dispose() }
  })

  it('installs the very same object when the service appears', () => {
    const host = fakeHost()
    const executor = fakeExecutor()
    const policy: DshSegmentPolicy = { shouldStartNewSegment: () => undefined }
    const access = createSegmentPolicyAccess(host.ctx as never, executor)
    try {
      host.provide(policy)
      host.activate()
      // Same reference, not a copy: the strategy keeps its own state.
      expect(executor.calls).toEqual([policy])
      expect(executor.calls[0]).toBe(policy)
    } finally { access.dispose() }
  })

  it('uninstalls when the memory plugin goes away, and again on dispose', () => {
    const host = fakeHost()
    const executor = fakeExecutor()
    const policy: DshSegmentPolicy = {}
    const access = createSegmentPolicyAccess(host.ctx as never, executor)
    try {
      host.provide(policy)
      host.activate()
      expect(executor.calls).toEqual([policy])
      // 记忆插件卸载 / 被禁用:端口消失,executor 回到未接线的单会话行为。
      host.remove()
      host.teardown()
      expect(executor.calls).toEqual([policy, undefined])
    } finally { access.dispose() }
    // dispose 也是卸载,不会把端口留在 executor 上。
    expect(executor.calls.at(-1)).toBeUndefined()
    expect(host.fiberDisposed).toBe(true)
  })

  it('a host without inject reads the service once instead of subscribing', () => {
    const policy: DshSegmentPolicy = {}
    const executor = fakeExecutor()
    const ctx = { get: () => policy }   // 没有 inject:老宿主只有一次性读
    const access = createSegmentPolicyAccess(ctx as never, executor)
    try {
      expect(executor.calls).toEqual([policy])
    } finally { access.dispose() }
    expect(executor.calls).toEqual([policy, undefined])
  })

  it('a throwing proxy read is treated as absent, not as a startup failure', () => {
    const executor = fakeExecutor()
    // cordis 的代理属性读在服务未提供时抛错。没有 get 的宿主会走到这条路。
    const ctx: Record<string, unknown> = {
      get: () => { throw new Error('cannot get property without inject') },
    }
    Object.defineProperty(ctx, 'companionSegmentPolicy', {
      get() { throw new Error('cannot get property "companionSegmentPolicy" without inject') },
    })
    const access = createSegmentPolicyAccess(ctx as never, executor)
    expect(executor.calls).toEqual([undefined])
    access.dispose()
  })

  it('the module-level inject list does not make the port a hard dependency', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'plugin.ts'), 'utf8')
    const declared = source.match(/export const inject = (\[[^\]]*\])/)
    expect(declared).not.toBeNull()
    // 硬依赖会与 qqBridgeEvents 形成环:端口只能经可选 fiber 取用。
    expect(declared![1]).not.toContain('companionSegmentPolicy')
    expect(JSON.parse(declared![1].replace(/'/g, '"')))
      .toEqual(['agentLoop', 'agentPresets', 'sessionQuery'])
    // 接线存在,且创建/卸载两处都在。
    expect(source.match(/createSegmentPolicyAccess\(ctx, executor\)/g)).toHaveLength(1)
    expect(source).toContain('segmentPolicyAccess.dispose()')
    // 记忆插件提供的服务名一字不差,否则永远取不到。
    expect(source).toContain("'companionSegmentPolicy'")
  })

  it('the executor really accepts the policy it is handed', async () => {
    const { DshAgentExecutor } = await import('../src/handlers/dsh-executor.js')
    const executor = new DshAgentExecutor({ async getOrCreate() {
      return { followup() {}, async whenIdle() {}, async dispose() {} }
    }, async deliver() {}, async readSurface() { return [] } } as never)
    const policy: DshSegmentPolicy = { shouldStartNewSegment: () => 'due' }
    executor.setSegmentPolicy(policy)
    // 端口装上了,但换段只在 prepareSession 里按策略决定 —— 未换段时不产生记录。
    expect(executor.lastSegmentSwitch('private:1')).toBeUndefined()
    executor.setSegmentPolicy(undefined)
  })
})
