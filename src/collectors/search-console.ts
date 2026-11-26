import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { env } from 'config/env'

export interface SeoQueryItem {
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  domain?: string
}

export interface SeoSiteReport {
  siteUrl: string
  cleanName: string
  clicks: number
  impressions: number
  ctr: number
  avgPosition: number
  topQueries: SeoQueryItem[]
  error?: string
}

export interface SeoPortfolioReport {
  updatedAt: string
  periodDays: number
  serviceAccount: string
  fromCache?: boolean
  summary: {
    totalSites: number
    totalImpressions: number
    totalClicks: number
    overallCtr: number
  }
  sites: SeoSiteReport[]
  topRankedQueries: SeoQueryItem[]
}

export interface UrlInspectionReport {
  url: string
  siteUrl: string
  verdict: string
  coverageState: string
  robotsTxtState?: string
  indexingState?: string
  lastCrawlTime?: string
  pageFetchState?: string
  googleCanonical?: string
  userCanonical?: string
  crawledAs?: string
  error?: string
}

interface ServiceAccountKey {
  client_email: string
  private_key: string
  project_id?: string
}

export class SearchConsoleCollector {
  private static instance: SearchConsoleCollector | null = null

  private cachedToken: { token: string; expiresAt: number } | null = null
  private cachedSummary: { data: SeoPortfolioReport; expiresAt: number } | null = null
  private readonly defaultCacheTtlMs = 60 * 60 * 1000 // 1 hora de cache em memória

  public static getInstance(): SearchConsoleCollector {
    if (!SearchConsoleCollector.instance) {
      SearchConsoleCollector.instance = new SearchConsoleCollector()
    }
    return SearchConsoleCollector.instance
  }

