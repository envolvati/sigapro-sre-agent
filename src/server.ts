import Fastify from 'fastify';
import { env } from './config/env.js';
import { DailyDigestUseCase } from './usecases/daily-digest.js';
import { IncidentRCAUseCase } from './usecases/incident-rca.js';
import { checkMonitorsHealth } from './collectors/probe.js';

const app = Fastify({ logger: true });

const dailyDigest = new DailyDigestUseCase();
const incidentRCA = new IncidentRCAUseCase();

// Healthcheck com probe ativo em todos os monitores
app.get('/health', async (_req, reply) => {
  const report = await checkMonitorsHealth();
  const statusCode = report.status === 'DOWN' ? 503 : 200;
  return reply.status(statusCode).send({
    service: 'sigapro-sre-agent',
    ...report,
  });
});

// Trigger manual do Daily Digest
app.post('/triggers/daily-digest', async (_req, reply) => {
  const result = await dailyDigest.execute();
  return reply.status(result.success ? 200 : 500).send(result);
});

// Webhook para alertas do Grafana Alerting / GlitchTip
app.post('/webhooks/grafana', async (req, reply) => {
  const body = req.body as Record<string, unknown> | null;
  const title = typeof body?.title === 'string' ? body.title : 'Alerta Grafana';
  const state = typeof body?.state === 'string' ? body.state : 'alerting';

  if (state === 'ok') {
    app.log.info({ title }, 'Alerta normalizado');
    return reply.status(200).send({ status: 'ignored_ok' });
  }

  let traceId: string | undefined;
  if (body?.commonLabels && typeof body.commonLabels === 'object' && 'trace_id' in body.commonLabels) {
    traceId = String(body.commonLabels.trace_id);
  }

  const result = await incidentRCA.execute({
    alertName: title,
    traceId,
    summary: typeof body?.message === 'string' ? body.message : undefined,
  });

  return reply.status(200).send(result);
});

// Análise sob demanda de um Trace específico
app.post('/analyze/trace/:traceId', async (req, reply) => {
  const { traceId } = req.params as { traceId: string };
  const result = await incidentRCA.execute({
    alertName: 'Análise Manual Solicitada via API',
    traceId,
  });
  return reply.status(result.success ? 200 : 500).send(result);
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    console.log(`🚀 SRE AI Agent running on port ${env.PORT}`);

    // Executa o probe inicial de conectividade aos monitores
    console.log('\n🔍 [Boot] Checando conectividade com a stack de observabilidade...');
    const report = await checkMonitorsHealth();

    for (const [name, target] of Object.entries(report.monitors)) {
      const icon = target.status === 'UP' ? '✅' : '❌';
      const latency = target.latencyMs !== undefined ? `(${target.latencyMs}ms)` : '';
      const errorMsg = target.error ? `[${target.error}]` : '';
      console.log(`  ${icon} ${name.toUpperCase()} (${target.url}): ${target.status} ${latency} ${errorMsg}`.trim());
    }
    console.log('');
  } catch (err: unknown) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
