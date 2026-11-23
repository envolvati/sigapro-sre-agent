import { z } from 'zod'
import { env } from 'config/env'
import { DockerCollector, inferServiceFromLogLine, type DockerContainerInfo } from './docker'

export interface LokiLogEntry {
  timestamp: string
  line: string
  service?: string
}

export interface LogCluster {
  service: string
  level: 'ERROR' | 'WARN'
  count: number
  firstSeen: string
  lastSeen: string
  sample: string
}

export interface DailyLogsSummary {
  windowHours: number
  lokiAvailable: boolean
  totalErrors: number
  totalWarnings: number
  suppressedScannerNoise: number
  observedServicesInLoki: string[]
  clusters: LogCluster[]
  queryErrors: number
}

const BENIGN_NOISE_PATTERNS = [
  /no jobs found/i, // Grafana Tempo compactor scheduler poll
  /BackendScheduler/i, // Grafana Tempo compactor scheduler gRPC
  /tempopb\./i, // Grafana Tempo protobuf
  /roundtrip\.go/i, // Loki query execution audit log
  /executing query/i, // Loki query execution audit log
  /backendworker\.go/i, // Grafana Tempo compactor worker
  /org_id=fake/i, // Loki internal querier/frontend logs
  /user=fake/i, // Loki internal querier/frontend logs
  /caller=(metrics|engine|index_set|recalculate_owned_streams|scheduler_processor|spanlogger|parallel_chunk_fetch)\.go/i,
  /plugins\.update\.checker/i, // Grafana plugin update checker
  /Prometheusexporter@.*Instrument description conflict/i, // OTel debug info log
  /"level":\s*30\b.*error cleared/i, // OmniRoute info recovery log
]

const SCANNER_NOISE_PATTERNS = [
  /rule=AUTH-12\s+reason=missing_api_key/i,
  /access forbidden by rule/i,
  /AH01(797|630):\s+client denied by server configuration/i,
]

const lokiResponseSchema = z.object({
  status: z.string(),
  data: z.object({
    resultType: z.string(),
    result: z.array(
      z.object({
        stream: z.record(z.string(), z.string()).optional(),
        values: z.array(z.tuple([z.string(), z.string()])),
      }),
    ),
  }),
})

const lokiLabelValuesSchema = z.object({
  status: z.string(),
  data: z.array(z.string()),
})

function isBenignNoise(line: string): boolean {
  return BENIGN_NOISE_PATTERNS.some(pattern => pattern.test(line))
}

function isScannerNoise(line: string): boolean {
  return SCANNER_NOISE_PATTERNS.some(pattern => pattern.test(line))
}

function classifyLogLevel(line: string): 'ERROR' | 'WARN' {
  if (/"level":\s*(50|60)\b/.test(line)) return 'ERROR'
  if (/"level":\s*40\b/.test(line)) return 'WARN'
  if (
    /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+WARN\b/i.test(line) ||
    /\blevel=warn\b/i.test(line)
  ) {
    return 'WARN'
  }
  if (
    /\b(error|fatal|panic|exception|uncaught|unhandled|fail(ed)?)\b/i.test(line) ||
    /rule=ORPHAN/i.test(line) ||
    /status[=\s]+5\d\d/i.test(line) ||
    /status code 5\d\d/i.test(line)
  ) {
    return 'ERROR'
  }
  return 'WARN'
}

