import { env } from 'config/env'

export class TelegramNotifier {
  private readonly botToken: string
  private readonly chatId: string
  private readonly threadId?: string

  constructor(
    botToken = env.TELEGRAM_BOT_TOKEN,
    chatId = env.TELEGRAM_CHAT_ID,
    threadId = env.TELEGRAM_THREAD_ID,
  ) {
    this.botToken = botToken
    this.chatId = chatId
    this.threadId = threadId
  }

  async sendMessage(
    text: string,
    options?: { threadId?: string | number; parseMode?: 'Markdown' | 'HTML' },
  ): Promise<boolean> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`
      const targetThread = options?.threadId !== undefined ? options.threadId : this.threadId
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text,
        parse_mode: options?.parseMode ?? 'Markdown',
      }

      if (targetThread) {
        body.message_thread_id =
          typeof targetThread === 'number' ? targetThread : parseInt(targetThread, 10)
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error(
          `[TelegramNotifier] Failed to send message (${response.status}): ${errorText}`,
        )
        return false
      }

      return true
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[TelegramNotifier] Error sending telegram message: ${message}`)
      return false
    }
  }
}
