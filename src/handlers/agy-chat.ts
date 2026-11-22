import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { InboundImage } from '../onebot/images.js'

const idleMs = 15 * 60_000
const effortSuffix = /-(low|medium|high|xhigh|max)$/u

export type ChatLine = { role: 'user' | 'assistant'; content: string }
type PromptBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
type Choice = { name?: string; value?: string; options?: Choice[] }
type Option = { id: string; category?: string; currentValue?: string; options?: Choice[] }
type Session = {
  sessionId: string
  configOptions?: Option[]
  models?: { availableModels: { modelId: string; name: string }[] }
}

interface Packet {
  id?: number | string
  method?: string
  error?: { message?: string }
  result?: unknown
  params?: {
    sessionId?: string
    update?: { sessionUpdate: string; content?: { type: string; text?: string } }
  }
}

function agyRuntime() {
  const root = process.env.DSH_QQ_AGY_ROOT
  const home = process.env.DSH_QQ_AGY_HOME
  const user = process.env.DSH_QQ_AGY_USER
  const personaDir = process.env.DSH_QQ_AGY_PERSONA_DIR
  if (!root || !home || !user || !personaDir) {
    throw new Error('请在 DSH 服务环境配置 DSH_QQ_AGY_ROOT、DSH_QQ_AGY_HOME、DSH_QQ_AGY_USER 和 DSH_QQ_AGY_PERSONA_DIR。')
  }
  return { root, home, user, personaDir, proxy: process.env.DSH_QQ_AGY_PROXY }
}

async function readPersona(personaDir: string, owner: boolean): Promise<string> {
  const path = join(personaDir, owner ? 'persona_versions.json' : 'qq_public_persona.json')
  const data = JSON.parse(await readFile(path, 'utf8')) as { current?: { text?: string }; text?: string }
  const persona = owner ? data.current?.text : data.text
  if (!persona?.trim()) throw new Error('DSH 当前没有这个聊天可用的人格文本。')
  return persona
}

async function writePersona(workspace: string, persona: string): Promise<void> {
  const agent = [
    '---', 'name: qq-chat', 'description: QQ chat', 'mainAgent: true', 'subagent: false',
    'excludeDefaultComponents: true', 'tools: []', 'commandExecutionPolicy: off',
    'inheritMcp: false', 'inheritCustomizations: false', '---', persona,
  ].join('\n')
  const path = join(workspace, '.agents', 'agents', 'qq-chat.md')
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, agent, { mode: 0o644 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function choices(option?: Option): Choice[] {
  return (option?.options ?? []).flatMap(entry => entry.options ?? [entry])
}

function modelOption(session: Session): Option | undefined {
  return session.configOptions?.find(entry => entry.category === 'model' || entry.id === 'model')
}

class AcpProcess {
  private readonly child
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private requestId = 0
  private collecting?: { sessionId: string; text: string }
  closed = false

  constructor(private readonly workspace: string, runtime: ReturnType<typeof agyRuntime>) {
    const proxyEnv = runtime.proxy ? ['HTTPS_PROXY=' + runtime.proxy, 'HTTP_PROXY=' + runtime.proxy] : []
    this.child = spawn('runuser', ['-u', runtime.user, '--', '/usr/bin/env', '-i',
      'HOME=' + runtime.home, 'PATH=/usr/bin:/bin', ...proxyEnv,
      'AGY_CLI_DISABLE_AUTO_UPDATE=true', join(runtime.root, 'bin', 'agy'),
      'acp', '--agent', 'qq-chat', '--sandbox', '--include-default-customizations=false', '--disable-telemetry',
    ], { cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'] })
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line))
    this.child.on('error', error => this.close(error))
    this.child.stdin.on('error', error => this.close(error))
    this.child.on('close', code => this.close(new Error('agy ACP 已退出（' + code + '）。')))
  }

  close(error = new Error('agy ACP 会话已关闭。')): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
    this.child.stdin.end()
    const stop = setTimeout(() => this.child.kill(), 1000)
    stop.unref()
  }

  private send(packet: object): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n')
  }

  private receive(line: string): void {
    if (this.closed) return
    let packet: Packet
    try { packet = JSON.parse(line) as Packet }
    catch { this.close(new Error('agy ACP 返回了无效的数据。')); return }
    if (packet.method && packet.id !== undefined) {
      this.send(packet.method === 'session/request_permission'
        ? { id: packet.id, result: { outcome: { outcome: 'cancelled' } } }
        : { id: packet.id, error: { code: -32601, message: 'Unsupported client method' } })
      this.close(new Error('agy 请求了工具权限或客户端操作，已结束本轮。'))
      return
    }
    const state = this.collecting
    const update = packet.params?.update
    if (state && packet.method === 'session/update' && packet.params?.sessionId === state.sessionId) {
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        this.close(new Error('agy 尝试使用工具，已结束本轮。'))
        return
      }
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        state.text += update.content.text ?? ''
      }
    }
    if (typeof packet.id !== 'number') return
    const entry = this.pending.get(packet.id)
    if (!entry) return
    this.pending.delete(packet.id)
    if (packet.error) entry.reject(new Error(packet.error.message ?? 'agy ACP error'))
    else entry.resolve(packet.result)
  }

  private async call<T>(method: string, params: object, timeoutMs = 30_000): Promise<T> {
    if (this.closed) throw new Error('agy ACP 会话已关闭。')
    const timer = setTimeout(() => this.close(new Error('agy ACP 请求超时。')), timeoutMs)
    try {
      return await new Promise<T>((accept, reject) => {
        const id = ++this.requestId
        this.pending.set(id, { resolve: value => accept(value as T), reject })
        this.send({ id, method, params })
      })
    } finally { clearTimeout(timer) }
  }

  async open(): Promise<Session> {
    await this.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    return this.call('session/new', { cwd: this.workspace, mcpServers: [] })
  }

  async select(session: Session, model: string, effort: string): Promise<void> {
    const sessionId = session.sessionId
    const option = modelOption(session)
    if (!option) {
      const variants = (session.models?.availableModels ?? []).filter(entry =>
        entry.modelId.replace(effortSuffix, '') === model)
      const variant = effort
        ? variants.find(entry => entry.modelId === model + '-' + effort)
        : variants.find(entry => entry.modelId === model + '-medium') ?? variants[0]
      if (!variant) throw new Error('agy 账号不提供所选模型或思考强度。')
      await this.call('session/set_model', { sessionId, modelId: variant.modelId })
      return
    }
    if (!choices(option).some(entry => entry.value === model)) throw new Error('agy 账号不提供模型 ' + model + '。')
    let config = session.configOptions
    if (option.currentValue !== model) {
      const response = await this.call<{ configOptions: Option[] }>('session/set_config_option', { sessionId, configId: option.id, value: model })
      config = response.configOptions
    }
    if (!effort) return
    const thought = config?.find(entry => entry.id === 'thought_level' || entry.category === 'thought_level')
    if (!thought || !choices(thought).some(entry => entry.value === effort)) {
      throw new Error('agy 账号不提供 ' + model + ' 的 ' + effort + ' 思考强度。')
    }
    if (thought.currentValue !== effort) {
      await this.call('session/set_config_option', { sessionId, configId: thought.id, value: effort })
    }
  }

  async prompt(sessionId: string, messages: readonly ChatLine[], images: readonly InboundImage[], timeoutMs: number): Promise<string> {
    const prompt: PromptBlock[] = [{ type: 'text', text: JSON.stringify(messages) }]
    for (const image of images) {
      if (image.sourceIndex !== undefined) {
        prompt.push({ type: 'text', text: '[图片' + image.sourceIndex + ']' })
      }
      prompt.push({ type: 'image', mimeType: image.mediaType, data: image.data })
    }
    const state = { sessionId, text: '' }
    this.collecting = state
    try {
      const result = await this.call<{ stopReason: string }>('session/prompt', {
        sessionId, prompt,
      }, timeoutMs)
      const reply = state.text.trim()
      if (reply === '⚠ Verification Required') throw new Error('Google 要求验证 Antigravity 账号。')
      if (!reply || result.stopReason === 'cancelled') throw new Error('agy 本轮没有返回完整文字。')
      return reply
    } finally { this.collecting = undefined }
  }
}

