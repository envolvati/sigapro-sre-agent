import OpenAI from 'openai'
import { env } from 'config/env'
import type { DailyLogsSummary, LokiLogEntry } from 'collectors/loki'
import type { CompactTrace } from 'collectors/tempo'
import type { MonitoredAppReport } from 'collectors/apps'
import type { MetricsSummary } from 'collectors/prometheus'
import type { DeploymentEvent, RecentDeploymentsReport } from 'collectors/deployments'

export interface DailyDigestExtras {
  logs24h?: DailyLogsSummary
  deploysReport?: RecentDeploymentsReport
  telemetryCoverage?: {
    tempoAvailable: boolean
    tempoServices: string[]
    prometheusServices: string[]
    lokiServices: string[]
  }
}
export interface BuildTriageAnalysis {
  summary: string
  rootCause: string
  culpritFiles: string[]
  harnessPrompt: string
}

export interface PRAuditInput {
  repository: string
  pullNumber: number
  title: string
  body?: string
  author?: string
  baseBranch: string
  headBranch: string
  changedFilesCount?: number
  changedFiles?: string[]
}

export interface PRAuditResult {
  isApproved: boolean
  score: number
  verdict: 'APPROVED' | 'NEEDS_WORK' | 'INCOMPLETE'
  summary: string
  checks: {
    titleConvention: { pass: boolean; feedback: string }
    problemDescription: { pass: boolean; feedback: string }
    validationEvidence: { pass: boolean; feedback: string }
    checklistAndScope: { pass: boolean; feedback: string }
  }
  missingItems: string[]
  commentMarkdown: string
}
export class AIGatewayClient {
  private readonly client: OpenAI
  private readonly model: string

  constructor(baseURL = env.AI_GATEWAY_URL, apiKey = env.AI_GATEWAY_KEY, model = env.AI_MODEL) {
    this.client = new OpenAI({
      baseURL,
      apiKey,
      maxRetries: 1,
      timeout: 60_000,
    })
    this.model = model
  }

  private async createCompletionWithFallback(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature = 0.1,
  ): Promise<string> {
    const modelsToTry = [...new Set([this.model, 'kc/openrouter/free', 'kilocode/openrouter/free'])]
    let lastError: unknown

    for (const model of modelsToTry) {
      try {
        const response = await this.client.chat.completions.create({
          model,
          messages,
          temperature,
          stream: false,
        })
        const content = response.choices[0]?.message?.content ?? ''
        if (content && !content.toLowerCase().includes('no longer supported')) {
          return content
        }
        console.warn(
          `[AIGatewayClient] Model ${model} returned unsupported upstream response, falling back...`,
        )
      } catch (err: unknown) {
        lastError = err
        console.warn(`[AIGatewayClient] Model ${model} failed, falling back: ${err}`)
      }
    }

    throw lastError || new Error('All AI models failed to generate completion')
  }

