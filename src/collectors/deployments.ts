import { env } from 'config/env'

export interface DeploymentEvent {
  id: string
  application: string
  environment: string
  branch?: string
  commit?: string
  commitMessage?: string
  author?: string
  status: 'SUCCESS' | 'FAILED' | 'IN_PROGRESS'
  duration?: string
  timestamp: string
  triage?: {
    summary: string
    rootCause: string
    culpritFiles: string[]
    harnessPrompt: string
  }
}

export interface RecentDeploymentsReport {
  source: 'coolify+memory' | 'memory-only'
  deployments: DeploymentEvent[]
  note?: string
}

interface CoolifyAppSummary {
  uuid: string
  name?: string
  environment?: { name?: string }
}

interface CoolifyDeploymentRow {
  deployment_uuid: string
  application_name?: string
  status?: string
  commit?: string
  commit_message?: string
  created_at?: string
  finished_at?: string
}

export class DeploymentsCollector {
  private static instance: DeploymentsCollector
  private readonly events: DeploymentEvent[] = []
  private readonly maxEvents = 30

  static getInstance(): DeploymentsCollector {
    if (!DeploymentsCollector.instance) {
      DeploymentsCollector.instance = new DeploymentsCollector()
    }
    return DeploymentsCollector.instance
  }

  recordDeployment(event: DeploymentEvent): void {
    this.events.unshift(event)
    if (this.events.length > this.maxEvents) {
      this.events.pop()
    }
  }

  getRecentDeployments(limit = 5): DeploymentEvent[] {
    return this.events.slice(0, limit)
  }

  async getRecentDeployments24h(hours = 24): Promise<RecentDeploymentsReport> {
    const cutoffMs = Date.now() - hours * 3600 * 1000
    const memoryRecent = this.events.filter(e => {
      const ts = Date.parse(e.timestamp)
      return Number.isFinite(ts) && ts >= cutoffMs
    })

    if (!env.COOLIFY_API_TOKEN) {
      return {
        source: 'memory-only',
        deployments: memoryRecent,
        note: 'COOLIFY_API_TOKEN não configurado; exibindo apenas webhooks recebidos em memória nesta sessão.',
      }
    }

    try {
      const baseUrl = env.COOLIFY_API_URL.replace(/\/$/, '')
      const headers = {
        Authorization: `Bearer ${env.COOLIFY_API_TOKEN}`,
        Accept: 'application/json',
      }

      const appsRes = await fetch(`${baseUrl}/applications`, {
        headers,
        signal: AbortSignal.timeout(6000),
      })
      if (!appsRes.ok) {
        throw new Error(`Coolify /applications HTTP ${appsRes.status}`)
      }

      const apps = (await appsRes.json()) as CoolifyAppSummary[]
      if (!Array.isArray(apps)) {
        throw new Error('Unexpected Coolify /applications payload')
      }

      const deployResults = await Promise.allSettled(
        apps.map(async app => {
          const res = await fetch(`${baseUrl}/deployments/applications/${app.uuid}?take=5`, {
            headers,
            signal: AbortSignal.timeout(6000),
          })
          if (!res.ok) return [] as DeploymentEvent[]
          const payload = (await res.json()) as
            CoolifyDeploymentRow[] | { deployments?: CoolifyDeploymentRow[] }
          const rows = Array.isArray(payload) ? payload : (payload.deployments ?? [])

          return rows
            .map(row => {
              const tsRaw = row.finished_at ?? row.created_at
              const tsMs = tsRaw ? Date.parse(tsRaw) : NaN
              if (!Number.isFinite(tsMs) || tsMs < cutoffMs) return null

              const rawStatus = (row.status ?? '').toLowerCase()
              const status: DeploymentEvent['status'] =
                rawStatus === 'finished'
                  ? 'SUCCESS'
                  : rawStatus === 'failed'
                    ? 'FAILED'
                    : 'IN_PROGRESS'

              const event: DeploymentEvent = {
                id: row.deployment_uuid,
                application: row.application_name ?? app.name ?? app.uuid,
                environment: app.environment?.name ?? 'coolify',
                commit: row.commit ? row.commit.slice(0, 7) : undefined,
                commitMessage: row.commit_message?.split('\n')[0],
                status,
                timestamp: new Date(tsMs).toISOString(),
              }
              return event
            })
            .filter((item): item is DeploymentEvent => item !== null)
        }),
      )

      const byId = new Map<string, DeploymentEvent>()
      for (const e of memoryRecent) {
        byId.set(e.id, e)
      }
      for (const res of deployResults) {
        if (res.status !== 'fulfilled') continue
        for (const e of res.value) {
          if (!byId.has(e.id)) {
            byId.set(e.id, e)
          }
        }
      }

      const merged = Array.from(byId.values()).sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
      )

      return {
        source: 'coolify+memory',
        deployments: merged,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[DeploymentsCollector] Coolify API fallback to memory-only: ${message}`)
      return {
        source: 'memory-only',
        deployments: memoryRecent,
        note: `Falha ao consultar API do Coolify (${message}); exibindo apenas cache em memória.`,
      }
    }
  }
}
