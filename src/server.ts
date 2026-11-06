import Fastify from 'fastify'
import { env } from 'config/env'
import { checkMonitorsHealth } from 'collectors/probe'
import { DailyDigestUseCase } from 'usecases/daily-digest'
import { IncidentRCAUseCase } from 'usecases/incident-rca'
import { HandleCoolifyWebhookUseCase, type CoolifyWebhookPayload } from 'usecases/handle-coolify-webhook'
import { AuditPullRequestUseCase } from 'usecases/audit-pull-request'
import { DeploymentsCollector } from 'collectors/deployments'
import { TelegramListener } from './listeners/telegram.listener'
import { AIGatewayClient, type PRAuditInput } from './ai/gateway'
import { TelegramNotifier } from './notifiers/telegram'

const app = Fastify({ logger: true })

const dailyDigest = new DailyDigestUseCase()
const incidentRCA = new IncidentRCAUseCase()
const coolifyWebhook = new HandleCoolifyWebhookUseCase()
const auditPullRequest = new AuditPullRequestUseCase()
const telegramListener = new TelegramListener()
const aiGateway = new AIGatewayClient()
const telegramNotifier = new TelegramNotifier()

// Healthcheck com probe ativo em todos os monitores
app.get('/health', async (_req, reply) => {
  const report = await checkMonitorsHealth()
  const statusCode = report.status === 'DOWN' ? 503 : 200
  return reply.status(statusCode).send({
    service: 'sigapro-sre-agent',
    ...report,
  })
})

// Trigger manual do Daily Digest
app.post('/triggers/daily-digest', async (_req, reply) => {
  const result = await dailyDigest.execute()
  return reply.status(result.success ? 200 : 500).send(result)
})

// Webhook para alertas do Grafana Alerting / GlitchTip
app.post('/webhooks/grafana', async (req, reply) => {
  const body = req.body as Record<string, unknown> | null
  const title = typeof body?.title === 'string' ? body.title : 'Alerta Grafana'
  const state = typeof body?.state === 'string' ? body.state : 'alerting'

  if (state === 'ok') {
    app.log.info({ title }, 'Alerta normalizado')
    return reply.status(200).send({ status: 'ignored_ok' })
  }

  let traceId: string | undefined
  if (
    body?.commonLabels &&
    typeof body.commonLabels === 'object' &&
    'trace_id' in body.commonLabels
  ) {
    traceId = String(body.commonLabels.trace_id)
  }

  const result = await incidentRCA.execute({
    alertName: title,
    traceId,
    summary: typeof body?.message === 'string' ? body.message : undefined,
  })

  return reply.status(200).send(result)
})

// Webhook para alertas proativos de crash vindos do GlitchTip
app.post('/webhooks/glitchtip', async (req, reply) => {
  try {
    const body = req.body as Record<string, unknown> | null
    app.log.info({ body }, '[GlitchTip Webhook] Recebido alerta de crash')

    interface SlackAttachmentField {
      title?: string
      value?: string
      short?: boolean
    }
    interface SlackAttachment {
      title?: string
      title_link?: string
      text?: string
      fields?: SlackAttachmentField[]
    }

    const attachments = body?.attachments as SlackAttachment[] | undefined
    const firstAttachment = attachments?.[0]

    // Extrai projeto dos fields do attachment (formato Slack do GlitchTip)
    const attachmentProject = firstAttachment?.fields?.find(
      f => f.title?.toLowerCase() === 'project',
    )?.value

    const project =
      typeof body?.project_name === 'string'
        ? body.project_name
        : typeof (body?.project as Record<string, unknown>)?.name === 'string'
          ? String((body?.project as Record<string, unknown>).name)
          : attachmentProject ?? 'SigaPro'

    const issue = body?.issue as Record<string, unknown> | undefined
    const event = body?.event as Record<string, unknown> | undefined

    const title =
      typeof firstAttachment?.title === 'string'
        ? firstAttachment.title
        : typeof issue?.title === 'string'
          ? issue.title
          : typeof event?.title === 'string'
            ? event.title
            : typeof body?.text === 'string'
              ? body.text
              : 'Exceção não tratada capturada pelo GlitchTip'

    const culprit =
      typeof firstAttachment?.text === 'string'
        ? firstAttachment.text
        : typeof issue?.culprit === 'string'
          ? issue.culprit
          : typeof event?.culprit === 'string'
            ? event.culprit
            : undefined

    const link = firstAttachment?.title_link
    const level = typeof event?.level === 'string' ? event.level : 'error'

    let stack: string | undefined
    const excValues = (event?.exception as Record<string, unknown>)?.values as
      | Array<Record<string, unknown>>
      | undefined
    if (excValues && excValues.length > 0) {
      const frames = (excValues[0]?.stacktrace as Record<string, unknown>)?.frames as
        | Array<Record<string, unknown>>
        | undefined
      if (frames && frames.length > 0) {
        stack = frames
          .slice(-5)
          .map(
            f =>
              `  at ${f.function || 'anonymous'} (${f.filename || 'unknown'}:${f.lineno || '0'})`,
          )
          .join('\n')
      }
    }

    const rca = await aiGateway.analyzeCrash({
      project,
      title,
      culprit,
      stack,
      level,
    })

    let alertMessage = `🚨 *[Crash Proativo Detectado]*\n*Aplicação:* \`${project}\`\n*Erro:* ${title}\n`
    if (culprit) alertMessage += `*Local:* \`${culprit}\`\n`
    if (link) alertMessage += `*Issue GlitchTip:* [Ver detalhes da Issue](${link})\n`
    alertMessage += `\n${rca}`
    await telegramNotifier.sendMessage(alertMessage)

    return reply.status(200).send({ success: true, delivered: true })
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    app.log.error({ err }, '[GlitchTip Webhook] Erro ao processar crash')
    return reply.status(500).send({ success: false, error: errorMsg })
  }
})

