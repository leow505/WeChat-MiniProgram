/**
 * HTTP surface. DESIGN.md §4 for the action contract, platform/README.md for identity.
 *
 * Two kinds of route:
 *
 *   /v1/*        the JSON API. One action endpoint mirrors the cloud function and
 *                the mini program's mock, so a client written once speaks to all
 *                three. Auth is a bearer session; the acting identity is resolved
 *                from it server-side and never read from the payload.
 *   /invite/:id  the shareable page, server-rendered so group chats can build a
 *                link preview (see invite-page.js).
 *
 * Responses are `{ ok: true, data }` or `{ ok: false, code }`. Codes, never
 * prose — one backend serves both locales and the client owns the wording.
 */

import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { z } from 'zod'

import { ACTION_NAMES, AppError, dispatch } from '../domain/index.js'
import { AuthError } from '../identity/index.js'
import { renderInvitePage } from './invite-page.js'

/** Payload guards for the auth endpoints. Action payloads are validated by the
 * domain layer, which is the same validation the cloud function applies. */
const guestSchema = z.object({
  device_id: z.string().min(16).max(100),
  nickname: z.string().max(64).optional(),
  gender: z.enum(['MALE', 'FEMALE', 'UNSPECIFIED']).optional(),
  locale: z.string().max(16).optional(),
})

const recoverySchema = z.object({
  code: z.string().min(1).max(64),
  device_id: z.string().min(16).max(100),
})

const wechatSchema = z.object({ code: z.string().min(1).max(256) })

const actionSchema = z.object({
  action: z.string().min(1).max(64),
  payload: z.record(z.unknown()).optional(),
})

