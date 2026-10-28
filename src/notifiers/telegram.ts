import { env } from '../config/env.js';

export class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly threadId?: string;

  constructor(
    botToken = env.TELEGRAM_BOT_TOKEN,
    chatId = env.TELEGRAM_CHAT_ID,
    threadId = env.TELEGRAM_THREAD_ID
  ) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.threadId = threadId;
  }

  async sendMessage(text: string): Promise<boolean> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text,
        parse_mode: 'Markdown',
      };

      if (this.threadId) {
        body.message_thread_id = parseInt(this.threadId, 10);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[TelegramNotifier] Failed to send message (${response.status}): ${errorText}`);
        return false;
      }

      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[TelegramNotifier] Error sending telegram message: ${message}`);
      return false;
    }
  }
}
