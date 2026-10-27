import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installQqBridgeSettings, QqBridgeHostConfig } from '../src/settings.js'
import { DshQqBridgeConfig } from '../src/config.js'

describe('QQ bridge settings runtime wiring', () => {
  const previousDshHome = process.env.DSH_HOME

  afterEach(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })

  it('reads the volatile entry and refreshes after a scoped Loader update', async () => {
    const saved = DshQqBridgeConfig.parse({ enabled: false })
    const parsed = (QqBridgeHostConfig as (value: unknown) => { get(): DshQqBridgeConfig })(saved)
    expect(typeof parsed.get).toBe('function')
    expect(parsed.get().enabled).toBe(false)
    expect(Object.isFrozen(parsed.get())).toBe(true)
    let current = saved
    let refresh: (() => void) | undefined
    const applied: DshQqBridgeConfig[] = []
    const ctx = {
      on(event: string, cb: () => void) {
        expect(event).toBe('loader/volatile-update')
        refresh = cb
        return () => { refresh = undefined }
      },
    }
    const settings = await installQqBridgeSettings(ctx, { get: () => current }, next => { applied.push(next) })
    expect(applied).toHaveLength(1)
    current = DshQqBridgeConfig.parse({ enabled: true })
    refresh!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(applied[1].enabled).toBe(true)
    expect(settings.current().enabled).toBe(true)
    settings.dispose()
    expect(refresh).toBeUndefined()
  })
})