function normalizeLogPattern(line: string): string {
  return line
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\d{4}[-/]\d{2}[-/]\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\b(ch|pl|hook|card|addr|oi|re|sk|pk)_[A-Za-z0-9]+\b/g, '$1_<ID>')
    .replace(/\b(external_id|orphan_id|event_id|combo_id)=[^\s]+/gi, '$1=<ID>')
    .replace(/\bclient [A-Za-z0-9_-]{16,}/g, 'client <ID>')
    .replace(/for the domains \[[^\]]+\]/gi, 'for the domains [<DOMAIN>]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<IP>')
    .replace(/\b[0-9a-f]{16,64}\b/gi, '<HEX>')
    .replace(/\b\d{4,}\b/g, '<NUM>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export class LokiCollector {
  private readonly baseUrl: string
  private readonly docker = new DockerCollector()

  constructor(baseUrl = env.LOKI_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private resolveServiceName(
    stream: Record<string, string> | undefined,
    line: string,
    containerMap: Map<string, DockerContainerInfo>,
  ): string {
    const rawService = stream?.service_name ?? stream?.app
    if (rawService && rawService !== 'unknown_service' && rawService !== 'unknown') {
      return rawService
    }
    const containerId = stream?.container_id
    if (containerId) {
      const info = containerMap.get(containerId) ?? containerMap.get(containerId.slice(0, 12))
      if (info?.appName) {
        return info.appName
      }
    }
    return inferServiceFromLogLine(line) ?? rawService ?? 'unknown_service'
  }

  async getObservedServiceNames(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/loki/api/v1/label/service_name/values`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return []
      const parsed = lokiLabelValuesSchema.safeParse(await res.json())
      return parsed.success ? parsed.data.data : []
    } catch {
      return []
    }
  }

  private async queryRange(query: string, startNano: bigint, endNano: bigint, limit: number) {
    const url = `${this.baseUrl}/loki/api/v1/query_range?query=${encodeURIComponent(
      query,
    )}&limit=${limit}&start=${startNano.toString()}&end=${endNano.toString()}`

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      throw new Error(`Loki HTTP ${res.status}`)
    }

    const raw: unknown = await res.json()
    const parsed = lokiResponseSchema.safeParse(raw)
    if (!parsed.success) {
      return []
    }
    return parsed.data.data.result
  }

  async getRecentErrors(
    limit = 10,
    serviceSelector = '.+',
    windowMinutes = 15,
  ): Promise<LokiLogEntry[]> {
    try {
      const query = `{service_name=~"${serviceSelector}"} |~ "(?i)error|fatal|exception|fail|rule=ORPHAN" !~ "(?i)roundtrip\\\\.go|metrics\\\\.go|engine\\\\.go|executing query|no jobs found|org_id=fake|plugins\\\\.update\\\\.checker"`
      const nowNano = BigInt(Date.now()) * BigInt(1_000_000)
      const windowNano = BigInt(windowMinutes * 60 * 1000) * BigInt(1_000_000)
      const startNano = nowNano - windowNano

      const [streams, containerMap] = await Promise.all([
        this.queryRange(query, startNano, nowNano, limit * 3),
        this.docker.getContainerMap(),
      ])

      const entries: LokiLogEntry[] = []
      for (const stream of streams) {
        for (const [timeNano, line] of stream.values) {
          const trimmed = line.trim()
          if (isBenignNoise(trimmed) || isScannerNoise(trimmed)) {
            continue
          }
          const service = this.resolveServiceName(stream.stream, trimmed, containerMap)
          if (service === 'loki-internal' || service === 'otelcol-contrib') {
            continue
          }
          entries.push({
            timestamp: new Date(Number(BigInt(timeNano) / BigInt(1_000_000))).toISOString(),
            line: trimmed,
            service,
          })
        }
      }

      return entries.slice(0, limit)
    } catch {
      return []
    }
  }

  async getDailyErrorWarningSummary(options?: {
    windowHours?: number
    maxClusters?: number
    containerMap?: Map<string, DockerContainerInfo>
  }): Promise<DailyLogsSummary> {
    const windowHours = options?.windowHours ?? 24
    const maxClusters = options?.maxClusters ?? 18

    const [containerMap, observedServicesInLoki] = await Promise.all([
      options?.containerMap ? Promise.resolve(options.containerMap) : this.docker.getContainerMap(),
      this.getObservedServiceNames(),
    ])

    const noiseExclude =
      '!~ "(?i)roundtrip\\\\.go|metrics\\\\.go|engine\\\\.go|scheduler_processor\\\\.go|spanlogger\\\\.go|parallel_chunk_fetch\\\\.go|executing query|no jobs found|org_id=fake|user=fake|plugins\\\\.update\\\\.checker|recalculate_owned_streams\\\\.go|index_set\\\\.go|otelcol-contrib|Prometheusexporter|level=info|rule=AUTH-12|access forbidden by rule|AH01797|AH01630"'

    const queryErrorsOnly = `{service_name=~".+"} |~ "(?i)\\\\b(error|fatal|panic|exception|uncaught|unhandled|fail(ed)?)\\\\b|rule=ORPHAN|status code 5\\\\d\\\\d" ${noiseExclude}`
    const queryWarnsOnly = `{service_name=~".+"} |~ "(?i)\\\\b(warn|warning)\\\\b" ${noiseExclude}`
    const queryApi =
      '{service_name=~"sigapro-api.*"} |~ "(?i)\\\\b(error|fatal|panic|exception|fail|failed|warn|warning)\\\\b|status code 5\\\\d\\\\d"'

    const nowMs = Date.now()
    const sliceCount = Math.max(1, Math.min(12, Math.ceil(windowHours / 3)))
    const sliceMs = (windowHours * 3600 * 1000) / sliceCount

    const slicePromises = [
      ...Array.from({ length: sliceCount }, (_, i) => {
        const sliceEndMs = Math.floor(nowMs - i * sliceMs)
        const sliceStartMs = Math.floor(nowMs - (i + 1) * sliceMs)
        return this.queryRange(
          queryErrorsOnly,
          BigInt(sliceStartMs) * BigInt(1_000_000),
          BigInt(sliceEndMs) * BigInt(1_000_000),
          1000,
        )
      }),
      ...Array.from({ length: sliceCount }, (_, i) => {
        const sliceEndMs = Math.floor(nowMs - i * sliceMs)
        const sliceStartMs = Math.floor(nowMs - (i + 1) * sliceMs)
        return this.queryRange(
          queryWarnsOnly,
          BigInt(sliceStartMs) * BigInt(1_000_000),
          BigInt(sliceEndMs) * BigInt(1_000_000),
          500,
        )
      }),
      this.queryRange(
        queryApi,
        BigInt(Math.floor(nowMs - windowHours * 3600 * 1000)) * BigInt(1_000_000),
        BigInt(nowMs) * BigInt(1_000_000),
        500,
      ),
    ]

    const results = await Promise.allSettled(slicePromises)

    let queryErrors = 0
    let succeededSlices = 0
    let totalErrors = 0
    let totalWarnings = 0
    let suppressedScannerNoise = 0

    const seenTimestamps = new Set<string>()
    const clusterMap = new Map<string, LogCluster>()

    for (const res of results) {
      if (res.status === 'rejected') {
        queryErrors++
        continue
      }
      succeededSlices++

      for (const stream of res.value) {
        const containerId = stream.stream?.container_id ?? ''
        for (const [timeNano, line] of stream.values) {
          const trimmed = line.trim()
          if (!trimmed || isBenignNoise(trimmed)) continue

          // Skip otelcol-contrib non-error debug exporter chatter
          if (
            trimmed.includes('"service.name": "otelcol-contrib"') &&
            !/\b(error|fatal|drop|failed)\b/i.test(
              trimmed.replace(/"otelcol\.signal":\s*"[^"]+"/, ''),
            )
          ) {
            continue
          }

          const dedupEventKey = `${containerId}:${timeNano}:${trimmed.slice(0, 60)}`
          if (seenTimestamps.has(dedupEventKey)) continue
          seenTimestamps.add(dedupEventKey)

          if (isScannerNoise(trimmed)) {
            suppressedScannerNoise++
            continue
          }

          const service = this.resolveServiceName(stream.stream, trimmed, containerMap)
          if (service === 'loki-internal') continue

          const level = classifyLogLevel(trimmed)
          if (level === 'ERROR') totalErrors++
          else totalWarnings++

          const iso = new Date(Number(BigInt(timeNano) / BigInt(1_000_000))).toISOString()
          const pattern = normalizeLogPattern(trimmed)
          const clusterKey = `${service}::${level}::${pattern}`

          const existing = clusterMap.get(clusterKey)
          if (!existing) {
            clusterMap.set(clusterKey, {
              service,
              level,
              count: 1,
              firstSeen: iso,
              lastSeen: iso,
              sample: trimmed.length > 220 ? `${trimmed.slice(0, 220)}...` : trimmed,
            })
          } else {
            existing.count++
            if (iso < existing.firstSeen) existing.firstSeen = iso
            if (iso > existing.lastSeen) {
              existing.lastSeen = iso
              existing.sample = trimmed.length > 220 ? `${trimmed.slice(0, 220)}...` : trimmed
            }
          }
        }
      }
    }

    const clusters = Array.from(clusterMap.values())
      .sort((a, b) => {
        if (a.level !== b.level) return a.level === 'ERROR' ? -1 : 1
        return b.count - a.count
      })
      .slice(0, maxClusters)

    return {
      windowHours,
      lokiAvailable: succeededSlices > 0,
      totalErrors,
      totalWarnings,
      suppressedScannerNoise,
      observedServicesInLoki,
      clusters,
      queryErrors,
    }
  }
}
