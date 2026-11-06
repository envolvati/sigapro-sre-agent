import { env } from 'config/env'
import { AIGatewayClient } from 'ai/gateway'
import { AppsCollector } from 'collectors/apps'
import { LokiCollector } from 'collectors/loki'
import { checkMonitorsHealth } from 'collectors/probe'
import { setTimeout as sleep } from 'node:timers/promises'
import { DailyDigestUseCase } from 'usecases/daily-digest'
import { IncidentRCAUseCase } from 'usecases/incident-rca'
import { PrometheusCollector } from 'collectors/prometheus'
import { ServerCollector } from 'collectors/server'
import { DeploymentsCollector } from 'collectors/deployments'

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    message_thread_id?: number
    chat: { id: number | string }
    text?: string
    from?: { first_name?: string }
  }
}

export class TelegramListener {
  private isRunning = false
  private offset = 0
  private readonly botToken = env.TELEGRAM_BOT_TOKEN
  private readonly targetChatId = String(env.TELEGRAM_CHAT_ID)
  private readonly targetThreadId = env.TELEGRAM_THREAD_ID
    ? parseInt(env.TELEGRAM_THREAD_ID, 10)
    : undefined

  private readonly dailyDigest = new DailyDigestUseCase()
  private readonly incidentRCA = new IncidentRCAUseCase()
  private readonly prometheus = new PrometheusCollector()
  private readonly loki = new LokiCollector()
  private readonly apps = new AppsCollector()
  private readonly ai = new AIGatewayClient()
  private readonly server = new ServerCollector()

