import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRpcHandler } from '../src/handlers/agent.js'
import { QqControlDispatcher } from '../src/handlers/control.js'

it('agy receives the correct private transcript and skips DSH preparation for both owner and friend', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'qq-agy-test-'))
  const run = vi.fn(async () => '好友回复')
  const prepareTurn = vi.fn(async () => {})
  const transcripts: unknown[] = []
  const agy = {
    run: vi.fn(async (key, history, message, owner) => {
      transcripts.push([key, history(), message, owner])
      return '测试回复'
    }),
    reset: vi.fn(),
    dispose: vi.fn(),
  }
  const send = vi.fn(async () => ({}))
  const handler = new AgentRpcHandler({ run }, {
    agy, prepareTurn, ackMessage: '', deliveryStatePath: join(temp, 'delivery.json'),
    controlDispatcher: new QqControlDispatcher(),
  })
  const ctx = { scope: 'private' as const, userId: 'owner', owner: true, messageId: 'a', payload: '第一轮',
    respond: async () => {}, send }
  try {
    await handler.open()
    await handler.run(ctx)
    await handler.run({ ...ctx, owner: false, userId: 'friend', messageId: 'b', payload: '好友消息' })
    await handler.run({ ...ctx, messageId: 'c', payload: '第二轮' })
    expect(transcripts).toEqual([
      ['private:owner', [], '第一轮', true],
      ['private:friend', [], '好友消息', false],
      ['private:owner', [{ role: 'user', content: '第一轮' }, { role: 'assistant', content: '测试回复' }], '第二轮', true],
    ])
    expect(agy.reset).not.toHaveBeenCalled()
    await handler.run({
      ...ctx, messageId: 'd', payload: '投递失败测试',
      send: async () => { throw new Error('测试投递失败') },
    })
    expect(agy.reset).toHaveBeenCalledWith('private:owner')
    expect(prepareTurn).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(send.mock.calls).toEqual([['测试回复'], ['测试回复'], ['测试回复']])
  } finally {
    await handler.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})


it('downloads private QQ images for agy and reports missing images by their original number', async () => {
  const agy = {
    run: vi.fn(async () => '收到'),
    reset: vi.fn(),
    dispose: vi.fn(),
  }
  const prepareImages = vi.fn()
  const handler = new AgentRpcHandler({ run: vi.fn(), prepareImages }, {
    agy, ackMessage: '',
    fetchImpl: vi.fn(async url => {
      return String(url).endsWith('ok.png')
        ? new Response(Uint8Array.of(1), { headers: { 'content-type': 'image/png' } })
        : new Response(null, { status: 404 })
    }),
  })
  const respond = vi.fn(async () => {})
  try {
    await handler.run({
      scope: 'private', userId: 'friend', owner: false, messageId: 'images',
      payload: '[图片1][图片2]', respond,
      images: [
        { sourceIndex: 1, url: 'https://example.test/missing.png' },
        { sourceIndex: 2, url: 'https://example.test/ok.png' },
      ],
    })
    expect(agy.run).toHaveBeenCalledTimes(1)
    expect(agy.run).toHaveBeenCalledWith(
      'private:friend', expect.any(Function), '[图片1未能读取][图片2]', false, undefined,
      [{ sourceIndex: 2, mediaType: 'image/png', data: 'AQ==' }],
    )
    expect(respond).toHaveBeenCalledWith('收到')
    expect(prepareImages).not.toHaveBeenCalled()
  } finally {
    await handler.dispose()
  }
})
