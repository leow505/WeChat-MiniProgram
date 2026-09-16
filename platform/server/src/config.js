/**
 * Configuration, validated once at startup.
 *
 * A missing or malformed setting should stop the process immediately with a
 * readable message, not surface later as a confusing runtime failure. Secrets
 * that are optional in development are required in production, and that
 * difference is expressed here rather than scattered through the code.
 */

import { z } from 'zod'

const booleanish = (defaultValue) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? defaultValue : value === 'true'))

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(4174),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    SESSION_SECRET: z.string().min(1).optional(),
    CORS_ORIGINS: z.string().default('*'),
    PUBLIC_WEB_BASE_URL: z.string().url().default('http://127.0.0.1:4174'),
    ALLOW_DEV_AUTH: booleanish(undefined),
    WECHAT_APP_ID: z.string().optional(),
    WECHAT_APP_SECRET: z.string().optional(),
  })
  .transform((env) => {
    const isProduction = env.NODE_ENV === 'production'
    return {
      ...env,
      isProduction,
      // Dev auth ("Bearer dev:<id>") defaults on outside production and can never
      // be switched on in production.
      allowDevAuth: isProduction ? false : (env.ALLOW_DEV_AUTH ?? true),
      corsOrigins: env.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    }
  })
  .superRefine((env, ctx) => {
    if (env.isProduction && !env.SESSION_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET is required in production',
      })
    }
    if (env.isProduction && env.corsOrigins.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must list explicit origins in production, not "*"',
      })
    }
    if (env.ALLOW_DEV_AUTH === true && env.isProduction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOW_DEV_AUTH'],
        message: 'ALLOW_DEV_AUTH cannot be enabled in production',
      })
    }
  })

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid configuration:\n${details}`)
  }
  const config = result.data
  return {
    ...config,
    sessionSecret: config.SESSION_SECRET ?? 'local-development-secret-change-me',
  }
}
