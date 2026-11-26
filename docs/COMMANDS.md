# 📋 SigaPro SRE Agent — Guia de Comandos & Endpoints

Referência rápida de comandos do Bot no Telegram e endpoints HTTP da API.

---

## 📱 Comandos no Telegram

Envie qualquer um dos comandos abaixo diretamente no chat ou tópico configurado do Telegram:

### 🌐 SEO & Performance Web
| Comando | Alias | Descrição |
| :--- | :--- | :--- |
| `/seo [dominio]` | `/gsc` | Telemetria do Google Search Console. Sem parâmetros mostra o portfólio consolidado de todos os domínios. Passando o domínio (ex.: `/seo ofertyza.com.br` ou `/seo envolvati`), exibe raio-x detalhado com até 10 principais termos ranqueados, impressões, cliques, CTR e posição. |
| `/pagespeed [url]` | `/psi` | Executa auditoria do Google PageSpeed/Lighthouse em tempo real com Scores (0-100) e Core Web Vitals (LCP, CLS, FCP, TBT e peso da página). Se a URL for omitida, testa `wjunior.dev.br`. |
### 📦 Aplicações & Microsserviços
| Comando | Alias | Descrição |
| :--- | :--- | :--- |
| `/apps` | `/services` | Painel consolidado das aplicações com status (UP/DOWN), latência em ms, workers ativos e contagem de erros recentes no Loki. |
| `/app payments` | | Raio-X do Payments Gateway com status individual dos 7 workers em background. |
| `/app sigapro` | | Status da API NestJS, tempo de resposta e logs de erro recentes. |
| `/app front` | | Status do Next.js, memória Heap/RSS e logs recentes. |

### 🚀 CI/CD & Deployments
| Comando | Alias | Descrição |
| :--- | :--- | :--- |
| `/deploys` | `/releases` | Lista os últimos deploys concluídos ou com falha registrados pelo Coolify. |
| `/prs` | `/pulls` | Lista todos os Pull Requests abertos nos repositórios monitorados. |
| `/pr <repo> <numero>` | `/audit` | Executa a auditoria automática do PR Gatekeeper em um PR específico (ex.: `/pr api 117` ou `/pr front 240`). |

### 🖥️ Infraestrutura & Observabilidade
| Comando | Alias | Descrição |
| :--- | :--- | :--- |
| `/server` | `/host`, `/infra` | CPU, Load Average (1m/5m/15m), RAM, Disco e Top containers em consumo de memória. |
| `/health` | `/status` | Probe de conectividade interna com Prometheus, Tempo, Loki e OmniRoute AI Gateway. |
| `/digest` | | Dispara sob demanda o Daily SRE Digest com o balanço geral de 24h. |
| `/help` | `/start` | Menu interativo de ajuda formatado. |

### 🧠 Diagnóstico com IA (OmniRoute)
| Comando | Alias | Descrição |
| :--- | :--- | :--- |
| `/snapshot <pergunta>` | `/sre` | Faz perguntas em linguagem natural sobre o estado do sistema (ex.: `/snapshot a api caiu?`, `/snapshot o checkout tá lento?`). |
| `/trace <trace_id>` | | Análise de Causa Raiz (RCA) de uma transação específica via Grafana Tempo. |

---

## 🌐 Endpoints REST (Porta `:3030`)

### Públicos (CORS liberado para Portfólio / Dashboards)
* **`GET /api/public/seo-stats`**
  * *Query params:* `?days=30` (default 30, máx 90), `?refresh=true` (força recálculo sem cache).
  * *Cache:* Em memória por 1 hora (responde em < 1ms para chamadas subsequentes).
  * *Payload de exemplo:*
    ```json
    {
      "updatedAt": "2026-11-26T04:55:00.000Z",
      "periodDays": 30,
      "summary": {
        "totalSites": 4,
        "totalImpressions": 122,
        "totalClicks": 1,
        "overallCtr": 0.82
      },
      "sites": [
        {
          "cleanName": "sigapro.com",
          "impressions": 110,
          "clicks": 1,
          "avgPosition": 4.2,
          "topQueries": [
            { "query": "sigapro", "impressions": 72, "position": 3.2 }
          ]
        }
      ]
    }
    ```
* **`GET /api/seo/health`**
  * Retorna o status de indexação dos domínios monitorados via Google URL Inspection API.
* **`GET /api/public/pagespeed-stats`**
  * *Query params:* `?refresh=true` (força auditoria imediata sem cache).
  * *Cache:* Em memória por 6 horas.
  * *Payload de exemplo:*
    ```json
    {
      "updatedAt": "2026-11-26T05:00:00.000Z",
      "averageScores": { "performance": 98, "accessibility": 100, "bestPractices": 100, "seo": 100 },
      "sites": [
        {
          "cleanName": "wjunior.dev.br",
          "scores": { "performance": 100, "accessibility": 100, "bestPractices": 100, "seo": 100 },
          "metrics": { "lcp": "0.6 s", "cls": "0", "totalByteWeight": "180 KiB" }
        }
      ]
    }
    ```

### Operacionais & Webhooks
* **`GET /health`**: Healthcheck com probe ativo em todos os monitores (Prometheus, Tempo, Loki, AI Gateway).
* **`POST /triggers/daily-digest`**: Trigger para disparo do resumo executivo das 24h.
* **`POST /webhooks/coolify`**: Webhook de eventos de deploy do Coolify.
* **`POST /webhooks/github`**: Webhook de PRs para auditoria automática do PR Gatekeeper.
* **`POST /webhooks/grafana`**: Webhook para incidentes do Grafana Alerting.
* **`POST /webhooks/glitchtip`**: Webhook para crashes reportados pelo GlitchTip.
* **`POST /analyze/pr`**: Auditoria de PR via API.
