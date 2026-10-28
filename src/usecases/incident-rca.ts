import { TempoCollector } from '../collectors/tempo.js';
import { AIGatewayClient } from '../ai/gateway.js';
import { TelegramNotifier } from '../notifiers/telegram.js';

export interface IncidentAlertPayload {
  alertName: string;
  traceId?: string;
  summary?: string;
}

export class IncidentRCAUseCase {
  constructor(
    private readonly tempo = new TempoCollector(),
    private readonly ai = new AIGatewayClient(),
    private readonly telegram = new TelegramNotifier()
  ) {}

  async execute(payload: IncidentAlertPayload): Promise<{ success: boolean; rca?: string; error?: string }> {
    try {
      console.log(`[IncidentRCAUseCase] Received alert: ${payload.alertName}`);

      if (!payload.traceId) {
        const fallbackMsg = `🚨 *[Alerta de Incidente]*: ${payload.alertName}\n${payload.summary ?? 'Nenhum trace ID foi anexado ao alerta.'}`;
        await this.telegram.sendMessage(fallbackMsg);
        return { success: true, rca: fallbackMsg };
      }

      console.log(`[IncidentRCAUseCase] Fetching distributed trace: ${payload.traceId}...`);
      const trace = await this.tempo.getTrace(payload.traceId);

      let rcaMessage: string;
      if (!trace) {
        rcaMessage = `🚨 *[Alerta de Incidente]*: ${payload.alertName}\nTrace ID: \`${payload.traceId}\`\n_(Trace não localizado no Tempo ou já expirado)_`;
      } else {
        console.log('[IncidentRCAUseCase] Analyzing trace with OmniRoute AI Gateway...');
        const analysis = await this.ai.analyzeIncidentTrace(trace, payload.alertName);
        rcaMessage = `🚨 *[Diagnóstico Automatizado de Incidente]*\n*Alerta:* ${payload.alertName}\n*Trace ID:* \`${payload.traceId}\`\n\n${analysis}`;
      }

      console.log('[IncidentRCAUseCase] Sending incident RCA to Telegram...');
      const sent = await this.telegram.sendMessage(rcaMessage);

      return {
        success: sent,
        rca: rcaMessage,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[IncidentRCAUseCase] Failed to execute incident RCA: ${message}`);
      return {
        success: false,
        error: message,
      };
    }
  }
}
