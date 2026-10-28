import { env } from '../config/env.js'

export interface ServiceHealth {
  status: 'UP' | 'DOWN'
  url: string
  latencyMs?: number
  error?: string
}

export interface HealthCheckReport {
  status: 'UP' | 'DEGRADED' | 'DOWN'
  timestamp: string
  monitors: {
    prometheus: ServiceHealth
    tempo: ServiceHealth
    loki: ServiceHealth
    aiGateway: ServiceHealth
  }
}

async function pingUrl(url: string, headers: Record<string, string> = {}): Promise<ServiceHealth> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const res = await fetch(url, {
      signal: controller.signal,
      headers,
    })
    clearTimeout(timeout)
    const latencyMs = Date.now() - start

    if (res.ok || res.status === 200 || res.status === 204) {
      return { status: 'UP', url, latencyMs }
    }
    return {
      status: 'DOWN',
      url,
      latencyMs,
      error: `HTTP ${res.status}: ${res.statusText}`,
    }
  } catch (err: unknown) {
    const latencyMs = Date.now() - start
    const error = err instanceof Error ? err.message : String(err)
    return { status: 'DOWN', url, latencyMs, error }
  }
}

export async function checkMonitorsHealth(): Promise<HealthCheckReport> {
  const [prometheus, tempo, loki, aiGateway] = await Promise.all([
    pingUrl(`${env.PROMETHEUS_URL.replace(/\/$/, '')}/-/healthy`),
    pingUrl(`${env.TEMPO_URL.replace(/\/$/, '')}/ready`),
    pingUrl(`${env.LOKI_URL.replace(/\/$/, '')}/ready`),
    pingUrl(`${env.AI_GATEWAY_URL.replace(/\/$/, '')}/models`, {
      Authorization: `Bearer ${env.AI_GATEWAY_KEY}`,
    }),
  ])

  const allUp =
    prometheus.status === 'UP' &&
    tempo.status === 'UP' &&
    loki.status === 'UP' &&
    aiGateway.status === 'UP'

  const anyUp =
    prometheus.status === 'UP' ||
    tempo.status === 'UP' ||
    loki.status === 'UP' ||
    aiGateway.status === 'UP'

  return {
    status: allUp ? 'UP' : anyUp ? 'DEGRADED' : 'DOWN',
    timestamp: new Date().toISOString(),
    monitors: {
      prometheus,
      tempo,
      loki,
      aiGateway,
    },
  }
}
