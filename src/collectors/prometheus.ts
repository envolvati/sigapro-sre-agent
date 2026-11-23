import { z } from 'zod'
import { env } from 'config/env'

export interface MetricsSummary {
  window: string
  prometheusAvailable: boolean
  requestsTotal: number | null
  errorRate5xx: number | null
  latencyP95Seconds: number | null
  latencyP99Seconds: number | null
  matchedMetrics: {
    requestsMetric?: string
    latencyBucketMetric?: string
  }
  connectedServices: string[]
  topSlowEndpoints: Array<{ endpoint: string; durationMs: number }>
}

const REQUEST_METRIC_CANDIDATES = [
  'http_server_request_duration_seconds_count',
  'http_server_duration_milliseconds_count',
  'http_server_requests_total',
  'http_requests_total',
  'traces_spanmetrics_calls_total',
]

const LATENCY_BUCKET_CANDIDATES = [
  'http_server_request_duration_seconds_bucket',
  'http_server_duration_milliseconds_bucket',
  'http_request_duration_seconds_bucket',
  'traces_spanmetrics_latency_bucket',
]

const prometheusResultSchema = z.object({
  status: z.string(),
  data: z.object({
    resultType: z.string(),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()).optional(),
        value: z.tuple([z.number(), z.string()]).optional(),
      }),
    ),
  }),
})

const prometheusLabelValuesSchema = z.object({
  status: z.string(),
  data: z.array(z.string()),
})

export class PrometheusCollector {
  private readonly baseUrl: string

  constructor(baseUrl = env.PROMETHEUS_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async queryPrometheus(query: string) {
    const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) {
      throw new Error(`Prometheus query failed (${response.status}): ${await response.text()}`)
    }
    const raw: unknown = await response.json()
    const parsed = prometheusResultSchema.safeParse(raw)
    if (!parsed.success) {
      return []
    }
    return parsed.data.data.result
  }

  private async fetchMetricNames(): Promise<Set<string>> {
    const response = await fetch(`${this.baseUrl}/api/v1/label/__name__/values`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      throw new Error(`Prometheus metric discovery failed (${response.status})`)
    }
    const parsed = prometheusLabelValuesSchema.safeParse(await response.json())
    return new Set(parsed.success ? parsed.data.data : [])
  }

  private async fetchConnectedServices(): Promise<string[]> {
    const services = new Set<string>()
    try {
      const otelRes = await this.queryPrometheus('count by (service_name) ({service_name!=""})')
      for (const r of otelRes) {
        const svc = r.metric?.service_name
        if (svc) services.add(svc)
      }
    } catch {
      // ignore
    }
    try {
      const jobRes = await this.queryPrometheus('up == 1')
      for (const r of jobRes) {
        const job = r.metric?.exported_job ?? r.metric?.job
        if (job) services.add(job)
      }
    } catch {
      // ignore
    }
    return [...services].sort()
  }

  private parseNumericValue(results: Array<{ value?: [number, string] }>): number | null {
    const rawVal = results[0]?.value?.[1]
    if (!rawVal) return null
    const num = Number(rawVal)
    return Number.isFinite(num) ? num : null
  }

  async getRecentSummary(window = '15m'): Promise<MetricsSummary> {
    try {
      const [metricNames, connectedServices] = await Promise.all([
        this.fetchMetricNames(),
        this.fetchConnectedServices(),
      ])

      const requestsMetric = REQUEST_METRIC_CANDIDATES.find(m => metricNames.has(m))
      const latencyBucketMetric = LATENCY_BUCKET_CANDIDATES.find(m => metricNames.has(m))

      let requestsTotal: number | null = null
      let errorRate5xx: number | null = null

      if (requestsMetric) {
        const totalRes = await this.queryPrometheus(`sum(increase(${requestsMetric}[${window}]))`)
        const totalVal = this.parseNumericValue(totalRes)
        if (totalVal !== null) {
          requestsTotal = Math.round(totalVal)
          if (totalVal > 0) {
            const errQuery = `sum(increase(${requestsMetric}{status=~"5.."}[${window}])) or sum(increase(${requestsMetric}{http_response_status_code=~"5.."}[${window}])) or sum(increase(${requestsMetric}{http_status_code=~"5.."}[${window}]))`
            const errRes = await this.queryPrometheus(errQuery)
            const errVal = this.parseNumericValue(errRes) ?? 0
            errorRate5xx = Math.round((errVal / totalVal) * 100 * 100) / 100
          }
        }
      }

      let latencyP95Seconds: number | null = null
      let latencyP99Seconds: number | null = null

      if (latencyBucketMetric) {
        const isMilliseconds = latencyBucketMetric.includes('milliseconds')
        const scale = isMilliseconds ? 1000 : 1
        const [p95Res, p99Res] = await Promise.all([
          this.queryPrometheus(
            `histogram_quantile(0.95, sum(rate(${latencyBucketMetric}[${window}])) by (le))`,
          ),
          this.queryPrometheus(
            `histogram_quantile(0.99, sum(rate(${latencyBucketMetric}[${window}])) by (le))`,
          ),
        ])
        const p95Raw = this.parseNumericValue(p95Res)
        const p99Raw = this.parseNumericValue(p99Res)
        if (p95Raw !== null) {
          latencyP95Seconds = Math.round((p95Raw / scale) * 1000) / 1000
        }
        if (p99Raw !== null) {
          latencyP99Seconds = Math.round((p99Raw / scale) * 1000) / 1000
        }
      }

      return {
        window,
        prometheusAvailable: true,
        requestsTotal,
        errorRate5xx,
        latencyP95Seconds,
        latencyP99Seconds,
        matchedMetrics: {
          requestsMetric,
          latencyBucketMetric,
        },
        connectedServices,
        topSlowEndpoints: [],
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[PrometheusCollector] Warning querying metrics: ${message}`)
      return {
        window,
        prometheusAvailable: false,
        requestsTotal: null,
        errorRate5xx: null,
        latencyP95Seconds: null,
        latencyP99Seconds: null,
        matchedMetrics: {},
        connectedServices: [],
        topSlowEndpoints: [],
      }
    }
  }
}
