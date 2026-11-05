import OpenAI from 'openai'
import { env } from 'config/env'
import type { LokiLogEntry } from 'collectors/loki'
import type { CompactTrace } from 'collectors/tempo'
import type { MonitoredAppReport } from 'collectors/apps'
import type { MetricsSummary } from 'collectors/prometheus'

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
    const compactApps = apps?.map(app => {
      const item: Record<string, unknown> = {
        name: app.name,
        status: app.status,
        latencyMs: app.latencyMs,
      }
      if (app.error) {
        item.error = app.error
      }
      if (app.recentErrors && app.recentErrors.length > 0) {
        item.recentErrors = app.recentErrors.map(e => ({
          timestamp: e.timestamp,
          message: e.line.length > 180 ? `${e.line.slice(0, 180)}...` : e.line,
        }))
      }
      if (app.details) {
        item.details = app.details
      }
      return item
    })

    const prompt = `Você é um SRE Staff Engineer responsável pela infraestrutura do Sigapro e Gateway de Pagamentos Envolvati.
Analise os seguintes indicadores de telemetria das últimas 24h e gere um "Daily SRE Digest" para o time no Telegram.

Dados de Telemetria:
- Taxa de Erro HTTP 5xx: ${metrics.errorRate5xx}%
- Latência p95: ${metrics.latencyP95Seconds}s
- Latência p99: ${metrics.latencyP99Seconds}s

Status das Aplicações Monitoradas:
${compactApps ? JSON.stringify(compactApps, null, 2) : 'Não informado'}
- Use formato conciso e profissional em Markdown com bullet points e emojis adequados.
- Destaque o status de saúde geral do sistema e das aplicações individuais (Payments Gateway, API, App).
- Forneça 1 recomendação técnica preventiva se houver qualquer desvio.
- Mantenha a resposta com no máximo 15 linhas para leitura rápida no celular.`

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: false,
      })

      return response.choices[0]?.message?.content ?? 'Falha ao gerar digest com o AI Gateway.'
    } catch (err: unknown) {
      console.error('[AIGatewayClient] Error in generateDailyDigest:', err)
      return `❌ Erro ao consultar AI Gateway: ${err instanceof Error ? err.message : String(err)}`
    }
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

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        stream: false,
      })

      return (
        response.choices[0]?.message?.content ?? 'Falha ao analisar incidente com o AI Gateway.'
      )
    } catch (err: unknown) {
      console.error('[AIGatewayClient] Error in analyzeIncidentTrace:', err)
      return `❌ Erro ao consultar AI Gateway: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  async analyzeCrash(crashData: {
    project?: string
    title: string
    culprit?: string
    stack?: string
    level?: string
  }): Promise<string> {
    const prompt = `Você é um SRE Staff Especialista em Diagnóstico de Erros e Crashes do ecossistema SigaPro e Envolvati.
Um erro/exceção não tratada acabou de ocorrer na aplicação:
- Projeto/Aplicação: ${crashData.project ?? 'Desconhecido'}
- Título do Erro: ${crashData.title}
- Ponto de Falha (Culprit): ${crashData.culprit ?? 'Não especificado'}
- Nível: ${crashData.level ?? 'error'}
- Stack Trace:
${crashData.stack ?? 'Nenhuma stack trace disponível'}

Diretrizes da sua Análise:
1. Resumo do Crash (O que quebrou e impacto esperado para o usuário).
2. Provável Causa Raiz técnica (ex: payload nulo, variável indefinida, timeout de rede, erro de banco).
3. Sugestão exata de ação corretiva no código ou infraestrutura.
Responda de forma concisa (máximo 12 linhas) com bullet points claros para envio no Telegram.`

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        stream: false,
      })

      return response.choices[0]?.message?.content ?? 'Falha ao gerar diagnóstico com o AI Gateway.'
    } catch (err: unknown) {
      console.error('[AIGatewayClient] Error in analyzeCrash:', err)
      return `❌ Erro ao consultar AI Gateway: ${err instanceof Error ? err.message : String(err)}`
    }
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

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: false,
      })

      return (
        response.choices[0]?.message?.content ?? 'Falha ao processar snapshot com o AI Gateway.'
      )
    } catch (err: unknown) {
      console.error('[AIGatewayClient] Error in analyzeSnapshot:', err)
      return `❌ Erro ao consultar AI Gateway: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