  async start() {
    this.isRunning = true
    console.log(
      '🤖 [TelegramListener] Long polling iniciado para comandos (/apps, /app, /snapshot, /health)...',
    )

    while (this.isRunning) {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.offset}&timeout=20`
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) {
          await sleep(3000)
          continue
        }

        const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] }
        if (!data.ok || !Array.isArray(data.result)) {
          continue
        }

        for (const update of data.result) {
          this.offset = update.update_id + 1
          if (update.message?.text) {
            await this.handleMessage(update.message)
          }
        }
      } catch (err: unknown) {
        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.message?.toLowerCase().includes('timeout'))
        if (!isTimeout) {
          console.warn(
            '[TelegramListener] Polling error, retrying in 3s...',
            err instanceof Error ? err.message : err,
          )
        }
        await sleep(3000)
      }
    }
  }

  stop() {
    this.isRunning = false
  }

  private async reply(
    chatId: string | number,
    text: string,
    replyToMsgId?: number,
    threadId?: number,
  ) {
    const targetThread = threadId ?? this.targetThreadId
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }
    if (replyToMsgId) body.reply_to_message_id = replyToMsgId
    if (targetThread) body.message_thread_id = targetThread

    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text()
        console.warn(
          `[TelegramListener] SendMessage Markdown failed (${res.status}): ${errText}. Retrying as plain text...`,
        )

        // Fallback: remove parse_mode se o markdown do LLM contiver entidades inválidas
        delete body.parse_mode
        const retryRes = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!retryRes.ok) {
          console.error(`[TelegramListener] Plain text retry also failed: ${await retryRes.text()}`)
        } else {
          console.log('[TelegramListener] Message delivered successfully as plain text fallback.')
        }
      } else {
        console.log('[TelegramListener] Message delivered successfully to Telegram.')
      }
    } catch (err: unknown) {
      console.error('[TelegramListener] Reply network error:', err)
    }
  }

  private async sendTyping(chatId: string | number, threadId?: number) {
    try {
      const targetThread = threadId ?? this.targetThreadId
      const body: Record<string, unknown> = { chat_id: chatId, action: 'typing' }
      if (targetThread) body.message_thread_id = targetThread

      await fetch(`https://api.telegram.org/bot${this.botToken}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      // Ignora erro de typing
    }
  }

  private async handleMessage(msg: NonNullable<TelegramUpdate['message']>) {
    const text = msg.text?.trim() ?? ''
    const chatId = String(msg.chat.id)

    // Apenas responde no chat configurado
    if (chatId !== this.targetChatId && !chatId.endsWith(this.targetChatId.replace(/^-100/, ''))) {
      return
    }

    if (!text.startsWith('/')) {
      return
    }

    const [cmdWithBot, ...args] = text.split(' ')
    const cmd = cmdWithBot.split('@')[0].toLowerCase()
    const query = args.join(' ').trim()
    const threadId = msg.message_thread_id

    console.log(
      `[TelegramListener] Incoming command: "${cmd}" from ${msg.from?.first_name ?? 'user'} (thread: ${threadId ?? 'root'})`,
    )

    await this.sendTyping(chatId, threadId)

    try {
      if (cmd === '/help' || cmd === '/start') {
        const helpMsg = `🤖 *SigaPro SRE Copilot — Guia de Comandos*

📦 *Aplicações de Negócio*
• \`/apps\` (ou \`/services\`) — Painel consolidado das aplicações (Gateway, API e App) com tempo de resposta, workers e alertas.

• \`/app <nome>\` — Raio-X detalhado de uma aplicação específica:
   ↳ \`/app payments\` (status dos 7 workers em background)
   ↳ \`/app sigapro\` (latência da API e erros recentes no Loki)
   ↳ \`/app front\` (latência do Next.js, memória Heap/RSS e erros no Loki)

• \`/deploys\` (ou \`/releases\`) — Histórico dos últimos deploys realizados pelo Coolify com status e autor.
🖥️ *Infraestrutura do Servidor*
• \`/server\` (ou \`/host\`) — Diagnóstico do servidor em tempo real (CPU, Load, RAM, Disco e Top aplicações que mais consom memória).
🧠 *Diagnóstico com Inteligência Artificial*
• \`/snapshot <sua pergunta>\` (ou \`/sre\`) — Cruza métricas do Prometheus, logs do Loki e status dos apps com o OmniRoute AI Gateway para responder qualquer dúvida técnica em linguagem natural.
   ↳ _Ex:_ \`/snapshot a api caiu?\` ou \`/snapshot o checkout tá lento?\`

• \`/trace <trace_id>\` — Busca a árvore de spans no Grafana Tempo e gera a Análise de Causa Raiz (RCA) explicando o span exato que travou.

📊 *Rotinas & Telemetria*
• \`/digest\` — Dispara sob demanda o Daily SRE Digest com o resumo executivo de uptime, taxa de erros e latência das últimas 24h.

• \`/health\` (ou \`/status\`) — Testa a conectividade interna e a latência de rede da stack de observabilidade (Prometheus, Tempo, Loki e OmniRoute).`
        return this.reply(chatId, helpMsg, msg.message_id, threadId)
      }

      if (cmd === '/apps' || cmd === '/services') {
        const appReports = await this.apps.getAllApps()
        let msgText = `📦 *Painel das Aplicações de Negócio:*\n\n`

        for (const app of appReports) {
          const icon = app.status === 'UP' ? '✅' : '❌'
          const latency = app.latencyMs !== undefined ? `(${app.latencyMs}ms)` : ''
          msgText += `${icon} *${app.name}*: ${app.status} ${latency}\n`
          msgText += `   ↳ _URL_: \`${app.url}\`\n`

          if (app.key?.startsWith('payments') && app.details?.workers) {
            const workers = app.details.workers as Record<
              string,
              { status: string; restarts: number }
            >
            const runningCount = Object.values(workers).filter(w => w.status === 'running').length
            const total = Object.keys(workers).length
            msgText += `   ↳ _Workers_: ${runningCount}/${total} ativos\n`
          }

          if (app.recentErrors && app.recentErrors.length > 0) {
            msgText += `   ⚠️ _Erros recentes no Loki_: ${app.recentErrors.length} ocorrência(s)\n`
          } else if (app.key === 'sigapro-api') {
            msgText += `   ↳ _Erros no Loki_: Nenhum nos últimos 15 min\n`
          }

          if (app.error) {
            msgText += `   ❌ _Erro_: ${app.error}\n`
          }
          msgText += `\n`
        }

        return this.reply(chatId, msgText, msg.message_id, threadId)
      }
      if (cmd === '/deploys' || cmd === '/releases') {
        const list = DeploymentsCollector.getInstance().getRecentDeployments(5)
        if (list.length === 0) {
          return this.reply(
            chatId,
            '📦 *Histórico de Deploys:* Nenhum deploy recente registrado nesta sessão.',
            msg.message_id,
            threadId,
          )
        }

        let text = `📦 *Últimos Deploys Registrados (CI/CD):*\n\n`
        for (const d of list) {
          const icon = d.status === 'SUCCESS' ? '🚀' : '🔴'
          text += `${icon} *${d.application}* (${d.environment})\n`
          if (d.commit) text += `   ↳ _Commit_: \`${d.commit}\` por ${d.author ?? 'desconhecido'}\n`
          if (d.triage?.summary) text += `   ↳ _Diagnóstico_: ${d.triage.summary}\n`
          text += `   ↳ _Hora_: ${d.timestamp}\n\n`
        }

        return this.reply(chatId, text, msg.message_id, threadId)
      }

      if (cmd === '/app') {
        const target = query.toLowerCase()
        if (!target) {
          return this.reply(
            chatId,
            '⚠️ Informe a aplicação. Exemplo: `/app payments` ou `/app sigapro`',
            msg.message_id,
            threadId,
          )
        }

        let report
        if (target.includes('pay') || target.includes('gate') || target.includes('envolv')) {
          const isHml = target.includes('hml') || target.includes('stag')
          report = await this.apps.checkPaymentsGateway(isHml ? 'hml' : 'prod')
        } else if (target.includes('api') || target.includes('back')) {
          report = await this.apps.checkSigaproApi()
        } else if (target.includes('front') || target.includes('app') || target.includes('web') || target.includes('next')) {
          report = await this.apps.checkSigaproApp()
        } else {
          report = await this.apps.checkSigaproApp()
        }

        const icon = report.status === 'UP' ? '✅' : '❌'
        let textRes = `${icon} *${report.name}*\n`
        textRes += `• Status: *${report.status}*\n`
        textRes += `• Latência: *${report.latencyMs ?? 0}ms*\n`
        textRes += `• URL: \`${report.url}\`\n`

        if (report.details?.workers) {
          textRes += `\n⚙️ *Workers em Background:*\n`
          const workers = report.details.workers as Record<
            string,
            { status: string; restarts: number }
          >
          for (const [wName, wData] of Object.entries(workers)) {
            const wIcon = wData.status === 'running' ? '•' : '⚠️'
            textRes += `  ${wIcon} \`${wName}\`: ${wData.status} (restarts: ${wData.restarts})\n`
          }
        }

        if (report.details?.memory) {
          const mem = report.details.memory as {
            heapUsedMB?: number
            heapTotalMB?: number
            rssMB?: number
          }
          textRes += `\n🧠 *Memória da Instância Node.js:*\n`
          textRes += `  • Heap Usada: \`${mem.heapUsedMB ?? 0} MB\` / \`${mem.heapTotalMB ?? 0} MB\`\n`
          textRes += `  • RSS Total: \`${mem.rssMB ?? 0} MB\`\n`
          if (report.details.uptimeSeconds) {
            const uptimeMin = Math.floor(Number(report.details.uptimeSeconds) / 60)
            textRes += `  • Uptime: \`${uptimeMin} min\`\n`
          }
        }

        if (report.recentErrors && report.recentErrors.length > 0) {
          textRes += `\n⚠️ *Últimos Logs de Erro no Loki:*\n`
          for (const err of report.recentErrors.slice(0, 3)) {
            textRes += `  - \`${err.line.slice(0, 120)}...\`\n`
          }
        }

        return this.reply(chatId, textRes, msg.message_id, threadId)
      }
      if (cmd === '/server' || cmd === '/host' || cmd === '/infra') {
        const serverStats = await this.server.getHostMetrics()
        let msgText = `🖥️ *Status do Servidor Host:*\n\n`
        msgText += `⚙️ *CPU / Carga:* ${serverStats.cpuCores} núcleos\n`
        msgText += `  • Load 1m: \`${serverStats.loadAvg['1m']}\` | 5m: \`${serverStats.loadAvg['5m']}\` | 15m: \`${serverStats.loadAvg['15m']}\`\n\n`

        msgText += `🧠 *Memória RAM:* ${serverStats.memory.usedPercent}% em uso\n`
        msgText += `  • Usada: \`${serverStats.memory.usedGB} GB\` / \`${serverStats.memory.totalGB} GB\`\n`
        msgText += `  • Livre: \`${serverStats.memory.freeGB} GB\`\n\n`

        msgText += `💾 *Disco Principal:* ${serverStats.disk.usedPercent}% em uso\n`
        msgText += `  • Usado: \`${serverStats.disk.usedGB} GB\` / \`${serverStats.disk.totalGB} GB\`\n`
        msgText += `  • Livre: \`${serverStats.disk.freeGB} GB\`\n`

        if (serverStats.containers.length > 0) {
          msgText += `\n📦 *Top Aplicações Consumindo RAM:*\n`
          for (const c of serverStats.containers.slice(0, 7)) {
            const memText = c.memoryGB >= 1 ? `${c.memoryGB} GB` : `${c.memoryMB} MB`
            msgText += `  • \`${c.name}\`: *${memText}*\n`
          }
        }

        return this.reply(chatId, msgText, msg.message_id, threadId)
      }


      if (cmd === '/health' || cmd === '/status') {
        const report = await checkMonitorsHealth()
        let msgText = `🔍 *Status da Infraestrutura de Observabilidade:*\n\n`
        for (const [name, target] of Object.entries(report.monitors)) {
          const icon = target.status === 'UP' ? '✅' : '❌'
          const latency = target.latencyMs !== undefined ? `(${target.latencyMs}ms)` : ''
          const errorMsg = target.error ? `\n   ↳ _${target.error}_` : ''
          msgText += `${icon} *${name.toUpperCase()}*: ${target.status} ${latency}${errorMsg}\n`
        }
        return this.reply(chatId, msgText, msg.message_id, threadId)
      }

      if (cmd === '/digest') {
        await this.reply(
          chatId,
          '⏳ Coletando métricas e gerando Daily Digest com o AI Gateway...',
          msg.message_id,
          threadId,
        )
        const res = await this.dailyDigest.execute()
        if (!res.success) {
          return this.reply(
            chatId,
            `❌ Erro ao gerar digest: ${res.error}`,
            msg.message_id,
            threadId,
          )
        }
        return
      }

      if (cmd === '/trace') {
        if (!query) {
          return this.reply(
            chatId,
            '⚠️ Informe o Trace ID. Exemplo: `/trace 4bf92f3577b34da6a3ce929d0e0e4736`',
            msg.message_id,
            threadId,
          )
        }
        await this.reply(
          chatId,
          `⏳ Puxando spans do trace \`${query}\` no Tempo...`,
          msg.message_id,
          threadId,
        )
        await this.incidentRCA.execute({
          alertName: 'Investigação Interativa via Telegram',
          traceId: query,
        })
        return
      }

      if (cmd === '/snapshot' || cmd === '/sre') {
        await this.sendTyping(chatId, threadId)
        const userPrompt =
          query || 'Faça um snapshot geral de erros e lentidões dos últimos 15 minutos.'

        console.log(`[TelegramListener] Running snapshot analysis for: "${userPrompt}"`)

        const [metrics, errors, appReports] = await Promise.all([
          this.prometheus.getRecentSummary(),
          this.loki.getRecentErrors(10),
          this.apps.getAllApps(),
        ])

        console.log('[TelegramListener] Data collected. Querying AI Gateway...')
        const answer = await this.ai.analyzeSnapshot(userPrompt, metrics, errors, appReports)
        console.log('[TelegramListener] AI answer received. Sending reply...')
        return this.reply(chatId, answer, msg.message_id, threadId)
      }
    } catch (cmdErr: unknown) {
      console.error('[TelegramListener] Command error:', cmdErr)
      const errMessage = cmdErr instanceof Error ? cmdErr.message : String(cmdErr)
      await this.reply(
        chatId,
        `❌ Erro ao processar comando: ${errMessage}`,
        msg.message_id,
        threadId,
      )
    }
  }
}
