import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { loadEnv } = require('./env.cjs') as {
  loadEnv: (options: Record<string, any>) => { clientId: string; clientSecret: string; publicOrigin: string | null }
}

const noopLoad = () => {}

describe('loadEnv', () => {
  it('returns the client credentials and origin', () => {
    const result = loadEnv({
      env: {
        OPENFIT_GOOGLE_CLIENT_ID: 'id-1',
        OPENFIT_GOOGLE_CLIENT_SECRET: 'secret-1',
        OPENFIT_PUBLIC_ORIGIN: 'https://box.ts.net',
      },
      loadEnvFile: noopLoad,
    })

    expect(result).toEqual({ clientId: 'id-1', clientSecret: 'secret-1', publicOrigin: 'https://box.ts.net' })
  })

  it('treats a missing public origin as null', () => {
    const result = loadEnv({
      env: { OPENFIT_GOOGLE_CLIENT_ID: 'id-1', OPENFIT_GOOGLE_CLIENT_SECRET: 'secret-1' },
      loadEnvFile: noopLoad,
    })

    expect(result.publicOrigin).toBeNull()
  })

  it('names the missing variable', () => {
    expect(() => loadEnv({ env: { OPENFIT_GOOGLE_CLIENT_ID: 'id-1' }, loadEnvFile: noopLoad }))
      .toThrow(/OPENFIT_GOOGLE_CLIENT_SECRET/)
    expect(() => loadEnv({ env: {}, loadEnvFile: noopLoad }))
      .toThrow(/OPENFIT_GOOGLE_CLIENT_ID/)
  })

  it('ignores a missing .env file but propagates other read errors', () => {
    const missing = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) }
    expect(() => loadEnv({
      env: { OPENFIT_GOOGLE_CLIENT_ID: 'a', OPENFIT_GOOGLE_CLIENT_SECRET: 'b' },
      loadEnvFile: missing,
    })).not.toThrow()

    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    expect(() => loadEnv({ env: {}, loadEnvFile: denied })).toThrow(/denied/)
  })

  it('trims surrounding whitespace', () => {
    const result = loadEnv({
      env: { OPENFIT_GOOGLE_CLIENT_ID: '  id-1  ', OPENFIT_GOOGLE_CLIENT_SECRET: ' secret-1 ' },
      loadEnvFile: noopLoad,
    })
    expect(result.clientId).toBe('id-1')
  })
})
