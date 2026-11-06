import { env } from 'config/env'
import { AIGatewayClient, type PRAuditInput, type PRAuditResult } from 'ai/gateway'
import { TelegramNotifier } from 'notifiers/telegram'

export class AuditPullRequestUseCase {
  constructor(
    private readonly ai = new AIGatewayClient(),
    private readonly telegram = new TelegramNotifier(),
  ) {}

  async execute(input: PRAuditInput): Promise<PRAuditResult> {
    console.log(
      `[PRAudit] Running AI quality audit for PR #${input.pullNumber} on ${input.repository}...`,
    )

    const audit = await this.ai.auditPullRequest(input)

    // 1. Posta comentário no GitHub se GITHUB_TOKEN estiver configurado
    if (env.GITHUB_TOKEN) {
      await this.postGitHubComment(input.repository, input.pullNumber, audit.commentMarkdown)
      await this.setGitHubLabels(input.repository, input.pullNumber, audit.isApproved)
    }

    // 2. Notifica no Telegram no tópico de Releases (284)
    const statusEmoji = audit.isApproved ? '✅' : '⚠️'
    const verdictText = audit.isApproved ? 'APROVADO' : 'PENDENTE DE EVIDÊNCIAS'

    let text = `🤖 *[PR GATEKEEPER] PR #${input.pullNumber} Auditado*\n\n`
    text += `📦 *Repositório:* \`${input.repository}\` (\`${input.headBranch}\` → \`${input.baseBranch}\`)\n`
    if (input.author) text += `👤 *Autor:* @${input.author}\n`
    text += `🔖 *Título:* \`${input.title}\`\n\n`
    text += `🎯 *Veredito:* ${statusEmoji} *${verdictText}* (Nota: ${audit.score}/100)\n`
    text += `📝 *Resumo:* ${audit.summary}\n`

    if (audit.missingItems && audit.missingItems.length > 0) {
      text += `\n⚠️ *Itens a ajustar:*\n`
      for (const item of audit.missingItems) {
        text += `• ${item}\n`
      }
    }

    text += `\n🔗 [Ver Pull Request no GitHub](https://github.com/${input.repository}/pull/${input.pullNumber})\n`

    await this.telegram.sendMessage(text, {
      threadId: env.TELEGRAM_RELEASES_THREAD_ID,
    })

    return audit
  }

  private async postGitHubComment(
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<boolean> {
    try {
      const url = `https://api.github.com/repos/${repo}/issues/${pullNumber}/comments`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'sigapro-sre-agent-gatekeeper',
        },
        body: JSON.stringify({ body }),
      })

      if (!res.ok) {
        const errorText = await res.text()
        console.warn(`[PRAudit] Failed to post GitHub comment (${res.status}): ${errorText}`)
        return false
      }

      console.log(`[PRAudit] Comment successfully posted to PR #${pullNumber} on ${repo}`)
      return true
    } catch (err: unknown) {
      console.warn(`[PRAudit] Error posting GitHub comment: ${err}`)
      return false
    }
  }

  private async setGitHubLabels(
    repo: string,
    pullNumber: number,
    isApproved: boolean,
  ): Promise<void> {
    try {
      const label = isApproved ? 'status: ready-for-review' : 'status: needs-evidence'
      const url = `https://api.github.com/repos/${repo}/issues/${pullNumber}/labels`
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'sigapro-sre-agent-gatekeeper',
        },
        body: JSON.stringify({ labels: [label] }),
      })
    } catch {
      // Ignora erro de label silenciosamente se a permissão não for suficiente
    }
  }
}
