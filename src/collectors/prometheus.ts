import { z } from 'zod';
import { env } from '../config/env.js';

export interface MetricsSummary {
  requestsTotal?: number;
  errorRate5xx?: number;
  latencyP95Seconds?: number;
  latencyP99Seconds?: number;
  topSlowEndpoints: Array<{ endpoint: string; durationMs: number }>;
}

const prometheusResultSchema = z.object({
  status: z.string(),
  data: z.object({
    resultType: z.string(),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()).optional(),
        value: z.tuple([z.number(), z.string()]).optional(),
      })
    ),
  }),
});

export class PrometheusCollector {
  private readonly baseUrl: string;

  constructor(baseUrl = env.PROMETHEUS_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async queryPrometheus(query: string) {
    const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Prometheus query failed (${response.status}): ${await response.text()}`);
    }
    const raw: unknown = await response.json();
    const parsed = prometheusResultSchema.safeParse(raw);
    if (!parsed.success) {
      return [];
    }
    return parsed.data.data.result;
  }

  async getRecentSummary(): Promise<MetricsSummary> {
    try {
      // 1. Error rate 5xx (últimos 15 min)
      const errorRateResults = await this.queryPrometheus(
        'sum(rate(http_requests_total{status=~"5.."}[15m])) / sum(rate(http_requests_total[15m])) * 100'
      );
      const errorRate5xx = errorRateResults[0]?.value?.[1] ? parseFloat(errorRateResults[0].value[1]) : 0;

      // 2. Latency p95 e p99
      const p95Results = await this.queryPrometheus(
        'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[15m])) by (le))'
      );
      const latencyP95Seconds = p95Results[0]?.value?.[1] ? parseFloat(p95Results[0].value[1]) : 0;

      const p99Results = await this.queryPrometheus(
        'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[15m])) by (le))'
      );
      const latencyP99Seconds = p99Results[0]?.value?.[1] ? parseFloat(p99Results[0].value[1]) : 0;

      return {
        errorRate5xx: Math.round(errorRate5xx * 100) / 100,
        latencyP95Seconds: Math.round(latencyP95Seconds * 1000) / 1000,
        latencyP99Seconds: Math.round(latencyP99Seconds * 1000) / 1000,
        topSlowEndpoints: [],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[PrometheusCollector] Warning querying metrics: ${message}`);
      return {
        errorRate5xx: 0,
        latencyP95Seconds: 0,
        latencyP99Seconds: 0,
        topSlowEndpoints: [],
      };
    }
  }
}
