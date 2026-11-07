import { env } from 'config/env'

export interface GitHubPullSummary {
  number: number
  title: string
  author: string
  url: string
  labels: string[]
  createdAt: string
  draft: boolean
}

export interface GitHubPullDetails extends GitHubPullSummary {
  body: string
  baseBranch: string
  headBranch: string
  changedFilesCount: number
}

export const REPO_ALIASES: Record<string, string> = {
  api: 'envolvati/sigapro-api',
  back: 'envolvati/sigapro-api',
  backend: 'envolvati/sigapro-api',
  'sigapro-api': 'envolvati/sigapro-api',

  front: 'envolvati/sigapro',
  app: 'envolvati/sigapro',
  frontend: 'envolvati/sigapro',
  sigapro: 'envolvati/sigapro',

  pay: 'envolvati/envolvati-payments-gateway',
  payments: 'envolvati/envolvati-payments-gateway',
  gateway: 'envolvati/envolvati-payments-gateway',
  'payments-gateway': 'envolvati/envolvati-payments-gateway',
}

export const MONITORED_REPOSITORIES = [
  { name: 'SigaPro API (Backend)', repo: 'envolvati/sigapro-api', alias: 'api' },
  { name: 'SigaPro Frontend', repo: 'envolvati/sigapro', alias: 'front' },
  { name: 'Payments Gateway', repo: 'envolvati/envolvati-payments-gateway', alias: 'pay' },
]

export const GITHUB_TELEGRAM_MAP: Record<string, string> = {
  wjuniorw: '@wjunior',
  'wjunior-envolvati': '@wjunior',
}

export function formatAuthorTag(githubLogin?: string): string {
  if (!githubLogin) return '@autor'
  return GITHUB_TELEGRAM_MAP[githubLogin.toLowerCase()] || `@${githubLogin}`
}

interface RawGitHubLabel {
  name: string
}

interface RawGitHubPull {
  number: number
  title: string
  body?: string | null
  user?: { login: string } | null
  html_url: string
  labels?: RawGitHubLabel[]
  created_at: string
  draft?: boolean
  base?: { ref: string }
  head?: { ref: string }
  changed_files?: number
}

interface RawGitHubFile {
  filename: string
}

export class GitHubCollector {
  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sigapro-sre-agent',
    }
  }

  async listOpenPullRequests(repoFullName: string): Promise<GitHubPullSummary[]> {
    if (!env.GITHUB_TOKEN) return []
    try {
      const url = `https://api.github.com/repos/${repoFullName}/pulls?state=open&per_page=10`
      const res = await fetch(url, { headers: this.headers })
      if (!res.ok) return []
      const data = (await res.json()) as RawGitHubPull[]
      return data.map(pr => ({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login || 'unknown',
        url: pr.html_url,
        labels: (pr.labels || []).map(l => l.name),
        createdAt: pr.created_at,
        draft: Boolean(pr.draft),
      }))
    } catch (err: unknown) {
      console.error(`[GitHubCollector] Failed to list PRs for ${repoFullName}:`, err)
      return []
    }
  }

  async getPullRequest(repoFullName: string, pullNumber: number): Promise<GitHubPullDetails | null> {
    if (!env.GITHUB_TOKEN) return null
    try {
      const url = `https://api.github.com/repos/${repoFullName}/pulls/${pullNumber}`
      const res = await fetch(url, { headers: this.headers })
      if (!res.ok) return null
      const pr = (await res.json()) as RawGitHubPull
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        author: pr.user?.login || 'unknown',
        url: pr.html_url,
        labels: (pr.labels || []).map(l => l.name),
        createdAt: pr.created_at,
        draft: Boolean(pr.draft),
        baseBranch: pr.base?.ref || 'main',
        headBranch: pr.head?.ref || 'staging',
        changedFilesCount: pr.changed_files || 0,
      }
    } catch (err: unknown) {
      console.error(`[GitHubCollector] Failed to get PR #${pullNumber} for ${repoFullName}:`, err)
      return null
    }
  }

  async getPullFiles(repoFullName: string, pullNumber: number): Promise<string[]> {
    if (!env.GITHUB_TOKEN) return []
    try {
      const url = `https://api.github.com/repos/${repoFullName}/pulls/${pullNumber}/files?per_page=30`
      const res = await fetch(url, { headers: this.headers })
      if (!res.ok) return []
      const files = (await res.json()) as RawGitHubFile[]
      return files.map(f => f.filename)
    } catch {
      return []
    }
  }
}
