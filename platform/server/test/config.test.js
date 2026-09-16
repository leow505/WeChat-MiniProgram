/**
 * Configuration guards.
 *
 * These are the settings that are merely inconvenient to get wrong in
 * development and dangerous to get wrong in production: a default signing
 * secret, a wildcard CORS origin, the dev-auth bypass. The process should refuse
 * to start rather than come up insecure, so each of those refusals is pinned
 * here.
 */

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'

const base = {
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/db',
}

describe('development defaults', () => {
  it('fills in workable defaults', () => {
    const config = loadConfig(base)
    expect(config.NODE_ENV).toBe('development')
    expect(config.PORT).toBe(4174)
    expect(config.isProduction).toBe(false)
    expect(config.allowDevAuth).toBe(true)
    expect(config.corsOrigins).toEqual(['*'])
  })

  it('requires a database url', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
  })

  it('rejects a port that is not a port', () => {
    expect(() => loadConfig({ ...base, PORT: '99999' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, PORT: 'http' })).toThrow(/PORT/)
  })

  it('parses a comma-separated origin list', () => {
    const config = loadConfig({
      ...base,
      CORS_ORIGINS: 'https://a.example, https://b.example',
    })
    expect(config.corsOrigins).toEqual(['https://a.example', 'https://b.example'])
  })

  it('allows dev auth to be switched off explicitly', () => {
    expect(loadConfig({ ...base, ALLOW_DEV_AUTH: 'false' }).allowDevAuth).toBe(false)
  })
})

describe('production guards', () => {
  const production = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://play.example' }

  it('refuses to start without a session secret', () => {
    expect(() => loadConfig(production)).toThrow(/SESSION_SECRET is required in production/)
  })

  it('starts when the secret is supplied', () => {
    const config = loadConfig({ ...production, SESSION_SECRET: 'a-real-secret' })
    expect(config.isProduction).toBe(true)
    expect(config.sessionSecret).toBe('a-real-secret')
  })

  it('refuses a wildcard CORS origin', () => {
    expect(() => loadConfig({ ...production, SESSION_SECRET: 's', CORS_ORIGINS: '*' })).toThrow(
      /explicit origins in production/
    )
  })

  it('refuses to enable the dev-auth bypass', () => {
    expect(() =>
      loadConfig({ ...production, SESSION_SECRET: 's', ALLOW_DEV_AUTH: 'true' })
    ).toThrow(/cannot be enabled in production/)
  })

  it('keeps dev auth off even when the variable is absent', () => {
    const config = loadConfig({ ...production, SESSION_SECRET: 's' })
    expect(config.allowDevAuth).toBe(false)
  })

  it('never falls back to the development secret in production', () => {
    // The development default is a known string; shipping it would make every
    // deployment's sessions forgeable.
    const config = loadConfig({ ...production, SESSION_SECRET: 'proper-secret' })
    expect(config.sessionSecret).not.toContain('local-development')
  })
})
