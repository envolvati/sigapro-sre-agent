import { z } from 'zod';
import { env } from '../config/env.js';

export interface CompactSpan {
  traceId: string;
  spanId: string;
  name: string;
  durationMs: number;
  statusCode?: string;
  statusMessage?: string;
  attributes: Record<string, string>;
  events: Array<{ name: string; timeUnixNano: string }>;
}

export interface CompactTrace {
  traceId: string;
  rootSpanName: string;
  totalDurationMs: number;
  spansCount: number;
  hasErrors: boolean;
  spans: CompactSpan[];
}

const keyValSchema = z.object({
  key: z.string(),
  value: z.object({
    stringValue: z.string().optional(),
    intValue: z.string().optional(),
    boolValue: z.boolean().optional(),
  }),
});

const spanEventSchema = z.object({
  timeUnixNano: z.string(),
  name: z.string(),
});

const spanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  name: z.string(),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes: z.array(keyValSchema).optional(),
  events: z.array(spanEventSchema).optional(),
  status: z
    .object({
      code: z.union([z.string(), z.number()]).optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const tempoTraceSchema = z.object({
  batches: z.array(
    z.object({
      scopeSpans: z.array(
        z.object({
          spans: z.array(spanSchema),
        })
      ),
    })
  ),
});

export class TempoCollector {
  private readonly baseUrl: string;

  constructor(baseUrl = env.TEMPO_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getTrace(traceId: string): Promise<CompactTrace | null> {
    try {
      const url = `${this.baseUrl}/api/traces/${traceId}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        console.warn(`[TempoCollector] Failed to fetch trace ${traceId}: HTTP ${res.status}`);
        return null;
      }

      const raw: unknown = await res.json();
      const parsed = tempoTraceSchema.safeParse(raw);
      if (!parsed.success) {
        return null;
      }

      const allSpans: CompactSpan[] = [];
      let hasErrors = false;
      let minStartNano = BigInt(-1);
      let maxEndNano = BigInt(0);

      for (const batch of parsed.data.batches) {
        for (const scope of batch.scopeSpans) {
          for (const s of scope.spans) {
            const start = BigInt(s.startTimeUnixNano);
            const end = BigInt(s.endTimeUnixNano);
            const durationMs = Number((end - start) / BigInt(1_000_000));

            if (minStartNano === BigInt(-1) || start < minStartNano) minStartNano = start;
            if (end > maxEndNano) maxEndNano = end;

            const isError = s.status?.code === 'STATUS_CODE_ERROR' || s.status?.code === 2;
            if (isError) hasErrors = true;

            const attributes: Record<string, string> = {};
            if (s.attributes) {
              for (const attr of s.attributes) {
                const val = attr.value.stringValue ?? attr.value.intValue ?? String(attr.value.boolValue ?? '');
                attributes[attr.key] = val;
              }
            }

            allSpans.push({
              traceId: s.traceId,
              spanId: s.spanId,
              name: s.name,
              durationMs,
              statusCode: String(s.status?.code ?? 'OK'),
              statusMessage: s.status?.message,
              attributes,
              events: s.events ?? [],
            });
          }
        }
      }

      const totalDurationMs =
        minStartNano >= BigInt(0) ? Number((maxEndNano - minStartNano) / BigInt(1_000_000)) : 0;

      // Ordenar spans do mais lento pro mais rápido
      allSpans.sort((a, b) => b.durationMs - a.durationMs);

      return {
        traceId,
        rootSpanName: allSpans[0]?.name ?? 'unknown',
        totalDurationMs,
        spansCount: allSpans.length,
        hasErrors,
        spans: allSpans.slice(0, 15), // Limita aos top 15 spans para não estourar o prompt
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[TempoCollector] Error querying trace ${traceId}: ${message}`);
      return null;
    }
  }
}
