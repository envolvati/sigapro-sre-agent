import { AIGatewayClient } from 'ai/gateway'
import { AppsCollector } from 'collectors/apps'
import { TelegramNotifier } from 'notifiers/telegram'
import { PrometheusCollector } from 'collectors/prometheus'
import { DeploymentsCollector } from 'collectors/deployments'

export class DailyDigestUseCase {
  constructor(
    private readonly prometheus = new PrometheusCollector(),
    private readonly apps = new AppsCollector(),
    private readonly ai = new AIGatewayClient(),
    private readonly telegram = new TelegramNotifier(),
    private readonly deployments = DeploymentsCollector.getInstance(),
  ) {}

  async execute(): Promise<{ success: boolean; digest?: string; error?: string }> {
    try {
      console.log('[DailyDigestUseCase] Collecting telemetry metrics, app health, and recent deploys...')
      const [metrics, appReports, recentDeploys] = await Promise.all([
        this.prometheus.getRecentSummary(),
        this.apps.getAllApps(),
        Promise.resolve(this.deployments.getRecentDeployments(3)),
      ])

      console.log('[DailyDigestUseCase] Generating digest via OmniRoute AI Gateway...')
      const digest = await this.ai.generateDailyDigest(metrics, appReports, recentDeploys)

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
