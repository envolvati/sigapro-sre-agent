import OpenAI from 'openai'
import { env } from '../config/env.js'
import type { MetricsSummary } from '../collectors/prometheus.js'
import type { CompactTrace } from '../collectors/tempo.js'
import type { LokiLogEntry } from '../collectors/loki.js'
import type { MonitoredAppReport } from '../collectors/apps.js'

export class AIGatewayClient {
  private readonly client: OpenAI
  private readonly model: string

  constructor(baseURL = env.AI_GATEWAY_URL, apiKey = env.AI_GATEWAY_KEY, model = env.AI_MODEL) {
    this.client = new OpenAI({
      baseURL,
      apiKey,
    })
    this.model = model
  }

  async generateDailyDigest(metrics: MetricsSummary, apps?: MonitoredAppReport[]): Promise<string> {
    const prompt = `Você é um SRE Staff Engineer responsável pela infraestrutura do Sigapro e Gateway de Pagamentos Envolvati.
Analise os seguintes indicadores de telemetria das últimas 24h e gere um "Daily SRE Digest" para o time no Telegram.

Dados de Telemetria:
- Taxa de Erro HTTP 5xx: ${metrics.errorRate5xx}%
- Latência p95: ${metrics.latencyP95Seconds}s
- Latência p99: ${metrics.latencyP99Seconds}s

Status das Aplicações Monitoradas:
${apps ? JSON.stringify(apps, null, 2) : 'Não informado'}

Diretrizes:
- Use formato conciso e profissional em Markdown com bullet points e emojis adequados.
- Destaque o status de saúde geral do sistema e das aplicações individuais (Payments Gateway, API, App).
- Forneça 1 recomendação técnica preventiva se houver qualquer desvio.
- Mantenha a resposta com no máximo 15 linhas para leitura rápida no celular.`

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    })

    return response.choices[0]?.message?.content ?? 'Falha ao gerar digest com o AI Gateway.'
  }

  async analyzeIncidentTrace(
    trace: CompactTrace,
    contextAlert = 'Alerta de Anomalia',
  ): Promise<string> {
    const prompt = `Você é um SRE Staff Especialista em Diagnóstico de Incidentes e Tracing Distribuído OpenTelemetry.
O sistema disparou o seguinte alerta: "${contextAlert}".
Analise o Trace Distribuído capturado e determine a Causa Raiz (Root Cause Analysis - RCA).

Dados do Trace (Trace ID: ${trace.traceId}):
- Duração Total: ${trace.totalDurationMs}ms
- Spans Analisados: ${trace.spansCount}
- Contém Erros: ${trace.hasErrors ? 'SIM' : 'NÃO'}

Top Spans Críticos / Mais Lentos:
${JSON.stringify(trace.spans, null, 2)}

Diretrizes de Resposta:
1. Resumo do Incidente (1 linha).
2. Span Gargalo / Causa Raiz exata (identifique se a culpa foi de banco, rede externa PSP Pagarme, lock, ou erro na API).
3. Ação Recomendada Imediata.
Seja direto, técnico e evite termos genéricos.`

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    })

    return response.choices[0]?.message?.content ?? 'Falha ao analisar incidente com o AI Gateway.'
  }

  async analyzeSnapshot(
    userQuestion: string,
    metrics: MetricsSummary,
    recentErrors: LokiLogEntry[],
    apps: MonitoredAppReport[],
  ): Promise<string> {
    const prompt = `Você é o SRE Copilot do Sigapro e Envolvati Payments Gateway.
O engenheiro de plantão fez a seguinte pergunta no Telegram:
"${userQuestion}"

Aqui está o snapshot em tempo real da telemetria da nossa infraestrutura e das aplicações de negócio:

1. Status em Tempo Real das Aplicações de Negócio:
${JSON.stringify(apps, null, 2)}

2. Métricas Gerais (Prometheus):
- Taxa de erro 5xx: ${metrics.errorRate5xx}%
- Latência p95: ${metrics.latencyP95Seconds}s
- Latência p99: ${metrics.latencyP99Seconds}s

3. Últimos logs de erro capturados no Loki:
${recentErrors.length > 0 ? JSON.stringify(recentErrors, null, 2) : 'Nenhum log de erro crítico registrado nos últimos 15 min.'}

Diretrizes de Resposta:
- Responda diretamente e com precisão à pergunta do engenheiro.
- Se ele perguntou sobre uma aplicação específica (ex: 'como tá o payments gateway' ou 'como tá a api do sigapro'), dê um status cirúrgico focado exclusivamente nela (uptime, latência, se os workers estão rodando, se há erros recentes).
- Se houver workers parados ou erros no Loki, mencione exatamente o nome do worker ou o erro.
- Seja técnico, objetivo e use bullet points claros com emojis.`

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    })

    return response.choices[0]?.message?.content ?? 'Falha ao processar snapshot com o AI Gateway.'
  }
}
