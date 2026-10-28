import { setTimeout as sleep } from 'node:timers/promises'
import { env } from '../config/env.js'
import { checkMonitorsHealth } from '../collectors/probe.js'
import { DailyDigestUseCase } from '../usecases/daily-digest.js'
import { IncidentRCAUseCase } from '../usecases/incident-rca.js'
import { PrometheusCollector } from '../collectors/prometheus.js'
import { LokiCollector } from '../collectors/loki.js'
import { AIGatewayClient } from '../ai/gateway.js'

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
  private readonly ai = new AIGatewayClient()

  async start() {
    this.isRunning = true
    console.log(
      '🤖 [TelegramListener] Long polling iniciado para comandos (/health, /digest, /trace, /snapshot)...',
    )

    while (this.isRunning) {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.offset}&timeout=25`
        const res = await fetch(url)
        if (!res.ok) {
          await sleep(5000)
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
        console.warn(
          '[TelegramListener] Polling error, retrying in 5s...',
          err instanceof Error ? err.message : err,
        )
        await sleep(5000)
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
    try {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }
      if (replyToMsgId) body.reply_to_message_id = replyToMsgId
      if (threadId ?? this.targetThreadId) body.message_thread_id = threadId ?? this.targetThreadId

      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err: unknown) {
      console.error('[TelegramListener] Reply error:', err)
    }
  }

  private async sendTyping(chatId: string | number, threadId?: number) {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, action: 'typing' }
      if (threadId ?? this.targetThreadId) body.message_thread_id = threadId ?? this.targetThreadId

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

    await this.sendTyping(chatId, threadId)

    if (cmd === '/help' || cmd === '/start') {
      const helpMsg = `🤖 *SigaPro SRE Copilot - Comandos Disponíveis:*

• \`/health\` ou \`/status\` - Testa a conectividade dos monitores em tempo real
• \`/digest\` - Dispara o resumo matinal (Daily SRE Digest)
• \`/trace <trace_id>\` - Diagnostica um Trace com RCA do AI Gateway
• \`/snapshot <sua pergunta>\` - Consulta métricas + logs e responde dúvidas sobre erros recentes`
      return this.reply(chatId, helpMsg, msg.message_id, threadId)
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
        return this.reply(chatId, `❌ Erro ao gerar digest: ${res.error}`, msg.message_id, threadId)
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

      const [metrics, errors] = await Promise.all([
        this.prometheus.getRecentSummary(),
        this.loki.getRecentErrors(10),
      ])

      const answer = await this.ai.analyzeSnapshot(userPrompt, metrics, errors)
      return this.reply(chatId, answer, msg.message_id, threadId)
    }
  }
}
