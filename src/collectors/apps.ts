import { env } from 'config/env'
import { LokiCollector, type LokiLogEntry } from './loki'

export interface MonitoredAppReport {
  name: string
  key: 'payments' | 'sigapro-api' | 'sigapro-app'
  url: string
  status: 'UP' | 'DOWN'
  latencyMs?: number
  error?: string
  details?: Record<string, unknown>
  recentErrors?: LokiLogEntry[]
}

export class AppsCollector {
  private readonly loki = new LokiCollector()

  async checkPaymentsGateway(): Promise<MonitoredAppReport> {
    const url = `${env.PAYMENTS_GATEWAY_URL.replace(/\/$/, '')}/health`
    const start = Date.now()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const latencyMs = Date.now() - start
      const recentErrors = await this.loki.getRecentErrors(5, '.*payments.*')
      const paymentsErrors = recentErrors.filter(
        e =>
          e.service?.toLowerCase().includes('payments') ||
          e.line.toLowerCase().includes('payments-gateway'),
      )
      if (res.ok) {
        const data = (await res.json()) as {
          status: string
          healthy: boolean
          workers?: Record<string, { status: string; restarts: number }>
        }
        return {
          name: 'Envolvati Payments Gateway',
          key: 'payments',
          url: env.PAYMENTS_GATEWAY_URL,
          status: data.healthy ? 'UP' : 'DOWN',
          latencyMs,
          details: {
            healthy: data.healthy,
            workers: data.workers,
          },
          recentErrors: paymentsErrors,
        }
      }
      return {
        name: 'Envolvati Payments Gateway',
        key: 'payments',
        url: env.PAYMENTS_GATEWAY_URL,
        status: 'DOWN',
        latencyMs,
        error: `HTTP ${res.status}: ${res.statusText}`,
        recentErrors: paymentsErrors,
      }
    } catch (err: unknown) {
      return {
        name: 'Envolvati Payments Gateway',
        key: 'payments',
        url: env.PAYMENTS_GATEWAY_URL,
        status: 'DOWN',
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        recentErrors: [],
      }
    }
  }

  async checkSigaproApi(): Promise<MonitoredAppReport> {
    const url = env.SIGAPRO_API_URL
    const start = Date.now()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const latencyMs = Date.now() - start
      const recentErrors = await this.loki.getRecentErrors(5, 'sigapro-api.*')
      const apiErrors = recentErrors.filter(
        e => e.service?.toLowerCase().includes('api') || e.service?.toLowerCase().includes('sigapro'),
      )

      if (res.ok || res.status === 200 || res.status === 404) {
        return {
          name: 'SigaPro API (Backend)',
          key: 'sigapro-api',
          url,
          status: 'UP',
          latencyMs,
          recentErrors: apiErrors,
        }
      }
      return {
        name: 'SigaPro API (Backend)',
        key: 'sigapro-api',
        url,
        status: 'DOWN',
        latencyMs,
        error: `HTTP ${res.status}: ${res.statusText}`,
        recentErrors: apiErrors,
      }
    } catch (err: unknown) {
      return {
        name: 'SigaPro API (Backend)',
        key: 'sigapro-api',
        url,
        status: 'DOWN',
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async checkSigaproApp(): Promise<MonitoredAppReport> {
    const baseUrl = env.SIGAPRO_APP_URL.replace(/\/$/, '')
    const healthUrl = `${baseUrl}/api/health`
    const start = Date.now()
    try {
      const recentErrors = await this.loki.getRecentErrors(5, 'sigapro-app.*')
      const appErrors = recentErrors.filter(
        e =>
          e.service?.toLowerCase().includes('app') ||
          e.line.toLowerCase().includes('sigapro-app') ||
          e.line.toLowerCase().includes('next'),
      )

      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })
      const latencyMs = Date.now() - start

      if (res.ok) {
        const data = (await res.json()) as {
          status?: string
          uptimeSeconds?: number
          memory?: { heapUsedMB?: number; heapTotalMB?: number; rssMB?: number }
          nodeVersion?: string
        }

        return {
          name: 'SigaPro App (Frontend Next.js)',
          key: 'sigapro-app',
          url: healthUrl,
          status: 'UP',
          latencyMs,
          details: {
            uptimeSeconds: data.uptimeSeconds,
            memory: data.memory,
            nodeVersion: data.nodeVersion,
          },
          recentErrors: appErrors,
        }
      }

      // Fallback para URL raiz se o endpoint ainda não estiver ativo
      const rootRes = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) })
      if (rootRes.ok || rootRes.status === 200) {
        return {
          name: 'SigaPro App (Frontend Next.js)',
          key: 'sigapro-app',
          url: baseUrl,
          status: 'UP',
          latencyMs: Date.now() - start,
          recentErrors: appErrors,
        }
      }

      return {
        name: 'SigaPro App (Frontend Next.js)',
        key: 'sigapro-app',
        url: healthUrl,
        status: 'DOWN',
        latencyMs,
        error: `HTTP ${res.status}: ${res.statusText}`,
        recentErrors: appErrors,
      }
    } catch (err: unknown) {
      return {
        name: 'SigaPro App (Frontend Next.js)',
        key: 'sigapro-app',
        url: healthUrl,
        status: 'DOWN',
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async getAllApps(): Promise<MonitoredAppReport[]> {
    return Promise.all([
      this.checkPaymentsGateway(),
      this.checkSigaproApi(),
      this.checkSigaproApp(),
    ])
  }
}
