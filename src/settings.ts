import { inspectNapcatTag } from './napcat-tags.js'
import Schema from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DshQqBridgeConfig } from './config.js'
import { removeInsertItem, writeProfilePatchWithBackup } from './cli/dsh-profile.js'
import { installQqBridgePreset } from './cli/qq-preset.js'
import { inspectNapcatSettings, setupNapcatForSettings } from './napcat-status.js'
import { getNapcatRecoveryStatus } from './napcat-recovery.js'

export const QQ_BRIDGE_SETTINGS_NAMESPACE = 'dsh-qq-bridge'
export const QQ_BRIDGE_NAPCAT_RPC_CHANNEL = '/dsh-qq-bridge-napcat'

export interface BridgeConfigRef {
  get(): unknown
}

interface SettingsProvider {
  configure(options: { auto: boolean }, owner?: unknown): () => void
}

interface RpcConnection {
  rpc?: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown) => unknown | Promise<unknown>,
      options?: { authority?: 'loopback' | 'trusted-host' },
    ): { dispose(): void } | (() => void) | void
  }
}

export interface QqBridgeSettingsCtx {
  fiber?: unknown
  on?(event: string, callback: () => void): () => void
  inject?(
    services: readonly string[],
    cb: (ctx: QqBridgeSettingsCtx & { settings?: SettingsProvider }) => void,
    label?: string,
  ): { dispose(): void } | void
  settings?: SettingsProvider
  connection?: RpcConnection
  effect?(cb: () => void | (() => void), label?: string): void
}

export interface InstalledQqBridgeSettings {
  current(): DshQqBridgeConfig
  dispose(): void
}

type SchemasteryFactory = {
  object(shape: Record<string, unknown>): unknown
  string(): SchemaBuilder
  number(): SchemaBuilder
  boolean(): SchemaBuilder
  array(inner: unknown): SchemaBuilder
  union(values: readonly unknown[]): SchemaBuilder
}

type SchemaBuilder = {
  default(value: unknown): SchemaBuilder
  role?(name: string): SchemaBuilder
  min?(value: number): SchemaBuilder
  max?(value: number): SchemaBuilder
  step?(value: number): SchemaBuilder
  optional?(): SchemaBuilder
}

export const QqBridgeHostConfig = (await buildQqBridgeSettingsSchema() as { volatile(): unknown }).volatile()

export function readBridgeConfig(value: DshQqBridgeConfig | BridgeConfigRef): DshQqBridgeConfig {
  return DshQqBridgeConfig.parse('get' in value ? value.get() : value)
}