  private resolveKey(): { key: ServiceAccountKey; path: string } {
    const rawCred = env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
    if (rawCred) {
      // 1. Tenta interpretar como JSON direto
      if (rawCred.startsWith('{') && rawCred.endsWith('}')) {
        try {
          const parsed = JSON.parse(rawCred) as ServiceAccountKey
          if (parsed.client_email && parsed.private_key) {
            return { key: parsed, path: 'inline:GOOGLE_APPLICATION_CREDENTIALS' }
          }
        } catch {
          // segue para outras tentativas
        }
      }

      // 2. Tenta interpretar como Base64 de JSON
      try {
        const decoded = Buffer.from(rawCred, 'base64').toString('utf-8').trim()
        if (decoded.startsWith('{') && decoded.endsWith('}')) {
          const parsed = JSON.parse(decoded) as ServiceAccountKey
          if (parsed.client_email && parsed.private_key) {
            return { key: parsed, path: 'base64:GOOGLE_APPLICATION_CREDENTIALS' }
          }
        }
      } catch {
        // segue para arquivo
      }
    }

    const candidates = [
      rawCred,
      path.join(process.env.HOME || '', '.gcp', 'gsc-credentials.json'),
      path.join(
        process.env.HOME || '',
        'Downloads',
        'gen-lang-client-0329877599-6c78267cc103.json',
      ),
    ].filter(Boolean) as string[]

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8')
          const parsed = JSON.parse(content) as ServiceAccountKey
          if (parsed.client_email && parsed.private_key) {
            return { key: parsed, path: p }
          }
        } catch {
          // segue para a próxima tentativa
        }
      }
    }

    throw new Error(
      'Credenciais do Google Search Console não encontradas. Configure GOOGLE_APPLICATION_CREDENTIALS no .env com o caminho do arquivo JSON, JSON inline ou Base64',
    )
  }

  public async getAccessToken(
    scope = 'https://www.googleapis.com/auth/webmasters.readonly openid',
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    if (this.cachedToken && this.cachedToken.expiresAt > now + 300) {
      return this.cachedToken.token
    }

    const { key } = this.resolveKey()
    const header = { alg: 'RS256', typ: 'JWT' }
    const claim = {
      iss: key.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
    const claimB64 = Buffer.from(JSON.stringify(claim)).toString('base64url')
    const unsignedToken = `${headerB64}.${claimB64}`
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(unsignedToken)
    const signature = signer.sign(key.private_key, 'base64url')
    const assertion = `${unsignedToken}.${signature}`

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    })

    const data = (await res.json()) as { access_token?: string; error?: string }
    if (!res.ok || !data.access_token) {
      throw new Error(`Falha ao obter token OAuth do Google: ${JSON.stringify(data)}`)
    }

    this.cachedToken = {
      token: data.access_token,
      expiresAt: now + 3600,
    }

    return data.access_token
  }

  async listSites(): Promise<string[]> {
    const token = await this.getAccessToken()
    const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      throw new Error(`Erro ao listar sites do Search Console: ${res.statusText}`)
    }

    const data = (await res.json()) as { siteEntry?: { siteUrl: string }[] }
    return (data.siteEntry || []).map(s => s.siteUrl)
  }

  async getSiteAnalytics(siteUrl: string, days = 30): Promise<SeoSiteReport> {
    const token = await this.getAccessToken()
    const endDate = new Date().toISOString().slice(0, 10)
    const startDate = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const cleanName = siteUrl.replace('sc-domain:', '').replace('https://', '').replace('/', '')

    // 1. Totalizadores do domínio
    const totalRes = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ startDate, endDate }),
      },
    )

    interface SearchRow {
      keys: string[]
      clicks: number
      impressions: number
      ctr: number
      position: number
    }

    const totalData = (await totalRes.json()) as { rows?: SearchRow[] }
    const totals = totalData.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 }

    // 2. Top consultas
    const queryRes = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate,
          endDate,
          dimensions: ['query'],
          rowLimit: 5,
        }),
      },
    )

    const queryData = (await queryRes.json()) as { rows?: SearchRow[] }
    const topQueries = (queryData.rows || []).map(row => ({
      query: row.keys[0],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: Number((row.ctr * 100).toFixed(1)),
      position: Number(row.position.toFixed(1)),
    }))

    return {
      siteUrl,
      cleanName,
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr: Number(((totals.ctr || 0) * 100).toFixed(1)),
      avgPosition: Number((totals.position || 0).toFixed(1)),
      topQueries,
    }
  }

  async getPortfolioSummary(days = 30, forceRefresh = false): Promise<SeoPortfolioReport> {
    const now = Date.now()

    if (!forceRefresh && this.cachedSummary && this.cachedSummary.expiresAt > now) {
      return {
        ...this.cachedSummary.data,
        fromCache: true,
      }
    }

    const { key } = this.resolveKey()
    const sites = await this.listSites()

    const results: SeoSiteReport[] = []
    let totalImpressions = 0
    let totalClicks = 0

    for (const siteUrl of sites) {
      try {
        const stats = await this.getSiteAnalytics(siteUrl, days)
        results.push(stats)
        totalImpressions += stats.impressions
        totalClicks += stats.clicks
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        results.push({
          siteUrl,
          cleanName: siteUrl.replace('sc-domain:', '').replace('https://', '').replace('/', ''),
          clicks: 0,
          impressions: 0,
          ctr: 0,
          avgPosition: 0,
          topQueries: [],
          error: errorMsg,
        })
      }
    }

    const allQueries = results
      .flatMap(s => (s.topQueries || []).map(q => ({ ...q, domain: s.cleanName })))
      .sort((a, b) => b.impressions - a.impressions)

    const report: SeoPortfolioReport = {
      updatedAt: new Date().toISOString(),
      periodDays: days,
      serviceAccount: key.client_email,
      fromCache: false,
      summary: {
        totalSites: sites.length,
        totalImpressions,
        totalClicks,
        overallCtr:
          totalImpressions > 0 ? Number(((totalClicks / totalImpressions) * 100).toFixed(2)) : 0,
      },
      sites: results,
      topRankedQueries: allQueries.slice(0, 10),
    }

    this.cachedSummary = {
      data: report,
      expiresAt: now + this.defaultCacheTtlMs,
    }

    return report
  }

  async inspectUrl(inspectionUrl: string, siteUrl?: string): Promise<UrlInspectionReport> {
    const token = await this.getAccessToken()

    let resolvedSiteUrl = siteUrl
    if (!resolvedSiteUrl) {
      const urlObj = new URL(inspectionUrl)
      resolvedSiteUrl = `sc-domain:${urlObj.hostname}`
    }

    const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inspectionUrl,
        siteUrl: resolvedSiteUrl,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      return {
        url: inspectionUrl,
        siteUrl: resolvedSiteUrl,
        verdict: 'FAIL',
        coverageState: `Inspection API error: ${res.status}`,
        error: errText,
      }
    }

    interface InspectionResultPayload {
      inspectionResult?: {
        indexStatusResult?: {
          verdict?: string
          coverageState?: string
          robotsTxtState?: string
          indexingState?: string
          lastCrawlTime?: string
          pageFetchState?: string
          googleCanonical?: string
          userCanonical?: string
          crawledAs?: string
        }
      }
    }

    const data = (await res.json()) as InspectionResultPayload
    const status = data.inspectionResult?.indexStatusResult

    return {
      url: inspectionUrl,
      siteUrl: resolvedSiteUrl,
      verdict: status?.verdict || 'UNKNOWN',
      coverageState: status?.coverageState || 'UNKNOWN',
      robotsTxtState: status?.robotsTxtState,
      indexingState: status?.indexingState,
      lastCrawlTime: status?.lastCrawlTime,
      pageFetchState: status?.pageFetchState,
      googleCanonical: status?.googleCanonical,
      userCanonical: status?.userCanonical,
      crawledAs: status?.crawledAs,
    }
  }

  async checkMonitoredIndexStatus(): Promise<UrlInspectionReport[]> {
    const targets = [
      { url: 'https://sigapro.com/', siteUrl: 'sc-domain:sigapro.com' },
      { url: 'https://envolvati.com/', siteUrl: 'sc-domain:envolvati.com' },
      { url: 'https://envolvati.com/en/', siteUrl: 'sc-domain:envolvati.com' },
      { url: 'https://wjunior.dev.br/', siteUrl: 'sc-domain:wjunior.dev.br' },
      { url: 'https://ofertyza.com.br/', siteUrl: 'https://ofertyza.com.br/' },
    ]

    const reports: UrlInspectionReport[] = []
    for (const target of targets) {
      try {
        const report = await this.inspectUrl(target.url, target.siteUrl)
        reports.push(report)
      } catch (err: unknown) {
        reports.push({
          url: target.url,
          siteUrl: target.siteUrl,
          verdict: 'FAIL',
          coverageState: 'Erro de conexão na inspeção',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return reports
  }
}
