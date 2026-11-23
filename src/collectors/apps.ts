import { env } from 'config/env'
import { LokiCollector, type LokiLogEntry } from './loki'

export interface MonitoredAppReport {
  name: string
  key: 'payments-prod' | 'payments-hml' | 'payments' | 'sigapro-api' | 'sigapro-app'
  url: string
  status: 'UP' | 'DOWN'
  latencyMs?: number
  error?: string
  details?: Record<string, unknown>
  recentErrors?: LokiLogEntry[]
}

export class AppsCollector {
  private readonly loki = new LokiCollector()

  async checkPaymentsGateway(
    envType: 'prod' | 'hml' = 'prod',
    prefetchedErrors?: LokiLogEntry[],
  ): Promise<MonitoredAppReport> {
    const isHml = envType === 'hml'
    const name = isHml
      ? 'Envolvati Payments Gateway (Homologação)'
      : 'Envolvati Payments Gateway (Produção)'
    const key = isHml ? 'payments-hml' : 'payments-prod'

    const baseUrl = isHml
      ? env.PAYMENTS_GATEWAY_HML_URL || 'https://hml-payments.envolvati.com'
      : env.PAYMENTS_GATEWAY_URL.includes('hml')
        ? 'https://payments.envolvati.com'
        : env.PAYMENTS_GATEWAY_URL

    const url = `${baseUrl.replace(/\/$/, '')}/health`
    const start = Date.now()
    try {
      const [res, recentErrors] = await Promise.all([
        fetch(url, { signal: AbortSignal.timeout(5000) }),
        prefetchedErrors
          ? Promise.resolve(prefetchedErrors)
          : this.loki.getRecentErrors(15, '.+', 15),
      ])
      const latencyMs = Date.now() - start
      const paymentsErrors = recentErrors
        .filter(e => {
          const svc = (e.service ?? '').toLowerCase()
          if (!svc.includes('payments') && !e.line.toLowerCase().includes('payments-gateway')) {
            return false
          }
          if (isHml && svc.includes('prod')) return false
          if (!isHml && svc.includes('hml')) return false
          return true
        })
        .slice(0, 5)

      if (res.ok) {
        const data = (await res.json()) as {
          status: string
          healthy: boolean
          workers?: Record<string, { status: string; restarts: number }>
        }
        return {
          name,
          key,
          url: baseUrl,
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
        name,
        key,
        url: baseUrl,
        status: 'DOWN',
        latencyMs,
        error: `HTTP ${res.status}: ${res.statusText}`,
        recentErrors: paymentsErrors,
      }
    } catch (err: unknown) {
      return {
        name,
        key,
        url: baseUrl,
        status: 'DOWN',
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        recentErrors: [],
      }
    }
  }

  async checkSigaproApi(prefetchedErrors?: LokiLogEntry[]): Promise<MonitoredAppReport> {
    const url = env.SIGAPRO_API_URL
    const start = Date.now()
    try {
      const [res, recentErrors] = await Promise.all([
        fetch(url, { signal: AbortSignal.timeout(5000) }),
        prefetchedErrors
          ? Promise.resolve(prefetchedErrors)
          : this.loki.getRecentErrors(10, 'sigapro-api-prod', 15),
      ])
      const latencyMs = Date.now() - start
      const apiErrors = recentErrors
        .filter(e => {
          const svc = (e.service ?? '').toLowerCase()
          return svc.includes('sigapro-api-prod') || svc === 'sigapro:prod-api'
        })
        .slice(0, 5)

      if (res.ok) {
        return {
          name: 'SigaPro API (Backend)',
          key: 'sigapro-api',
          url,
          status: 'UP',
          latencyMs,
          details: {
            httpStatus: res.status,
            healthCheckType: 'root-endpoint-only',
          },
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

  async checkSigaproApp(prefetchedErrors?: LokiLogEntry[]): Promise<MonitoredAppReport> {
    const baseUrl = env.SIGAPRO_APP_URL.replace(/\/$/, '')
    const healthUrl = `${baseUrl}/api/health`
    const start = Date.now()
    try {
      const [res, recentErrors] = await Promise.all([
        fetch(healthUrl, { signal: AbortSignal.timeout(5000) }),
        prefetchedErrors
          ? Promise.resolve(prefetchedErrors)
          : this.loki.getRecentErrors(15, '.+', 15),
      ])
      const latencyMs = Date.now() - start

      const appErrors = recentErrors
        .filter(e => {
          const svc = (e.service ?? '').toLowerCase()
          const line = e.line.toLowerCase()
          return (
            svc.includes('sigapro-app') ||
            svc.includes('prod-app') ||
            line.includes('sigapro-app') ||
            line.includes('error login')
          )
        })
        .slice(0, 5)

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
            memory: data.memory
              ? {
                  heapUsedMB: data.memory.heapUsedMB,
                  heapAllocatedV8MB: data.memory.heapTotalMB,
                  rssMB: data.memory.rssMB,
                  note: 'heapAllocatedV8MB (heapTotal) é o bloco V8 alocado sob demanda até agora, NÃO o limite máximo de heap do Node.js.',
                }
              : undefined,
            nodeVersion: data.nodeVersion,
          },
          recentErrors: appErrors,
        }
      }

      // Fallback para URL raiz se o endpoint ainda não estiver ativo
      const rootRes = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) })
      if (rootRes.ok) {
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
    const sharedErrors = await this.loki.getRecentErrors(30, '.+', 15)
    return Promise.all([
      this.checkPaymentsGateway('prod', sharedErrors),
      this.checkPaymentsGateway('hml', sharedErrors),
      this.checkSigaproApi(sharedErrors),
      this.checkSigaproApp(sharedErrors),
    ])
  }
}
