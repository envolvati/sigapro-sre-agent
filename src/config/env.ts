import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  PORT: z.coerce.number().default(3030),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // OmniRoute AI Gateway
  AI_GATEWAY_URL: z.string().url().default('https://ai.sigapro.com/v1'),
  AI_GATEWAY_KEY: z.string().min(1, 'AI_GATEWAY_KEY is required'),
  AI_MODEL: z.string().default('auto/fast'),

  // Observability APIs (Tempo, Prometheus, Loki)
  PROMETHEUS_URL: z.string().url().default('http://prometheus:9090'),
  TEMPO_URL: z.string().url().default('http://tempo:3200'),
  LOKI_URL: z.string().url().default('http://loki:3100'),

  // Monitored Applications URLs
  PAYMENTS_GATEWAY_URL: z.string().url().default('https://hml-payments.envolvati.com'),
  SIGAPRO_API_URL: z.string().url().default('https://api.sigapro.com'),
  SIGAPRO_APP_URL: z.string().url().default('https://sigapro.com'),

  // Telegram Notifications
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_ID: z.string().min(1, 'TELEGRAM_CHAT_ID is required'),
  TELEGRAM_THREAD_ID: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

export const env = envSchema.parse({
  PORT: process.env.PORT,
  NODE_ENV: process.env.NODE_ENV,
  AI_GATEWAY_URL: process.env.AI_GATEWAY_URL,
  AI_GATEWAY_KEY: process.env.AI_GATEWAY_KEY,
  AI_MODEL: process.env.AI_MODEL,
  PROMETHEUS_URL: process.env.PROMETHEUS_URL,
  TEMPO_URL: process.env.TEMPO_URL,
  LOKI_URL: process.env.LOKI_URL,
  PAYMENTS_GATEWAY_URL: process.env.PAYMENTS_GATEWAY_URL,
  SIGAPRO_API_URL: process.env.SIGAPRO_API_URL,
  SIGAPRO_APP_URL: process.env.SIGAPRO_APP_URL,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_THREAD_ID: process.env.TELEGRAM_THREAD_ID,
})
