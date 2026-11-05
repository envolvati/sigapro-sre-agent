import { z } from 'zod'
import { env } from 'config/env'

export interface LokiLogEntry {
  timestamp: string
  line: string
  service?: string
}
const BENIGN_NOISE_PATTERNS = [
  /no jobs found/i,             // Grafana Tempo compactor scheduler poll
  /BackendScheduler/i,          // Grafana Tempo compactor scheduler gRPC
  /tempopb\./i,                 // Grafana Tempo protobuf
  /roundtrip\.go/i,             // Loki query execution audit log
  /executing query/i,           // Loki query execution audit log
  /backendworker\.go/i,         // Grafana Tempo compactor worker
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
export class LokiCollector {
  private readonly baseUrl: string

  constructor(baseUrl = env.LOKI_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async getRecentErrors(limit = 10, serviceSelector = '.+'): Promise<LokiLogEntry[]> {
    try {
      // Busca logs recentes com level error ou palavras de falha, excluindo ruídos internos de infraestrutura
      const query = `{service_name=~"${serviceSelector}"} |~ "(?i)error|fatal|exception|fail" !~ "(?i)roundtrip\\\\.go|executing query|no jobs found"`
      const nowNano = BigInt(Date.now()) * BigInt(1_000_000)
      const fifteenMinNano = BigInt(15 * 60 * 1000) * BigInt(1_000_000)
      const startNano = nowNano - fifteenMinNano

      const url = `${this.baseUrl}/loki/api/v1/query_range?query=${encodeURIComponent(
        query,
      )}&limit=${limit * 2}&start=${startNano.toString()}&end=${nowNano.toString()}`

      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        return []
      }

      const raw: unknown = await res.json()
      const parsed = lokiResponseSchema.safeParse(raw)
      if (!parsed.success) {
        return []
      }

      const entries: LokiLogEntry[] = []
      for (const stream of parsed.data.data.result) {
        const service = stream.stream?.service_name ?? stream.stream?.app ?? 'unknown'
        for (const [timeNano, line] of stream.values) {
          const trimmed = line.trim()
          if (BENIGN_NOISE_PATTERNS.some(pattern => pattern.test(trimmed))) {
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
}