export async function installQqBridgeSettings(
  ctx: QqBridgeSettingsCtx,
  entry: DshQqBridgeConfig | BridgeConfigRef,
  onChange?: (next: DshQqBridgeConfig) => void | Promise<void>,
): Promise<InstalledQqBridgeSettings> {
  let current = readBridgeConfig(entry)
  const disposers: Array<() => void> = []
  let tail = Promise.resolve()
  const refresh = () => {
    const next = readBridgeConfig(entry)
    tail = tail.then(async () => {
      await onChange?.(next)
      current = next
    }).catch((error) => {
      console.error(`[dsh-qq-bridge] configuration activation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return tail
  }
  await onChange?.(current)
  const off = ctx.on?.('loader/volatile-update', () => { void refresh() })
  if (off) disposers.push(off)
  const rpcFiber = ctx.inject?.(['connection'], (child) => {
    const disposable = registerNapcatStatusRpc(child.connection ?? {})
    if (disposable) child.effect?.(() => disposable, 'dsh-qq-bridge.napcat-rpc')
  }, 'dsh-qq-bridge.napcat-rpc')
  if (rpcFiber) disposers.push(() => rpcFiber.dispose())
  const settingsFiber = ctx.inject?.(['settings'], (child) => {
    if (child.settings) child.effect?.(
      () => child.settings!.configure({ auto: false }, ctx.fiber),
      'dsh-qq-bridge.settings-page',
    )
  }, 'dsh-qq-bridge.settings-page')
  if (settingsFiber) disposers.push(() => settingsFiber.dispose())
  return {
    current: () => current,
    dispose() { for (const dispose of disposers.splice(0)) dispose() },
  }
}

function registerNapcatStatusRpc(connection: RpcConnection): (() => void) | undefined {
  if (connection.rpc?.handle === undefined) return undefined
  const disposable = connection.rpc.handle(QQ_BRIDGE_NAPCAT_RPC_CHANNEL, createNapcatStatusHandler(), { authority: 'loopback' })
  if (typeof disposable === 'function') return disposable
  if (disposable && typeof disposable === 'object' && typeof disposable.dispose === 'function') return () => disposable.dispose()
  return undefined
}

function createNapcatStatusHandler(): (endpoint: string, payload: unknown) => Promise<unknown> {
  return async (endpoint, payload) => {
    try {
      if (endpoint === 'recovery') return success(getNapcatRecoveryStatus(Number(object(payload).adminQq)) ?? null)
      if (endpoint === 'tag') return success(await inspectNapcatTag(String(object(payload).stage), object(payload)))
      if (endpoint === 'status') {
        const status = await inspectNapcatSettings(object(payload))
        const recovery = getNapcatRecoveryStatus(Number(object(payload).adminQq))
        if (recovery && recovery.state !== 'watching') {
          status.login = recovery.state === 'online' && status.runtime === 'running' && status.login === 'logged-in'
            ? 'logged-in' : 'not-logged-in'
        }
        return success({ ...status, recovery })
      }
      if (endpoint === 'setup') {
        return success(await setupNapcatForSettings(object(payload)))
      }
      if (endpoint === 'host-info') return success({ homeDir: homedir() })
      return badRequest(`unknown NapCat endpoint: ${endpoint}`)
    } catch (err) {
      return failure(err)
    }
  }
}

function success(value: unknown): { ok: true; value: unknown } {
  return { ok: true, value }
}

function failure(error: unknown): { ok: false; error: { code: string; message: string; details: Record<string, never> } } {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function badRequest(message: string): { ok: false; error: { code: string; message: string; details: { issues: unknown[] } } } {
  return {
    ok: false,
    error: {
      code: 'bad-request',
      message,
      details: { issues: [] },
    },
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

async function buildQqBridgeSettingsSchema(): Promise<unknown | undefined> {
  const z = await loadSchemastery()
  if (z === undefined) return undefined
  const secret = (field: SchemaBuilder): SchemaBuilder => field.role ? field.role('secret') : field
  return z.object({
    enabled: z.boolean().default(false),
    platform: z.union(['napcat', 'official']).default('napcat'),
    napcat: z.object({
      loginQq: z.number().step?.(1).default(0) ?? z.number().default(0),
      autoRestart: z.boolean().default(true),
      wsUrl: z.string().default('ws://127.0.0.1:3001'),
      token: secret(z.string().default('')),
      guideDoc: z.string().default('docs/agent-napcat-guide.md'),

    }),
    official: z.object({
      appId: z.string().default(''),
      appSecret: secret(z.string().default('')),
      adminOpenId: z.string().default(''),
      allowlistOpenIds: z.array(z.string()).default([]),
      sandbox: z.boolean().default(false),
    }),
    access: z.object({
      adminQq: z.number().step?.(1).default(0) ?? z.number().default(0),
      allowlist: z.array(z.number()).default([]),
      groupAllowlist: z.array(z.union([z.number(), z.string()])).default([]),
      commandPrefix: z.string().default(''),
      mode: z.union(['whitelist', 'open']).default('whitelist'),
    }),
    agent: z.object({
      preset: z.string().default('dsh-qq-bridge'),
      provider: z.string().default('deepseek-official'),
      model: z.string().default('deepseek-v4-flash'),
      // 默认思考强度。空 = 沿用适配器行为;裸 openai-completions provider 不传就
      // 完全不思考,需显式给一个值(如 high)。
      reasoningEffort: (z.string() ?? z.string()).default(''),
      models: z.array(z.string()).default([]),
      cwd: z.string().default('~'),
      maxMessageLength: z.number().step?.(1).min?.(1).default(4500) ?? z.number().default(4500),
      ackMessage: z.string().default('收到，正在处理...'),
      timeoutMs: (z.number().step?.(1).min?.(1) ?? z.number()).optional?.() ?? z.number(),
      timeoutMessage: z.string().default('agent 无响应，请稍后重试。'),
      // 旧配置项:保留 schema 让已有 settings 继续解析,但不再注入任何 prompt。
      qqReplyStyleSkill: z.object({
        enabled: z.boolean().default(true),
        skillName: z.string().default('qq-session-reply-style'),
      }),
    }),
    shell: z.object({
      enabled: z.boolean().default(false),
    }),
    notifications: z.object({
      agentReply: z.object({
        enabled: z.boolean().default(true),
      }),
    }),
    selfLogInput: z.object({
      enabled: z.boolean().default(false),
      logPath: z.string().default(''),
      pollIntervalMs: z.number().step?.(1).min?.(1).default(1000) ?? z.number().default(1000),
      replayOnStart: z.boolean().default(false),
    }),
  })
}

async function loadSchemastery(): Promise<SchemasteryFactory | undefined> {
  return Schema as unknown as SchemasteryFactory
}

async function installBundledPreset(): Promise<void> {
  await installQqBridgePreset(resolveDshHome())
}

export async function cleanupLegacyProfileInsert(dshHome = resolveDshHome()): Promise<boolean> {
  const profilePath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const previous = await readFile(profilePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined
    throw err
  })
  if (previous === undefined) return false

  const update = removeInsertItem(previous, QQ_BRIDGE_SETTINGS_NAMESPACE)
  if (!update.changed) return false

  const backupPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml.dsh-qq-bridge.bak')
  await writeProfilePatchWithBackup(profilePath, update.content, backupPath)
  return true
}

function resolveDshHome(): string {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : `${homedir()}/.dsh`
}
