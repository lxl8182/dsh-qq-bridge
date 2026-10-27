import { describe, expect, it, vi } from 'vitest'
import {
  buildUserContent,
  collectInboundImages,
  fetchInboundImage,
  imageSourcesFromOfficialAttachments,
  imageSourcesFromOnebotSegments,
  normalizeImageType,
} from '../src/onebot/images.js'

/** 1x1 透明 PNG。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function pngResponse(bytes = Buffer.from(PNG_BASE64, 'base64'), type = 'image/png'): typeof fetch {
  return (async () => new Response(bytes, { status: 200, headers: { 'content-type': type } })) as unknown as typeof fetch
}

describe('inbound image sources', () => {
  it('reads image segments from OneBot message arrays', () => {
    const sources = imageSourcesFromOnebotSegments([
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { url: 'https://cdn.example/a.png', summary: '[图片]' } },
      { type: 'image', data: { file: 'https://cdn.example/b.jpg' } },
      { type: 'image', data: { file: 'c.dat' } },
    ])

    expect(sources).toHaveLength(2)
    expect(sources[0]).toMatchObject({ url: 'https://cdn.example/a.png', name: '[图片]' })
    expect(sources[1]).toMatchObject({ url: 'https://cdn.example/b.jpg' })
  })

  it('ignores non-image and malformed segments', () => {
    expect(imageSourcesFromOnebotSegments(undefined)).toEqual([])
    expect(imageSourcesFromOnebotSegments([{ type: 'at' }, null, 'x'])).toEqual([])
    expect(imageSourcesFromOnebotSegments([{ type: 'image', data: {} }])).toEqual([])
  })

  it('reads only image attachments from the official bot', () => {
    const sources = imageSourcesFromOfficialAttachments([
      { content_type: 'image/jpeg', url: 'https://cdn.example/x.jpg', filename: 'x.jpg' },
      { content_type: 'file', url: 'https://cdn.example/doc.pdf' },
      { content_type: 'image/png', url: '' },
    ])

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ url: 'https://cdn.example/x.jpg', mediaType: 'image/jpeg', name: 'x.jpg' })
  })

  it('normalizes declared types and falls back to the extension', () => {
    expect(normalizeImageType('image/png; charset=binary', 'https://x/y')).toBe('image/png')
    expect(normalizeImageType(undefined, 'https://x/y.webp?token=1')).toBe('image/webp')
    expect(normalizeImageType('application/pdf', 'https://x/y')).toBeUndefined()
  })
})

describe('fetchInboundImage', () => {
  it('downloads and base64-encodes a supported image', async () => {
    const result = await fetchInboundImage(
      { url: 'https://cdn.example/a.png', name: 'a.png' },
      { fetchImpl: pngResponse() },
    )

    expect('image' in result).toBe(true)
    if ('image' in result) {
      expect(result.image.mediaType).toBe('image/png')
      expect(result.image.name).toBe('a.png')
      expect(Buffer.from(result.image.data, 'base64').byteLength).toBeGreaterThan(0)
    }
  })

  it('rejects non-image content instead of guessing by bytes', async () => {
    const result = await fetchInboundImage(
      { url: 'https://cdn.example/a.bin' },
      { fetchImpl: (async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch },
    )

    expect(result).toEqual({ skipped: expect.stringContaining('unsupported type') })
  })

  it('rejects oversized images without truncating them', async () => {
    const result = await fetchInboundImage(
      { url: 'https://cdn.example/big.png' },
      { fetchImpl: pngResponse(), maxBytes: 8 },
    )

    expect(result).toEqual({ skipped: expect.stringContaining('too large') })
  })

  it('reports http failures as skips, not throws', async () => {
    const result = await fetchInboundImage(
      { url: 'https://cdn.example/404.png' },
      { fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch },
    )

    expect(result).toEqual({ skipped: 'http 404' })
  })

  it('reports transport failures as skips', async () => {
    const result = await fetchInboundImage(
      { url: 'https://cdn.example/x.png' },
      { fetchImpl: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch },
    )

    expect(result).toEqual({ skipped: expect.stringContaining('download failed') })
  })
})

describe('collectInboundImages', () => {
  it('keeps the good images when one of them fails', async () => {
    let call = 0
    const fetchImpl = (async (input: string) => {
      call += 1
      if (String(input).includes('bad')) return new Response('', { status: 500 })
      return new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch

    const result = await collectInboundImages(
      [{ url: 'https://cdn.example/good.png' }, { url: 'https://cdn.example/bad.png' }],
      { fetchImpl },
    )

    expect(call).toBe(2)
    expect(result.images).toHaveLength(1)
    expect(result.skipped).toEqual(['http 500'])
  })

  it('enforces the per-message image limit', async () => {
    const result = await collectInboundImages(
      [{ url: 'https://a/1.png' }, { url: 'https://a/2.png' }, { url: 'https://a/3.png' }],
      { fetchImpl: pngResponse(), maxImages: 2 },
    )

    expect(result.images).toHaveLength(2)
    expect(result.skipped).toHaveLength(1)
  })
})

describe('buildUserContent', () => {
  it('puts text first and images after', () => {
    const blocks = buildUserContent('看这个', [
      { mediaType: 'image/png', data: PNG_BASE64, name: 'a.png' },
    ])

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: '看这个' })
    expect(blocks[1]).toMatchObject({ type: 'image', mediaType: 'image/png', name: 'a.png' })
  })

  it('supports image-only messages', () => {
    const blocks = buildUserContent('', [{ mediaType: 'image/png', data: PNG_BASE64 }])

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'image' })
  })
})