type ActiveChat = { peer: AcpProcess; sessionId?: string; persona: string; owner: boolean; idle?: NodeJS.Timeout }

export class AgyChats {
  private readonly chats = new Map<string, ActiveChat>()
  private stopped = false

  constructor(private readonly model: string, private readonly effort: string) {}

  async run(
    key: string, history: () => readonly ChatLine[], input: string, owner: boolean,
    timeoutMs = 90_000, images: readonly InboundImage[] = [],
  ): Promise<string> {
    if (!input.trim() && images.length === 0) throw new Error('agy 这条消息需要有文字或图片。')
    const runtime = agyRuntime()
    const persona = await readPersona(runtime.personaDir, owner)
    if (this.stopped) throw new Error('agy 聊天后端已关闭。')
    let chat = this.chats.get(key)
    if (chat && (chat.peer.closed || chat.persona !== persona || chat.owner !== owner)) {
      this.reset(key)
      chat = undefined
    }
    const reused = chat !== undefined
    try {
      if (!chat) {
        const workspace = join(runtime.root, owner ? 'workspace' : 'public-workspace')
        await writePersona(workspace, persona)
        if (this.stopped) throw new Error('agy 聊天后端已关闭。')
        chat = { peer: new AcpProcess(workspace, runtime), persona, owner }
        this.chats.set(key, chat)
        const session = await chat.peer.open()
        await chat.peer.select(session, this.model, this.effort)
        chat.sessionId = session.sessionId
      }
      clearTimeout(chat.idle)
      const current: ChatLine = { role: 'user', content: input }
      const reply = await chat.peer.prompt(chat.sessionId!, reused ? [current] : [...history(), current], images, timeoutMs)
      chat.idle = setTimeout(() => this.reset(key), idleMs)
      chat.idle.unref()
      console.info('[dsh-qq-bridge] agy reply completed with ' + this.model + (reused ? ' (reused ACP session)' : ' (new ACP session)'))
      return reply
    } catch (error) {
      this.reset(key)
      throw error
    }
  }

  reset(key: string): void {
    const chat = this.chats.get(key)
    if (!chat) return
    this.chats.delete(key)
    clearTimeout(chat.idle)
    chat.peer.close()
  }

  dispose(): void {
    this.stopped = true
    for (const key of this.chats.keys()) this.reset(key)
  }
}
