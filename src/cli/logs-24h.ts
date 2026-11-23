import { LokiCollector } from 'collectors/loki'
import { PrometheusCollector } from 'collectors/prometheus'
import { TempoCollector } from 'collectors/tempo'
import { DeploymentsCollector } from 'collectors/deployments'

async function main() {
  const hoursArg = Number(process.argv[2] ?? 24)
  const windowHours = Number.isFinite(hoursArg) && hoursArg > 0 ? hoursArg : 24

  const loki = new LokiCollector()
  const prometheus = new PrometheusCollector()
  const tempo = new TempoCollector()
  const deployments = DeploymentsCollector.getInstance()

  const [logs, metrics, tempoCoverage, deploys] = await Promise.all([
    loki.getDailyErrorWarningSummary({ windowHours, maxClusters: 25 }),
    prometheus.getRecentSummary(`${windowHours}h`),
    tempo.getConnectedServices(),
    deployments.getRecentDeployments24h(windowHours),
  ])

  console.log(
    JSON.stringify(
      {
        windowHours,
        logs,
        metrics,
        tempoCoverage,
        deploys,
      },
      null,
      2,
    ),
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
