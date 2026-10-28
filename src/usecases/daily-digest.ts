import { PrometheusCollector } from 'collectors/prometheus'
import { AIGatewayClient } from 'ai/gateway'
import { TelegramNotifier } from 'notifiers/telegram'

export class DailyDigestUseCase {
  constructor(
    private readonly prometheus = new PrometheusCollector(),
    private readonly ai = new AIGatewayClient(),
    private readonly telegram = new TelegramNotifier(),
  ) {}

  async execute(): Promise<{ success: boolean; digest?: string; error?: string }> {
    try {
      console.log('[DailyDigestUseCase] Collecting telemetry metrics from Prometheus...')
      const metrics = await this.prometheus.getRecentSummary()

      console.log('[DailyDigestUseCase] Generating digest via OmniRoute AI Gateway...')
      const digest = await this.ai.generateDailyDigest(metrics)

      console.log('[DailyDigestUseCase] Sending digest to Telegram...')
      const sent = await this.telegram.sendMessage(digest)

      return {
        success: sent,
        digest,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[DailyDigestUseCase] Failed to execute daily digest: ${message}`)
      return {
        success: false,
        error: message,
      }
    }
  }
}
