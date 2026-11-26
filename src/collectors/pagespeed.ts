import { env } from 'config/env'
import { SearchConsoleCollector } from 'collectors/search-console'

export interface PageSpeedScores {
  performance: number
  accessibility: number
  bestPractices: number
  seo: number
}

export interface PageSpeedMetrics {
  fcp: string
  lcp: string
  cls: string
  tbt: string
  speedIndex: string
  totalByteWeight: string
}

export interface PageSpeedSiteAudit {
  url: string
  cleanName: string
  strategy: 'mobile' | 'desktop'
  scores: PageSpeedScores
  metrics: PageSpeedMetrics
  cruxCategory: string | null
  timestamp: string
  error?: string
}

export interface PageSpeedPortfolioSummary {
  updatedAt: string
  fromCache?: boolean
  averageScores: PageSpeedScores
  sites: PageSpeedSiteAudit[]
}

interface LighthouseCategory {
  score: number | null
}

interface LighthouseAudit {
  displayValue?: string
  numericValue?: number
}

interface PageSpeedApiResponse {
  lighthouseResult?: {
    categories?: {
      performance?: LighthouseCategory
      accessibility?: LighthouseCategory
      'best-practices'?: LighthouseCategory
      seo?: LighthouseCategory
    }
    audits?: {
      'first-contentful-paint'?: LighthouseAudit
      'largest-contentful-paint'?: LighthouseAudit
      'cumulative-layout-shift'?: LighthouseAudit
      'total-blocking-time'?: LighthouseAudit
      'speed-index'?: LighthouseAudit
      'total-byte-weight'?: LighthouseAudit
    }
  }
  loadingExperience?: {
    overall_category?: string
  }
  error?: {
    message?: string
    code?: number
  }
}

export class PageSpeedCollector {
  private static instance: PageSpeedCollector | null = null

  private cachedSummary: { data: PageSpeedPortfolioSummary; expiresAt: number } | null = null
  private readonly defaultCacheTtlMs = 6 * 60 * 60 * 1000 // 6 horas de cache em memória

  public static getInstance(): PageSpeedCollector {
    if (!PageSpeedCollector.instance) {
      PageSpeedCollector.instance = new PageSpeedCollector()
    }
    return PageSpeedCollector.instance
  }

  async auditSite(
    targetUrl: string,
    strategy: 'mobile' | 'desktop' = 'mobile',
  ): Promise<PageSpeedSiteAudit> {
    const cleanName = targetUrl.replace('https://', '').replace('http://', '').replace(/\/$/, '')
    const apiKey = env.PAGESPEED_API_KEY || env.GOOGLE_API_KEY

    const apiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed')
    apiUrl.searchParams.set('url', targetUrl)
    apiUrl.searchParams.set('strategy', strategy)
    apiUrl.searchParams.append('category', 'performance')
    apiUrl.searchParams.append('category', 'accessibility')
    apiUrl.searchParams.append('category', 'best-practices')
    apiUrl.searchParams.append('category', 'seo')

    const headers: Record<string, string> = {}

    if (apiKey) {
      apiUrl.searchParams.set('key', apiKey)
    } else {
      try {
        const token = await SearchConsoleCollector.getInstance().getAccessToken()
        if (token) {
          headers['Authorization'] = `Bearer ${token}`
        }
      } catch {
        // Sem Service Account configurada; segue sem autenticação
      }
    }

    try {
      const res = await fetch(apiUrl.toString(), {
        headers,
        signal: AbortSignal.timeout(45_000), // Timeout de 45 segundos para testes Lighthouse
      })

      const data = (await res.json()) as PageSpeedApiResponse

      if (!res.ok || data.error) {
        const errorMsg = data.error?.message || `HTTP ${res.status}: ${res.statusText}`
        return {
          url: targetUrl,
          cleanName,
          strategy,
          scores: { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 },
          metrics: {
            fcp: '-',
            lcp: '-',
            cls: '-',
            tbt: '-',
            speedIndex: '-',
            totalByteWeight: '-',
          },
          cruxCategory: null,
          timestamp: new Date().toISOString(),
          error: errorMsg,
        }
      }

      const cats = data.lighthouseResult?.categories
      const audits = data.lighthouseResult?.audits

      const perfScore = Math.round((cats?.performance?.score ?? 0) * 100)
      const a11yScore = Math.round((cats?.accessibility?.score ?? 0) * 100)
      const bpScore = Math.round((cats?.['best-practices']?.score ?? 0) * 100)
      const seoScore = Math.round((cats?.seo?.score ?? 0) * 100)

      return {
        url: targetUrl,
        cleanName,
        strategy,
        scores: {
          performance: perfScore,
          accessibility: a11yScore,
          bestPractices: bpScore,
          seo: seoScore,
        },
        metrics: {
          fcp: audits?.['first-contentful-paint']?.displayValue || 'N/A',
          lcp: audits?.['largest-contentful-paint']?.displayValue || 'N/A',
          cls: audits?.['cumulative-layout-shift']?.displayValue || '0',
          tbt: audits?.['total-blocking-time']?.displayValue || '0 ms',
          speedIndex: audits?.['speed-index']?.displayValue || 'N/A',
          totalByteWeight: audits?.['total-byte-weight']?.displayValue || 'N/A',
        },
        cruxCategory: data.loadingExperience?.overall_category || null,
        timestamp: new Date().toISOString(),
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      return {
        url: targetUrl,
        cleanName,
        strategy,
        scores: { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 },
        metrics: { fcp: '-', lcp: '-', cls: '-', tbt: '-', speedIndex: '-', totalByteWeight: '-' },
        cruxCategory: null,
        timestamp: new Date().toISOString(),
        error: errorMsg,
      }
    }
  }

  async getPortfolioPageSpeedSummary(forceRefresh = false): Promise<PageSpeedPortfolioSummary> {
    const now = Date.now()

    if (!forceRefresh && this.cachedSummary && this.cachedSummary.expiresAt > now) {
      return {
        ...this.cachedSummary.data,
        fromCache: true,
      }
    }

    const targetSites = [
      'https://wjunior.dev.br',
      'https://sigapro.com',
      'https://envolvati.com',
      'https://ofertyza.com.br',
    ]

    const audits: PageSpeedSiteAudit[] = []
    for (const site of targetSites) {
      const audit = await this.auditSite(site, 'mobile')
      audits.push(audit)
    }

    const validAudits = audits.filter(a => !a.error && a.scores.performance > 0)
    const count = validAudits.length || 1

    const avgPerf = Math.round(
      validAudits.reduce((acc, a) => acc + a.scores.performance, 0) / count,
    )
    const avgA11y = Math.round(
      validAudits.reduce((acc, a) => acc + a.scores.accessibility, 0) / count,
    )
    const avgBp = Math.round(
      validAudits.reduce((acc, a) => acc + a.scores.bestPractices, 0) / count,
    )
    const avgSeo = Math.round(validAudits.reduce((acc, a) => acc + a.scores.seo, 0) / count)

    const summary: PageSpeedPortfolioSummary = {
      updatedAt: new Date().toISOString(),
      fromCache: false,
      averageScores: {
        performance: avgPerf,
        accessibility: avgA11y,
        bestPractices: avgBp,
        seo: avgSeo,
      },
      sites: audits,
    }

    this.cachedSummary = {
      data: summary,
      expiresAt: now + this.defaultCacheTtlMs,
    }

    return summary
  }
}