function bearer(c) {
  const header = c.req.header('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

/**
 * Requests are fingerprinted for rate limiting only. Behind a proxy this needs
 * the hop-count-aware client IP; `x-forwarded-for`'s first entry is used and is
 * only as trustworthy as the proxy in front of it.
 */
function fingerprint(c) {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return c.req.header('x-real-ip') ?? 'local'
}

const fail = (c, code, status = 400) => c.json({ ok: false, code }, status)

export function createApp({ config, logger, identity, store }) {
  const app = new Hono()

  app.use('*', requestId())
  app.use(
    '*',
    secureHeaders({
      // The invite shell loads its bundle from this origin only; no inline
      // scripts, no third-party frames.
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
      xFrameOptions: 'DENY',
      referrerPolicy: 'strict-origin-when-cross-origin',
    })
  )
  app.use(
    '/v1/*',
    cors({
      origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
      allowHeaders: ['authorization', 'content-type'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 600,
    })
  )

  // One log line per request, with the id echoed back so a user-reported failure
  // can be found in the logs.
  app.use('*', async (c, next) => {
    const started = Date.now()
    await next()
    logger.info(
      {
        request_id: c.get('requestId'),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        ms: Date.now() - started,
      },
      'request'
    )
  })

  app.onError((err, c) => {
    const requestIdValue = c.get('requestId')
    if (err instanceof AuthError) {
      logger.warn({ request_id: requestIdValue, code: err.code }, 'auth rejected')
      return fail(c, err.code, err.status ?? 400)
    }
    if (err instanceof AppError) {
      // A business rule said no. Expected, and the client localizes the code.
      logger.info({ request_id: requestIdValue, code: err.code }, 'action refused')
      return fail(c, err.code, err.status ?? 400)
    }
    if (err instanceof z.ZodError) {
      logger.warn({ request_id: requestIdValue, issues: err.issues }, 'bad request')
      return fail(c, 'BAD_REQUEST', 400)
    }
    logger.error({ request_id: requestIdValue, err }, 'unhandled error')
    return fail(c, 'INTERNAL', 500)
  })

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  app.get('/health', (c) => c.json({ ok: true }))

  /** Readiness: the process is only useful if the database answers. */
  app.get('/ready', async (c) => {
    try {
      await store.ping()
      return c.json({ ok: true, database: 'up' })
    } catch (error) {
      logger.error({ err: error }, 'readiness check failed')
      return c.json({ ok: false, code: 'DATABASE_DOWN' }, 503)
    }
  })

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Guest sign-in. A browser's device key becomes its first credential; the
   * account is created on first use. The nickname is stored through the same
   * profile action every other client uses.
   */
  app.post('/v1/auth/guest', async (c) => {
    const body = guestSchema.parse(await c.req.json())
    const { token, accountId } = await identity.exchangeGuestDevice(body.device_id)
    const profile = await dispatch(
      'profile.upsert',
      {
        nickname: (body.nickname ?? '').trim().slice(0, 32),
        gender: body.gender ?? 'UNSPECIFIED',
        locale: body.locale ?? '',
      },
      accountId
    )
    return c.json({ ok: true, token, profile })
  })

  /** WeChat mini program sign-in: wx.login() code -> verified openid -> session. */
  app.post('/v1/auth/wechat', async (c) => {
    const body = wechatSchema.parse(await c.req.json())
    const { token } = await identity.exchangeWechatCode(body.code)
    return c.json({ ok: true, token })
  })

  /** Restore an account on a new browser with a recovery code. */
  app.post('/v1/auth/recovery', async (c) => {
    const body = recoverySchema.parse(await c.req.json())
    const { token, accountId } = await identity.exchangeRecoveryCode(
      body.code,
      body.device_id,
      fingerprint(c)
    )
    const profile = await dispatch('profile.get', {}, accountId)
    return c.json({ ok: true, token, profile })
  })

  /** Sign out this device. The session is revoked server-side, not just dropped. */
  app.post('/v1/auth/signout', async (c) => {
    const result = await identity.revokeSession(bearer(c))
    return c.json({ ok: true, revoked: result.revoked })
  })

  // ---------------------------------------------------------------------------
  // Authenticated routes
  // ---------------------------------------------------------------------------

  app.use('/v1/account/*', async (c, next) => {
    const actorId = await identity.verifySession(bearer(c))
    if (!actorId) return fail(c, 'NO_IDENTITY', 401)
    c.set('actorId', actorId)
    await next()
  })

  app.use('/v1/actions', async (c, next) => {
    const actorId = await identity.verifySession(bearer(c))
    if (!actorId) return fail(c, 'NO_IDENTITY', 401)
    c.set('actorId', actorId)
    await next()
  })

  /** Which credentials reach this account, and whether it can be recovered. */
  app.post('/v1/account/status', async (c) =>
    c.json({ ok: true, status: await identity.accountStatus(c.get('actorId')) })
  )

  /** Issue a recovery code. Shown once; issuing a new one revokes the old. */
  app.post('/v1/account/recovery-code', async (c) => {
    const actorId = c.get('actorId')
    const code = await identity.createRecoveryCode(actorId)
    return c.json({ ok: true, code, status: await identity.accountStatus(actorId) })
  })

  /** Sign out every device. */
  app.post('/v1/account/revoke-sessions', async (c) =>
    c.json({ ok: true, ...(await identity.revokeAllSessions(c.get('actorId'))) })
  )

  /**
   * The action endpoint. Same names and shapes as the cloud function and the
   * mock, so the WeChat client, the browser and a future bot all use one contract.
   */
  app.post('/v1/actions', async (c) => {
    const body = actionSchema.parse(await c.req.json())
    if (!ACTION_NAMES.includes(body.action)) return fail(c, 'NO_ACTION', 404)
    const data = await dispatch(body.action, body.payload ?? {}, c.get('actorId'))
    return c.json({ ok: true, data })
  })

  // ---------------------------------------------------------------------------
  // Web client
  // ---------------------------------------------------------------------------

  /**
   * The invite page. Rendered server-side with Open Graph tags so a link pasted
   * into a group chat unfurls with the session's time, place and seats left.
   *
   * The lookup is deliberately unauthenticated and narrow: only a PUBLIC session
   * contributes to the preview. A club-only session renders neutral tags rather
   * than leaking its details to anyone holding the URL.
   */
  app.get('/invite/:id', async (c) => {
    const eventId = c.req.param('id')
    let event = null
    try {
      const doc = await store.publicEventForPreview(eventId)
      if (doc) event = doc
    } catch (error) {
      logger.warn({ err: error, event_id: eventId }, 'invite preview lookup failed')
    }
    return c.html(
      renderInvitePage({
        event,
        eventId,
        baseUrl: config.PUBLIC_WEB_BASE_URL,
        assets: config.webAssetTags ?? '',
      })
    )
  })

  // Built web client, when present. `index.html` is served for client routes so
  // the SPA can handle them; unknown /v1 paths already returned above.
  if (config.webRoot) {
    app.use('/assets/*', serveStatic({ root: config.webRoot }))
    // A miss under /assets must 404, not fall through to index.html. Serving HTML
    // with a 200 for a missing bundle makes the browser reject it on MIME type,
    // which presents as a blank page rather than a missing file — exactly the
    // failure a stale deploy or a bad cache produces.
    app.all('/assets/*', (c) => fail(c, 'NOT_FOUND', 404))
    app.get('/', serveStatic({ path: 'index.html', root: config.webRoot }))
    app.get('*', serveStatic({ path: 'index.html', root: config.webRoot }))
  }

  app.notFound((c) => fail(c, 'NOT_FOUND', 404))

  return app
}
