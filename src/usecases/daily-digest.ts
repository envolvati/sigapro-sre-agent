import { AIGatewayClient } from 'ai/gateway'
import { AppsCollector } from 'collectors/apps'
import { TelegramNotifier } from 'notifiers/telegram'
import { PrometheusCollector } from 'collectors/prometheus'
import { DeploymentsCollector } from 'collectors/deployments'
import { LokiCollector } from 'collectors/loki'
import { TempoCollector } from 'collectors/tempo'

export class DailyDigestUseCase {
  constructor(
    private readonly prometheus = new PrometheusCollector(),
    private readonly apps = new AppsCollector(),
    private readonly ai = new AIGatewayClient(),
    private readonly telegram = new TelegramNotifier(),
    private readonly deployments = DeploymentsCollector.getInstance(),
    private readonly loki = new LokiCollector(),
    private readonly tempo = new TempoCollector(),
  ) {}

  async execute(): Promise<{ success: boolean; digest?: string; error?: string }> {
    try {
      console.log(
        '[DailyDigestUseCase] Collecting 24h telemetry, clustered logs, apps, and deploys...',
      )
      const [metrics, logs24h, appReports, deploysReport, tempoStatus] = await Promise.all([
        this.prometheus.getRecentSummary('24h'),
        this.loki.getDailyErrorWarningSummary({ windowHours: 24, maxClusters: 18 }),
        this.apps.getAllApps(),
        this.deployments.getRecentDeployments24h(24),
        this.tempo.getConnectedServices(),
      ])

      console.log(
        `[DailyDigestUseCase] 24h deterministic bundle ready: ${logs24h.totalErrors} errors, ${logs24h.totalWarnings} warnings (${logs24h.clusters.length} clusters), ${deploysReport.deployments.length} deploys (${deploysReport.source}).`,
      )

      console.log('[DailyDigestUseCase] Generating digest via OmniRoute AI Gateway...')
      const digest = await this.ai.generateDailyDigest(
        metrics,
        appReports,
        deploysReport.deployments,
        {
          logs24h,
          deploysReport,
          telemetryCoverage: {
            tempoAvailable: tempoStatus.available,
            tempoServices: tempoStatus.services,
            prometheusServices: metrics.connectedServices,
            lokiServices: logs24h.observedServicesInLoki,
          },
        },
      )

      console.log('[DailyDigestUseCase] Sending digest to Telegram...')
      const sent = await this.telegram.sendMessage(digest)

      if (!sent) {
        return {
          success: false,
          digest,
          error: 'Falha ao enviar mensagem para o Telegram.',
        }
      }

      return {
        success: true,
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