  async generateDailyDigest(
    metrics: MetricsSummary,
    apps?: MonitoredAppReport[],
    recentDeploys?: DeploymentEvent[],
    extras?: DailyDigestExtras,
  ): Promise<string> {
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
        item.recentErrors15m = app.recentErrors.map(e => ({
          timestamp: e.timestamp,
          message: e.line.length > 180 ? `${e.line.slice(0, 180)}...` : e.line,
        }))
      }
      if (app.details) {
        item.details = app.details
      }
      return item
    })

    const fmtMetric = (val: number | null, suffix: string) =>
      val !== null ? `${val}${suffix}` : 'INDISPONÍVEL (sem série compatível ou sem tráfego)'

    const logs24h = extras?.logs24h
    const logsSection = logs24h
      ? `Resumo Determinístico de Logs (Últimas ${logs24h.windowHours}h — Loki ${logs24h.lokiAvailable ? 'UP' : 'INDISPONÍVEL'}):
- Total de Erros: ${logs24h.totalErrors} | Warnings: ${logs24h.totalWarnings} | Ruído de scanner AUTH-12 suprimido: ${logs24h.suppressedScannerNoise}
- Clusters de Erros/Warnings agrupados (${logs24h.clusters.length}):
${
  logs24h.clusters.length > 0
    ? logs24h.clusters
        .map(c => `  • [${c.level} x${c.count}] ${c.service} (último: ${c.lastSeen}): ${c.sample}`)
        .join('\n')
    : '  Nenhum erro ou warning relevante registrado nas últimas 24h.'
}`
      : 'Resumo de logs 24h não fornecido.'

    const deploysReport = extras?.deploysReport
    const deploySourceNote = deploysReport?.note
      ? `\nNota da fonte (${deploysReport.source}): ${deploysReport.note}`
      : ''

    const coverage = extras?.telemetryCoverage
    const coverageSection = coverage
      ? `Cobertura OTel / SDKs Conectados:
- Tempo (Traces): ${coverage.tempoAvailable ? (coverage.tempoServices.length > 0 ? coverage.tempoServices.join(', ') : 'UP mas 0 serviços indexados') : 'INDISPONÍVEL'}
- Prometheus (Métricas): ${metrics.prometheusAvailable ? (coverage.prometheusServices.length > 0 ? coverage.prometheusServices.join(', ') : 'UP mas 0 serviços OTel/jobs encontrados') : 'INDISPONÍVEL'}
- Loki (service_name observados): ${coverage.lokiServices.length > 0 ? coverage.lokiServices.join(', ') : 'nenhum'}
- Métricas HTTP selecionadas no Prometheus: requests=${metrics.matchedMetrics.requestsMetric ?? 'nenhuma'}, latency=${metrics.matchedMetrics.latencyBucketMetric ?? 'nenhuma'}`
      : ''

    const prompt = `Você é um SRE Staff Engineer responsável pela infraestrutura do Sigapro e Gateway de Pagamentos Envolvati.
Analise os seguintes indicadores determinísticos das últimas 24h e gere um "Daily SRE Digest" para o time no Telegram.

Dados de Telemetria HTTP (Prometheus, janela ${metrics.window}):
- Total de Requests: ${metrics.requestsTotal !== null ? metrics.requestsTotal : 'INDISPONÍVEL'}
- Taxa de Erro HTTP 5xx: ${fmtMetric(metrics.errorRate5xx, '%')}
- Latência p95: ${fmtMetric(metrics.latencyP95Seconds, 's')}
- Latência p99: ${fmtMetric(metrics.latencyP99Seconds, 's')}

${coverageSection}

Status Atual das Aplicações Monitoradas:
${compactApps ? JSON.stringify(compactApps, null, 2) : 'Não informado'}

${logsSection}

Histórico de Deploys nas Últimas 24h (CI/CD):${deploySourceNote}
${
  recentDeploys && recentDeploys.length > 0
    ? recentDeploys
        .map(
          d =>
            `- [${d.status}] ${d.application} (${d.environment}) commit: ${d.commit ?? 'HEAD'}${d.author ? ` autor: ${d.author}` : ''}${d.commitMessage ? ` — ${d.commitMessage}` : ''} (${d.timestamp})`,
        )
        .join('\n')
    : 'Nenhum deploy registrado na janela de 24h.'
}

Diretrizes Obrigatórias (Anti-Alucinação):
- Use formato conciso e profissional em Markdown com bullet points e emojis adequados.
- NUNCA reporte "0% erros 5xx" ou "0s" se o campo estiver marcado como INDISPONÍVEL; diga explicitamente que a métrica está sem coleta/indisponível.
- NUNCA interprete \`heapAllocatedV8MB\` (\`heapTotal\`) do Node.js como limite máximo de heap — o V8 aloca sob demanda e expande automaticamente; NÃO recomende aumentar limite de heap por causa disso (cite apenas \`rssMB\` se relevante).
- Destaque os erros/warnings reais encontrados nos clusters das últimas 24h (ex: ORPHAN-05 no Payments, falhas de login, etc.), mesmo quando o /health HTTP está UP.
- Se a fonte de deploys indicar falta de token do Coolify (\`memory-only\`), avise que o histórico de deploys depende de webhooks em memória.
- Forneça 1 recomendação técnica prática baseada exclusivamente nos desvios reais observados.
- Mantenha a resposta com no máximo 18 linhas para leitura rápida no celular.`

    try {
      const content = await this.createCompletionWithFallback(
        [{ role: 'user', content: prompt }],
        0.2,
      )
      return content || 'Falha ao gerar digest com o AI Gateway.'
    } catch (err: unknown) {
      console.error('[AIGatewayClient] Error in generateDailyDigest:', err)
      return `❌ Erro ao consultar AI Gateway: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  async triageBuildFailure(params: {
    application: string
    environment: string
    branch?: string
    commit?: string
    author?: string
    logs: string
  }): Promise<BuildTriageAnalysis> {
    const prompt = `Você é um SRE Staff Engineer especialista em diagnóstico de pipelines CI/CD e compilações de software (Docker, Node.js, NestJS, Next.js, Go, pnpm).
O build de deploy falhou na aplicação "${params.application}" (${params.environment}) no commit "${params.commit ?? 'desconhecido'}" por "${params.author ?? 'desconhecido'}".

Logs do build:
"""
${params.logs.slice(-3500)}
"""

Analise os logs e produza uma triagem técnica e cirúrgica em formato JSON estrito:
{
  "summary": "Resumo de 1 linha da falha (ex: Erro de compilação TypeScript TS2339 no DTO de assinaturas)",
  "rootCause": "Explicação técnica de 1-2 frases identificando o porquê da falha",
  "culpritFiles": ["caminho/do/arquivo:linha (se identificado nos logs)"],
  "harnessPrompt": "Instrução auto-contida e direta para o desenvolvedor copiar e colar no assistente de IA local (Cursor, Claude, Harness) para aplicar a correção imediata"
}

Diretrizes:
- Seja extremamente específico: aponte o arquivo exato e linha com erro se constarem nos logs.
- No "harnessPrompt", escreva exatamente a instrução que você daria para o seu assistente de código local consertar o arquivo.
- Retorne APENAS o JSON puro, sem markdown ao redor.`

    try {
      const rawContent = await this.createCompletionWithFallback(
        [{ role: 'user', content: prompt }],
        0.1,
      )
      const firstBrace = rawContent.indexOf('{')
      const lastBrace = rawContent.lastIndexOf('}')
      const jsonStr =
        firstBrace !== -1 && lastBrace !== -1
          ? rawContent.slice(firstBrace, lastBrace + 1)
          : rawContent
              .replace(/^```json\s*/i, '')
              .replace(/```\s*$/i, '')
              .trim()
      const parsed = JSON.parse(jsonStr) as Partial<BuildTriageAnalysis>

      return {
        summary: parsed.summary || 'Falha na compilação do build',
        rootCause: parsed.rootCause || 'O processo de build falhou com código de erro não-zero.',
        culpritFiles: Array.isArray(parsed.culpritFiles) ? parsed.culpritFiles : [],
        harnessPrompt:
          parsed.harnessPrompt ||
          `Investigue e corrija o erro de build no commit ${params.commit ?? 'recente'}: ${params.logs.slice(-300)}`,
      }
    } catch (err: unknown) {
      console.error('[AIGatewayClient] Error in triageBuildFailure:', err)
      return {
        summary: 'Falha na compilação do build',
        rootCause: 'Não foi possível analisar os logs via AI Gateway.',
        culpritFiles: [],
        harnessPrompt: `O deploy da aplicação ${params.application} falhou com o seguinte erro:\n${params.logs.slice(-500)}`,
      }
    }
  }
  async auditPullRequest(input: PRAuditInput): Promise<PRAuditResult> {
    const prompt = `Você é o SRE & Quality Gatekeeper da Envolva TI.
Sua missão é auditar a descrição e a conformidade técnica do Pull Request #${input.pullNumber} no repositório "${input.repository}" (${input.headBranch} -> ${input.baseBranch}) aberto por @${input.author ?? 'desconhecido'}.

Título do PR:
"${input.title}"

Corpo da Descrição do PR:
"""
${input.body || '(Sem descrição fornecida)'}
"""

Arquivos alterados no PR (${input.changedFilesCount ?? input.changedFiles?.length ?? 0} arquivos):
${input.changedFiles ? input.changedFiles.slice(0, 30).join('\n') : 'Não informado'}

Régua de Rigor da Envolva TI:
1. Padrão de Título: Deve seguir estritamente Conventional Commits: tipo(escopo): descrição (ex: fix(subscriptions): ..., feat(docker): ...).
2. Descrição da Motivação: Deve explicar o que estava quebrado ou o objetivo da mudança de forma clara.
3. Evidências de Validação (Obrigatório):
   - Não basta marcar apenas "[x] Testes" ou "[x] Lint". Deve haver comprovação textual explícita (ex: número de testes passando, comando executado, confirmação de typecheck/tsc sem erros, build limpo).
   - Se nenhuma evidência textual foi anexada, a validação REPROVA (verdict: NEEDS_WORK).
4. Escopo & Dependências:
   - Se arquivos de dependências (package.json, pnpm-lock.yaml, go.mod, Dockerfile) foram alterados, o PR deve citar a atualização de dependências/runtime.

Retorne estritamente em formato JSON:
{
  "isApproved": boolean (true apenas se tiver evidências e seguir as convenções),
  "score": number (0 a 100),
  "verdict": "APPROVED" | "NEEDS_WORK" | "INCOMPLETE",
  "summary": "Resumo de 1 frase da avaliação",
  "checks": {
    "titleConvention": { "pass": boolean, "feedback": "string explicativa" },
    "problemDescription": { "pass": boolean, "feedback": "string explicativa" },
    "validationEvidence": { "pass": boolean, "feedback": "string explicativa" },
    "checklistAndScope": { "pass": boolean, "feedback": "string explicativa" }
  },
  "missingItems": ["Item 1 que falta", "Item 2 que falta"],
  "commentMarkdown": "Comentário completo e elegante em Markdown para ser postado diretamente no GitHub PR, cumprimentando o autor com @username, listando os pontos verificados com emojis (✅/⚠️/❌) e explicando objetivamente o que precisa ser ajustado para aprovação."
}

Diretrizes de Tom:
- Seja profissional, construtivo, incentivador e direto ao ponto.
- Retorne APENAS o JSON puro, sem blocos markdown externos.`

    try {
      const rawContent = await this.createCompletionWithFallback(
        [{ role: 'user', content: prompt }],
        0.1,
      )
      const firstBrace = rawContent.indexOf('{')
      const lastBrace = rawContent.lastIndexOf('}')
      const jsonStr =
        firstBrace !== -1 && lastBrace !== -1
          ? rawContent.slice(firstBrace, lastBrace + 1)
          : rawContent
              .replace(/^```json\s*/i, '')
              .replace(/```\s*$/i, '')
              .trim()
      const parsed = JSON.parse(jsonStr) as Partial<PRAuditResult>

      return {
        isApproved: Boolean(parsed.isApproved),
        score: typeof parsed.score === 'number' ? parsed.score : parsed.isApproved ? 100 : 50,
        verdict: parsed.verdict || (parsed.isApproved ? 'APPROVED' : 'NEEDS_WORK'),
        summary: parsed.summary || 'Avaliação de conformidade de PR concluída.',
        checks: parsed.checks || {
          titleConvention: { pass: true, feedback: 'Título aceito.' },
          problemDescription: { pass: true, feedback: 'Descrição aceita.' },
          validationEvidence: {
            pass: Boolean(parsed.isApproved),
            feedback: 'Evidências avaliadas.',
          },
          checklistAndScope: { pass: true, feedback: 'Checklist verificado.' },
        },
        missingItems: Array.isArray(parsed.missingItems) ? parsed.missingItems : [],
        commentMarkdown:
          parsed.commentMarkdown ||
          `🤖 **SigaPro PR Gatekeeper**\n\nPR #${input.pullNumber} avaliado. Status: ${parsed.isApproved ? '✅ Aprovado' : '⚠️ Pendências de evidência'}.`,
      }
    } catch (err: unknown) {
      console.error('[AIGatewayClient] Error in auditPullRequest:', err)
      return {
        isApproved: false,
        score: 0,
        verdict: 'NEEDS_WORK',
        summary: 'Falha ao executar auditoria via AI Gateway.',
        checks: {
          titleConvention: { pass: false, feedback: 'Não avaliado' },
          problemDescription: { pass: false, feedback: 'Não avaliado' },
          validationEvidence: { pass: false, feedback: 'Não avaliado' },
          checklistAndScope: { pass: false, feedback: 'Não avaliado' },
        },
        missingItems: ['Serviço de IA temporariamente indisponível para validação automática'],
        commentMarkdown: `🤖 **SigaPro PR Gatekeeper**\n\n⚠️ Não foi possível auditar o PR #${input.pullNumber} automaticamente neste momento.`,
      }
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
      const content = await this.createCompletionWithFallback(
        [{ role: 'user', content: prompt }],
        0.1,
      )

      return content || 'Falha ao analisar incidente com o AI Gateway.'
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
      const content = await this.createCompletionWithFallback(
        [{ role: 'user', content: prompt }],
        0.1,
      )

      return content || 'Falha ao gerar diagnóstico com o AI Gateway.'
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

2. Métricas Gerais (Prometheus, janela ${metrics.window}):
- Taxa de erro 5xx: ${metrics.errorRate5xx !== null ? `${metrics.errorRate5xx}%` : 'INDISPONÍVEL (sem série compatível)'}
- Latência p95: ${metrics.latencyP95Seconds !== null ? `${metrics.latencyP95Seconds}s` : 'INDISPONÍVEL'}
- Latência p99: ${metrics.latencyP99Seconds !== null ? `${metrics.latencyP99Seconds}s` : 'INDISPONÍVEL'}
- Serviços com métricas no Prometheus: ${metrics.connectedServices.length > 0 ? metrics.connectedServices.join(', ') : 'nenhum'}
3. Últimos logs de erro capturados no Loki:
${recentErrors.length > 0 ? JSON.stringify(recentErrors, null, 2) : 'Nenhum log de erro crítico registrado nos últimos 15 min.'}

Diretrizes de Resposta:
- Responda diretamente e com precisão à pergunta do engenheiro.
- Se ele perguntou sobre uma aplicação específica (ex: 'como tá o payments gateway' ou 'como tá a api do sigapro'), dê um status cirúrgico focado exclusivamente nela (uptime, latência, se os workers estão rodando, se há erros recentes).
- Se houver workers parados ou erros no Loki, mencione exatamente o nome do worker ou o erro.
- Seja técnico, objetivo e use bullet points claros com emojis.`

    try {
      const content = await this.createCompletionWithFallback(
        [{ role: 'user', content: prompt }],
        0.2,
      )

      return content || 'Falha ao processar snapshot com o AI Gateway.'
    } catch (err: unknown) {
      console.error('[AIGatewayClient] Error in analyzeSnapshot:', err)
      return `❌ Erro ao consultar AI Gateway: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
