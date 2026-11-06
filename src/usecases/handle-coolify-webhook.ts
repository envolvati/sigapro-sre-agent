import { env } from 'config/env'
import { AIGatewayClient } from 'ai/gateway'
import { TelegramNotifier } from 'notifiers/telegram'
import { DeploymentsCollector, type DeploymentEvent } from 'collectors/deployments'

export interface CoolifyWebhookPayload {
  event: string
  application_name?: string
  application_uuid?: string
  deployment_uuid?: string
  environment?: string
  deployment_url?: string
  fqdn?: string
  server_name?: string
  message?: string
  success?: boolean
  logs?: string
  commit?: string
  commit_message?: string
  commit_author?: string
}

export class HandleCoolifyWebhookUseCase {
  constructor(
    private readonly ai = new AIGatewayClient(),
    private readonly telegram = new TelegramNotifier(),
    private readonly deployments = DeploymentsCollector.getInstance(),
  ) {}

  async execute(dto: CoolifyWebhookPayload): Promise<{ success: boolean; message: string }> {
    const isSuccess = dto.event === 'deployment_success' || dto.success === true
    const isFailure =
      dto.event === 'deployment_failed' || (dto.success === false && dto.event.includes('fail'))
    const appName = dto.application_name || 'Aplicação'
    const envName = dto.environment || 'production'
    const commit = dto.commit ? dto.commit.slice(0, 7) : undefined
    const author = dto.commit_author || this.extractAuthor(dto.commit_message)

    if (isFailure) {
      console.log(`[CoolifyWebhook] Processing build failure for ${appName} (${envName})...`)
      let rawLogs = dto.logs || ''

      if (!rawLogs && dto.deployment_uuid && env.COOLIFY_API_TOKEN) {
        rawLogs = await this.fetchCoolifyDeploymentLogs(dto.deployment_uuid)
      }

      const triage = await this.ai.triageBuildFailure({
        application: appName,
        environment: envName,
        commit,
        author,
        logs: rawLogs || dto.message || 'Nenhum log detalhado disponível.',
      })

      const event: DeploymentEvent = {
        id: dto.deployment_uuid || String(Date.now()),
        application: appName,
        environment: envName,
        commit,
        commitMessage: dto.commit_message,
        author,
        status: 'FAILED',
        timestamp: new Date().toISOString(),
        triage: {
          summary: triage.summary,
          rootCause: triage.rootCause,
          culpritFiles: triage.culpritFiles,
          harnessPrompt: triage.harnessPrompt,
        },
      }
      this.deployments.recordDeployment(event)

      let text = `🔴 *[RELEASE] Falha no Deploy / Build*\n\n`
      text += `📦 *Aplicação:* \`${appName}\` (${envName})\n`
      if (author) text += `👤 *Autor:* ${author}\n`
      if (commit) text += `🔖 *Commit:* \`${commit}\`\n`
      if (dto.deployment_url) text += `🛠️ *Deploy no Coolify:* [Ver detalhes](${dto.deployment_url})\n`

      text += `\n🔍 *Diagnóstico da IA:*\n`
      text += `• *Problema:* ${triage.summary}\n`
      text += `• *Causa:* ${triage.rootCause}\n`
      if (triage.culpritFiles.length > 0) {
        text += `• *Culpados:* ${triage.culpritFiles.map(f => `\`${f}\``).join(', ')}\n`
      }

      text += `\n🤖 *Copie para o seu Harness / Agente Local:*\n`
      text += `\`\`\`markdown\n${triage.harnessPrompt}\n\`\`\`\n`

      await this.telegram.sendMessage(text, {
        threadId: env.TELEGRAM_RELEASES_THREAD_ID,
      })

      return { success: true, message: 'Failure triaged and sent to releases topic' }
    }

    if (isSuccess) {
      console.log(`[CoolifyWebhook] Processing deploy success for ${appName} (${envName})...`)
      const event: DeploymentEvent = {
        id: dto.deployment_uuid || String(Date.now()),
        application: appName,
        environment: envName,
        commit,
        commitMessage: dto.commit_message,
        author,
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
      }
      this.deployments.recordDeployment(event)

      let text = `🚀 *[RELEASE] Deploy Concluído com Sucesso!*\n\n`
      text += `📦 *Aplicação:* \`${appName}\` (${envName})\n`
      if (author) text += `👤 *Autor:* ${author}\n`
      if (commit) text += `🔖 *Commit:* \`${commit}\`\n`
      if (dto.commit_message) {
        text += `\n📝 *Mensagem:* \`${dto.commit_message.trim()}\`\n`
      }
      if (dto.fqdn) {
        const url = dto.fqdn.startsWith('http') ? dto.fqdn : `https://${dto.fqdn}`
        text += `🔗 *URL:* [${url}](${url})\n`
      }

      await this.telegram.sendMessage(text, {
        threadId: env.TELEGRAM_RELEASES_THREAD_ID,
      })

      return { success: true, message: 'Success recorded and sent to releases topic' }
    }

    return { success: true, message: 'Event ignored or unhandled' }
  }

  private extractAuthor(commitMessage?: string): string {
    if (!commitMessage) return 'wjunior'
    const prMatch = commitMessage.match(/from\s+([^/\s]+)\//i)
    if (prMatch && prMatch[1]) return prMatch[1]
    const authorMatch = commitMessage.match(/author:\s*([^<\n]+)/i)
    if (authorMatch && authorMatch[1]) return authorMatch[1].trim()
    return 'wjunior'
  }

  private async fetchCoolifyDeploymentLogs(deploymentUuid: string): Promise<string> {
    try {
      const url = `${env.COOLIFY_API_URL.replace(/\/$/, '')}/deployments/${deploymentUuid}`
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${env.COOLIFY_API_TOKEN}`,
          Accept: 'application/json',
        },
      })
      if (!res.ok) return ''
      const data = (await res.json()) as { logs?: string }
      return data.logs ?? ''
    } catch {
      return ''
    }
  }
}
