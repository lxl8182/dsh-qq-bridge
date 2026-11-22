import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { AgyChats } from '../src/handlers/agy-chat.js'
import type { InboundImage } from '../src/onebot/images.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), rm: vi.fn() }))

afterEach(() => vi.unstubAllEnvs())

it('sends numbered images only on their turn and reuses native ACP with the selected model and effort', async () => {
  const root = join('fixtures', 'agy')
  vi.stubEnv('DSH_QQ_AGY_ROOT', root)
  vi.stubEnv('DSH_QQ_AGY_HOME', join(root, 'home'))
  vi.stubEnv('DSH_QQ_AGY_USER', 'chat-user')
  vi.stubEnv('DSH_QQ_AGY_PERSONA_DIR', join(root, 'personas'))
  vi.stubEnv('DSH_QQ_AGY_PROXY', 'http://127.0.0.1:7897')
  const persona = '我是铃芽。'
  const conversation = [{ role: 'user' as const, content: '以前说的话' }, { role: 'assistant' as const, content: '以前的回复' }]
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ current: { text: persona, tools: ['ignored'] } }))
  const output = new PassThrough()
  const sent: any[] = []
  const proc = Object.assign(new EventEmitter(), {
    stdout: output,
    kill: vi.fn(),
    stdin: new Writable({
      write(bytes, _encoding, callback) {
        const request = JSON.parse(bytes.toString())
        sent.push(request)
        let result: object = {}
        if (request.method === 'session/new') result = {
          sessionId: 'test-session',
          configOptions: [{ id: 'model', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-4-argon' }] }],
        }
        if (request.method === 'session/set_config_option') result = {
          configOptions: [{ id: 'thought_level', currentValue: 'medium', options: [{ value: 'high' }] }],
        }
        if (request.method === 'session/prompt') {
          output.write(JSON.stringify({
            method: 'session/update',
            params: { sessionId: 'test-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到' } } },
          }) + '\n')
          result = { stopReason: 'end_turn' }
        }
        output.write(JSON.stringify({ id: request.id, result }) + '\n')
        callback()
      },
    }),
  })
  vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>)

  const chat = new AgyChats('gemini-4-argon', 'high')
  const history = vi.fn(() => conversation)
  const images: InboundImage[] = [
    { sourceIndex: 2, mediaType: 'image/png', data: 'AQ==' },
    { sourceIndex: 3, mediaType: 'image/jpeg', data: 'Ag==' },
  ]
  try {
    expect(await chat.run('private:owner', history, '', true, undefined, images)).toBe('收到')
    expect(await chat.run('private:owner', history, '第二条', true)).toBe('收到')
  } finally { chat.dispose() }
  expect(history).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalledTimes(1)
  const agentDefinition = vi.mocked(writeFile).mock.calls[0]![1]
  expect(agentDefinition).toContain('\nexcludeDefaultComponents: true\ntools: []\n')
  expect(String(agentDefinition).split('\n---\n')[1]).toBe(persona)
  expect(sent.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    { method: 'session/new', params: { cwd: join(root, 'workspace'), mcpServers: [] } },
    { method: 'session/set_config_option', params: { sessionId: 'test-session', configId: 'model', value: 'gemini-4-argon' } },
    { method: 'session/set_config_option', params: { sessionId: 'test-session', configId: 'thought_level', value: 'high' } },
    { method: 'session/prompt', params: {
      sessionId: 'test-session',
      prompt: [
        { type: 'text', text: JSON.stringify([...conversation, { role: 'user', content: '' }]) },
        { type: 'text', text: '[图片2]' },
        { type: 'image', mimeType: 'image/png', data: 'AQ==' },
        { type: 'text', text: '[图片3]' },
        { type: 'image', mimeType: 'image/jpeg', data: 'Ag==' },
      ],
    } },
    { method: 'session/prompt', params: {
      sessionId: 'test-session',
      prompt: [{ type: 'text', text: JSON.stringify([{ role: 'user', content: '第二条' }]) }],
    } },
  ])
})