// Análise sob demanda de um Trace específico
app.post('/analyze/trace/:traceId', async (req, reply) => {
  const { traceId } = req.params as { traceId: string }
  const result = await incidentRCA.execute({
    alertName: 'Análise Manual Solicitada via API',
    traceId,
  })
  return reply.status(result.success ? 200 : 500).send(result)
})

// Webhook de CI/CD para eventos de deploy do Coolify
app.post('/webhooks/coolify', async (req, reply) => {
  try {
    const body = req.body as CoolifyWebhookPayload
    app.log.info({ event: body?.event, app: body?.application_name }, '[Coolify Webhook] Recebido')
    const result = await coolifyWebhook.execute(body)
    return reply.status(200).send(result)
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    app.log.error(err, '[Coolify Webhook] Falha ao processar')
    return reply.status(500).send({ success: false, error: errorMsg })
  }
})

// Endpoint para triagem sob demanda de falhas de build com geração de prompt para o Harness
app.post('/analyze/build-failure', async (req, reply) => {
  try {
    const body = req.body as {
      application: string
      environment?: string
      commit?: string
      author?: string
      branch?: string
      logs: string
    }

    if (!body?.logs) {
      return reply.status(400).send({ error: 'Campo "logs" é obrigatório.' })
    }

    const triage = await aiGateway.triageBuildFailure({
      application: body.application || 'App',
      environment: body.environment || 'staging',
      commit: body.commit,
      author: body.author,
      branch: body.branch,
      logs: body.logs,
    })
    DeploymentsCollector.getInstance().recordDeployment({
      id: String(Date.now()),
      application: body.application || 'App',
      environment: body.environment || 'staging',
      commit: body.commit,
      author: body.author,
      branch: body.branch,
      status: 'FAILED',
      timestamp: new Date().toISOString(),
      triage: {
        summary: triage.summary,
        rootCause: triage.rootCause,
        culpritFiles: triage.culpritFiles,
        harnessPrompt: triage.harnessPrompt,
      },
    })

    return reply.status(200).send(triage)
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return reply.status(500).send({ error: errorMsg })
  }
})

// Webhook do GitHub para auditoria de Pull Requests
app.post('/webhooks/github', async (req, reply) => {
  try {
    const event = req.headers['x-github-event']
    const body = req.body as Record<string, unknown> | null

    if (event === 'pull_request' && body && typeof body === 'object') {
      const action = body.action as string
      if (action === 'opened' || action === 'edited' || action === 'synchronize') {
        const pr = body.pull_request as Record<string, unknown> | undefined
        const repo = body.repository as Record<string, unknown> | undefined
        const fullName = typeof repo?.full_name === 'string' ? repo.full_name : ''

        if (pr && fullName) {
          const result = await auditPullRequest.execute({
            repository: fullName,
            pullNumber: typeof pr.number === 'number' ? pr.number : 0,
            title: typeof pr.title === 'string' ? pr.title : '',
            body: typeof pr.body === 'string' ? pr.body : '',
            author: (pr.user as Record<string, unknown> | undefined)?.login as string | undefined,
            baseBranch: (pr.base as Record<string, unknown> | undefined)?.ref as string || 'main',
            headBranch: (pr.head as Record<string, unknown> | undefined)?.ref as string || 'staging',
            changedFilesCount: typeof pr.changed_files === 'number' ? pr.changed_files : undefined,
          })
          return reply.status(200).send(result)
        }
      }
    }

    return reply.status(200).send({ status: 'ignored' })
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    app.log.error(err, '[GitHub Webhook] Erro ao processar PR')
    return reply.status(500).send({ error: errorMsg })
  }
})

// Endpoint para auditoria sob demanda de PRs
app.post('/analyze/pr', async (req, reply) => {
  try {
    const body = req.body as PRAuditInput
    if (!body?.repository || !body?.pullNumber || !body?.title) {
      return reply.status(400).send({
        error: 'Campos obrigatórios ausentes: repository, pullNumber e title são necessários.',
      })
    }

    const result = await auditPullRequest.execute(body)
    return reply.status(200).send(result)
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return reply.status(500).send({ error: errorMsg })
  }
})

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' })
    console.log(`🚀 SRE AI Agent running on port ${env.PORT}`)

    // Inicia o listener interativo de comandos do Telegram em background
    telegramListener.start().catch(err => {
      console.error('Falha no listener do Telegram:', err)
    })

    // Executa o probe inicial de conectividade aos monitores
    console.log('\n🔍 [Boot] Checando conectividade com a stack de observabilidade...')
    const report = await checkMonitorsHealth()

    for (const [name, target] of Object.entries(report.monitors)) {
      const icon = target.status === 'UP' ? '✅' : '❌'
      const latency = target.latencyMs !== undefined ? `(${target.latencyMs}ms)` : ''
      const errorMsg = target.error ? `[${target.error}]` : ''
      console.log(
        `  ${icon} ${name.toUpperCase()} (${target.url}): ${target.status} ${latency} ${errorMsg}`.trim(),
      )
    }
    console.log('')
  } catch (err: unknown) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
