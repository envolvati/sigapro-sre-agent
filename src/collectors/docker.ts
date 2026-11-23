import fs from 'node:fs'
import http from 'node:http'

export interface DockerContainerInfo {
  id: string
  shortId: string
  name: string
  appName: string
  image: string
  state: string
  status: string
}

interface RawDockerContainer {
  Id: string
  Names?: string[]
  Image?: string
  State?: string
  Status?: string
  Labels?: Record<string, string>
}

export class DockerCollector {
  private readonly socketPath = '/var/run/docker.sock'

  private dockerGet<T>(path: string): Promise<T | null> {
    return new Promise(resolve => {
      if (!fs.existsSync(this.socketPath)) {
        return resolve(null)
      }

      const req = http.get({ socketPath: this.socketPath, path }, res => {
        let data = ''
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T)
          } catch {
            resolve(null)
          }
        })
      })

      req.on('error', () => resolve(null))
      req.setTimeout(4000, () => {
        req.destroy()
        resolve(null)
      })
    })
  }

  private normalizeAppName(raw: RawDockerContainer): string {
    const labels = raw.Labels ?? {}
    const coolifyName =
      labels['coolify.applicationName'] ||
      labels['coolify.name'] ||
      labels['com.docker.compose.service']

    if (coolifyName && coolifyName.trim()) {
      return coolifyName.trim()
    }

    const rawName = (raw.Names?.[0] ?? raw.Id.slice(0, 12)).replace(/^\//, '')
    // Coolify nomes costumam ter sufixo de timestamp/hash após o último hífen (ex: app-20261105...)
    return rawName.replace(/-[a-z0-9]{10,}$/i, '') || rawName
  }

  async getContainerMap(): Promise<Map<string, DockerContainerInfo>> {
    const map = new Map<string, DockerContainerInfo>()
    const containers = await this.dockerGet<RawDockerContainer[]>('/v1.41/containers/json?all=true')
    if (!containers || !Array.isArray(containers)) {
      return map
    }

    for (const c of containers) {
      const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '')
      const info: DockerContainerInfo = {
        id: c.Id,
        shortId: c.Id.slice(0, 12),
        name,
        appName: this.normalizeAppName(c),
        image: c.Image ?? '',
        state: c.State ?? 'unknown',
        status: c.Status ?? '',
      }
      map.set(c.Id, info)
      map.set(info.shortId, info)
    }

    return map
  }
}

export function inferServiceFromLogLine(line: string): string | null {
  if (line.includes('"service.name": "otelcol-contrib"') || line.includes('otelcol.component.id')) {
    return 'otelcol-contrib'
  }
  if (
    line.includes('org_id=fake') ||
    line.includes('user=fake') ||
    /caller=(metrics|engine|roundtrip|index_set|recalculate_owned_streams|scheduler_processor|spanlogger)\.go/.test(
      line,
    )
  ) {
    return 'loki-internal'
  }
  if (
    line.includes('Unable to obtain ACME certificate') ||
    line.includes('error: port is missing') ||
    /\bcontainer=/.test(line)
  ) {
    return 'traefik-proxy'
  }
  if (
    line.includes('"service":"omniroute"') ||
    line.includes('[ProxyEgress]') ||
    /\[(DeepSeek|CLAUDE|Claude)/i.test(line)
  ) {
    return 'sigapro-ai-gateway'
  }
  if (
    line.includes('rule=ORPHAN-') ||
    line.includes('rule=AUTH-12') ||
    line.includes('payments-gateway')
  ) {
    return 'envolvati-payments-gateway'
  }
  if (line.includes('error login') || line.includes('sessionToken')) {
    return 'sigapro-app'
  }
  if (line.includes('apps.uptime.tasks') || line.includes('glitchtip')) {
    return 'glitchtip-sigapro'
  }
  if (line.includes('[prod:SigaproAPI]')) {
    return 'sigapro-api-prod'
  }
  if (line.includes('[hml:SigaproAPI]') || line.includes('[stg:SigaproAPI]')) {
    return 'sigapro-api-hml'
  }
  if (
    line.includes('[TelegramListener]') ||
    line.includes('[DailyDigestUseCase]') ||
    line.includes('[PRAudit]')
  ) {
    return 'sigapro-sre-agent'
  }
  return null
}
