import { PrometheusCollector } from '../collectors/prometheus.js'
import { AIGatewayClient } from '../ai/gateway.js'
import { TelegramNotifier } from '../notifiers/telegram.js'
import { AppsCollector } from '../collectors/apps.js'

export class DailyDigestUseCase {
  constructor(
    private readonly prometheus = new PrometheusCollector(),
    private readonly apps = new AppsCollector(),
    private readonly ai = new AIGatewayClient(),
    private readonly telegram = new TelegramNotifier(),
  ) {}

  async execute(): Promise<{ success: boolean; digest?: string; error?: string }> {
    try {
      console.log('[DailyDigestUseCase] Collecting telemetry metrics and app health...')
      const [metrics, appReports] = await Promise.all([
        this.prometheus.getRecentSummary(),
        this.apps.getAllApps(),
      ])

      console.log('[DailyDigestUseCase] Generating digest via OmniRoute AI Gateway...')
      const digest = await this.ai.generateDailyDigest(metrics, appReports)

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
