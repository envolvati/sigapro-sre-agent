# 📖 Runbook Operacional — SigaPro SRE AI Agent

Este documento é o guia de referência operacional para manter, configurar e diagnosticar o container **`sigapro-sre-agent`** em produção e homologação.

---

## 🎯 Visão Geral do Serviço

* **Nome no host:** `sigapro-sre-agent`
* **UUID do Recurso no host:** `8r5ajcud3ckolxggk9vsnliz`
* **Projeto / Ambiente:** `Sigapro` / `monitor`
* **Repositório Git:** `https://github.com/envolvati/sigapro-sre-agent`
* **Branch de Deploy:** `main`
* **Porta Interna:** `3030`
* **Rede Docker:** `docker` (rede externa compartilhada)

---

## 🌐 Topologia de Rede & Integrações

```mermaid
flowchart LR
    subgraph CoolifyBridge["Rede Docker Interna (docker)"]
        SREAgent["sigapro-sre-agent (:3030)"]
        Prometheus["prometheus:9090"]
        Tempo["tempo:3200"]
        Loki["loki:3100"]
    end

    subgraph InternetExternal["Aplicações & APIs Externas"]
        PaymentGW["💳 Envolvati Payments Gateway"]
        SigaProAPI["🚀 SigaPro API"]
        SigaProApp["🌐 SigaPro App"]
        AIGateway["🧠 OmniRoute AI Gateway"]
        TelegramAPI["📱 Telegram Bot API"]
    end

    SREAgent <-->|DNS Docker| Prometheus
    SREAgent <-->|DNS Docker| Tempo
    SREAgent <-->|DNS Docker| Loki

    SREAgent -->|HTTP Health Probes| PaymentGW
    SREAgent -->|HTTP Health Probes| SigaProAPI
    SREAgent -->|HTTP Health Probes| SigaProApp
    SREAgent <-->|LLM Prompt/RCA| AIGateway
    SREAgent <-->|Long Polling & Mensagens| TelegramAPI
```

---

## ⚙️ Variáveis de Ambiente (Configuração Obrigatória)

> ⚠️ **Atenção (Repositório Open-Source):**
> No código-fonte (`src/config/env.ts`), os valores default para URLs das aplicações monitoradas são marcados propositalmente com placeholders genéricos (`https://payments.domain.com`, `https://api.domain.com`, `https://app.domain.com`) para evitar vazamento de endpoints privados.
> **Portanto, as variáveis de negócio DEVEM ser declaradas explicitamente nas Environment Variables do Coolify.**

### Tabela Completa de Configuração

| Variável | Obrigatória | Valor em Produção / Staging | Finalidade |
| :--- | :---: | :--- | :--- |
| **`PORT`** | Não | `3030` | Porta onde o servidor Fastify responde. |
| **`NODE_ENV`** | Sim | `production` | Modo de execução do Node.js. |
| **`AI_GATEWAY_URL`** | Sim | `https://ai.gateway.com/v1` | URL base do OmniRoute AI Gateway. |
| **`AI_GATEWAY_KEY`** | Sim | `sk-...` | API Key para autenticação no OmniRoute. |
| **`AI_MODEL`** | Sim | `sre/triage-combo` | Modelo LLM utilizado para Daily Digest e RCA. |
| **`PROMETHEUS_URL`** | Sim | `http://prometheus:9090` | Acesso interno ao Prometheus na rede `docker`. |
| **`TEMPO_URL`** | Sim | `http://tempo:3200` | Acesso interno ao Grafana Tempo na rede `docker`. |
| **`LOKI_URL`** | Sim | `http://loki:3100` | Acesso interno ao Grafana Loki na rede `docker`. |
| **`PAYMENTS_GATEWAY_URL`** | **SIM** | `https://payments.gateway.com` | URL do gateway de pagamentos (produção) para `/health` e workers. |
| **`PAYMENTS_GATEWAY_HML_URL`** | Não | `https://hml-payments.gateway.com` | URL do gateway de pagamentos (homologação). |
| **`SIGAPRO_API_URL`** | **SIM** | `https://api.gateway.com` | URL do backend da API SigaPro para health check. |
| **`SIGAPRO_APP_URL`** | **SIM** | `https://app.gateway.com` | URL do frontend SigaPro para checagem de uptime. |
| **`TELEGRAM_BOT_TOKEN`** | Sim | `8198199909:...` | Token do bot emitido pelo @BotFather. |
| **`TELEGRAM_CHAT_ID`** | Sim | `-1000000000000` | ID do grupo/canal do Telegram. |
| **`TELEGRAM_THREAD_ID`** | Opcional | `14141` | ID do Tópico operacional no Telegram (se aplicável). |
| **`TELEGRAM_RELEASES_THREAD_ID`** | Não | `284` | ID do Tópico de Releases no Telegram para notificações de deploy/PR. |
| **`COOLIFY_API_URL`** | Não | `https://infra.sigapro.com/api/v1` | URL base da API REST do Coolify. |
| **`COOLIFY_API_TOKEN`** | Opcional | `3|coolify_token...` | Token Bearer do Coolify para histórico 24h e busca de logs de deploy. |
| **`GITHUB_TOKEN`** | Opcional | `ghp_...` | Personal Access Token do GitHub para PR Gatekeeper e comentários de Preview. |
| **`GITHUB_WEBHOOK_SECRET`** | Opcional | `segredo_hmac` | Segredo para validar assinatura HMAC SHA-256 do webhook do GitHub. |
| **`GOOGLE_APPLICATION_CREDENTIALS`** | Opcional | *(ver abaixo)* | Credenciais da Service Account do Google Cloud para Google Search Console. |
| **`PAGESPEED_API_KEY`** | Opcional | `AIzaSy...` | Chave de API do Google Cloud para o Google PageSpeed Insights v5. |
| **`GOOGLE_API_KEY`** | Opcional | `AIzaSy...` | Alias/fallback da chave de API Google caso `PAGESPEED_API_KEY` não seja informada. |

---

### 🔑 Guia de Configuração das Novas Variáveis Google

#### 1. `GOOGLE_APPLICATION_CREDENTIALS` (Google Search Console / SEO)
Usada pelo coletor `SearchConsoleCollector` para buscar impressões, cliques, CTR, posição média e termos ranqueados via `/seo` (Telegram) e `GET /api/public/seo-stats`.

* **O que é o valor:** A credencial JSON de uma **Service Account** do Google Cloud Platform (GCP).
* **Como obter:**
  1. No [Google Cloud Console](https://console.cloud.google.com), crie ou selecione o projeto.
  2. Em **APIs e Serviços** ➔ **Biblioteca**, pesquise por **Google Search Console API** (antiga Webmasters API) e clique em **Ativar**.
  3. Em **IAM e Administração** ➔ **Contas de Serviço**, clique em **Criar conta de serviço** (ex.: `sre-agent@seu-projeto.iam.gserviceaccount.com`).
  4. Clique na conta de serviço criada ➔ aba **Chaves** ➔ **Adicionar Chave** ➔ **Criar nova chave** ➔ selecione **JSON** e baixe o arquivo.
  5. Acesse o [Google Search Console](https://search.google.com/search-console) em cada domínio monitorado (`sigapro.com`, `envolvati.com`, etc.):
     * Vá em **Configurações** ➔ **Usuários e permissões** ➔ **Adicionar usuário**.
     * Insira o e-mail da conta de serviço (`sre-agent@...`) com permissão de **Leitor** (Read).
* **Como preencher no Coolify (3 opções suportadas pelo agente):**
  * **Opção 1 (Recomendada no Coolify — Base64):**
    Gere a string em base64 do JSON no terminal:
    ```bash
    base64 -i credentials.json | tr -d '\n'
    # No Linux: base64 -w 0 credentials.json
    ```
    Cole a linha única gerada no valor da variável `GOOGLE_APPLICATION_CREDENTIALS` no painel do Coolify. O agente decodifica automaticamente!
  * **Opção 2 (JSON inline direto):**
    Cole o conteúdo raw do arquivo JSON diretamente no valor da variável no Coolify.
  * **Opção 3 (Montagem de volume):**
    Monte um persistent storage / file mount no Coolify apontando para `/app/credentials/gsc-credentials.json` e defina `GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/gsc-credentials.json`.

---

#### 2. `PAGESPEED_API_KEY` ou `GOOGLE_API_KEY` (Google PageSpeed Insights)
Usada pelo coletor `PageSpeedCollector` para auditar notas do Lighthouse (0–100) e Core Web Vitals (LCP, FCP, CLS, TBT) via `/pagespeed` (Telegram) e `GET /api/public/pagespeed-stats`.

* **O que é o valor:** Uma API Key simples gerada no Google Cloud Platform.
* **Como obter:**
  1. No [Google Cloud Console](https://console.cloud.google.com), vá em **APIs e Serviços** ➔ **Biblioteca**.
  2. Pesquise por **PageSpeed Insights API** e clique em **Ativar**.
  3. Vá em **APIs e Serviços** ➔ **Credenciais** ➔ clique em **Criar Credenciais** ➔ **Chave de API**.
  4. *(Opcional, mas recomendado)* Restrinja a chave para permitir chamadas apenas à "PageSpeed Insights API".
* **Como preencher no Coolify:**
  * Adicione nas Environment Variables do Coolify:
    ```env
    PAGESPEED_API_KEY=AIzaSyD-ExemploDeChaveDoGooglePageSpeed...
    ```
  * *Nota:* A API do PageSpeed funciona até mesmo sem chave para requisições esparsas, porém fica sujeita a rate limits estritos de IP do Google. Com a chave configurada, a cota gratuita é de 25.000 requisições diárias.
---

## 🚀 Como Configurar no Coolify

1. Acesse o painel do Coolify: `http://localhost:8000` (ou domínio público configurado).
2. Navegue até o projeto: **Sigapro** ➔ Ambiente **monitor** ➔ Aplicação **`sigapro-sre-agent`**.
3. Vá na aba **Environment Variables**.
4. Certifique-se de que todas as variáveis da tabela acima estejam preenchidas (especialmente `PAYMENTS_GATEWAY_URL`, `SIGAPRO_API_URL` e `SIGAPRO_APP_URL`).
5. Clique em **Save** e em seguida em **Redeploy**.

---

## 🛠 Comandos de Operação via SSH (VPS Oracle)

O acesso ao servidor é feito via `ssh oracle` com permissões `sudo su`:

### 1. Verificar se o container está rodando
```bash
sudo docker ps --filter "name=sre-agent"
```

### 2. Acompanhar logs em tempo real
```bash
sudo docker logs -f --tail 100 $(sudo docker ps -q --filter "name=sre-agent")
```

### 3. Verificar variáveis carregadas no container em execução
```bash
sudo docker exec $(sudo docker ps -q --filter "name=sre-agent") env | grep -E 'URL|AI|TELEGRAM'
```

### 4. Testar o endpoint de saúde do próprio agente
```bash
curl -s http://localhost:3030/health | jq .
```
*Retorno esperado:* HTTP `200` com status `UP` para `prometheus`, `tempo`, `loki` e `aiGateway`.

### 5. Reiniciar o serviço manualmente
```bash
sudo docker restart $(sudo docker ps -q --filter "name=sre-agent")
```

---

## 🩺 Playbooks de Diagnóstico (Troubleshooting)

### 🔴 Problema 1: Bot reporta serviços como DOWN no Telegram (Falso Positivo)

* **Sintoma:** Ao rodar `/apps`, `/digest` ou `/snapshot`, o bot responde com `❌ Envolvati Payments Gateway: DOWN` ou `❌ SigaPro API: DOWN`, mas os serviços estão funcionando no navegador.
* **Causa Raiz:** O container está sem as variáveis `PAYMENTS_GATEWAY_URL`, `SIGAPRO_API_URL` ou `SIGAPRO_APP_URL` e usou os fallbacks `*.domain.com`.
* **Como Validar:**
  ```bash
  sudo docker exec $(sudo docker ps -q --filter "name=sre-agent") node -e '
    console.log("PAYMENTS:", process.env.PAYMENTS_GATEWAY_URL);
    console.log("API:", process.env.SIGAPRO_API_URL);
    console.log("APP:", process.env.SIGAPRO_APP_URL);
  '
  ```
  Se retornar `undefined`, as variáveis não foram injetadas pelo Coolify.
* **Resolução:**
  1. Adicione as variáveis na aba *Environment Variables* do Coolify.
  2. Clique em **Redeploy**.

---

### 🔴 Problema 2: O Bot não responde a comandos no Telegram

* **Sintoma:** O usuário envia `/help` ou `/apps` no Telegram e nada acontece.
* **Causa Raiz:**
  1. Conflito de chat/tópico: a mensagem foi enviada fora do `TELEGRAM_CHAT_ID` ou de um tópico diferente de `TELEGRAM_THREAD_ID`.
  2. Falha de rede no Long Polling da API do Telegram.
* **Como Validar:**
  Procure por logs de entrada do listener:
  ```bash
  sudo docker logs --tail 200 $(sudo docker ps -q --filter "name=sre-agent") | grep -E "TelegramListener|Incoming command"
  ```
* **Resolução:**
  1. Verifique se o `TELEGRAM_CHAT_ID` e `TELEGRAM_THREAD_ID` coincidem exatamente com o canal/tópico onde o bot foi invocado.
  2. Reinicie o container: `sudo docker restart $(sudo docker ps -q --filter "name=sre-agent")`.

---

### 🔴 Problema 3: Conectividade DEGRADED com a Stack de Observabilidade

* **Sintoma:** O `/health` retorna `status: DEGRADED` acusando `PROMETHEUS`, `TEMPO` ou `LOKI` como `DOWN`.
* **Causa Raiz:** Os containers da stack de observabilidade (`sigapro-monitoring`) caíram ou não estão conectados na mesma rede Docker `coolify`.
* **Como Validar:**
  ```bash
  # Testar resolução interna de DNS docker
  sudo docker exec $(sudo docker ps -q --filter "name=sre-agent") node -e '
    fetch("http://prometheus:9090/-/healthy").then(r => console.log("Prometheus:", r.status)).catch(console.error);
    fetch("http://tempo:3200/ready").then(r => console.log("Tempo:", r.status)).catch(console.error);
    fetch("http://loki:3100/ready").then(r => console.log("Loki:", r.status)).catch(console.error);
  '
  ```
* **Resolução:**
  Verifique se o compose `sigapro-monitoring` está ativo no Coolify ou suba-o novamente.

---

### 🔴 Problema 4: Falha ao gerar Daily Digest ou RCA de Trace

* **Sintoma:** O bot acusa `❌ Erro ao consultar AI Gateway`.
* **Causa Raiz:** A chave `AI_GATEWAY_KEY` expirou/está incorreta, o endpoint `AI_GATEWAY_URL` está inacessível ou o modelo `sre/triage-combo` não existe no catálogo.
* **Como Validar:**
  ```bash
  sudo docker exec $(sudo docker ps -q --filter "name=sre-agent") node -e '
    fetch(process.env.AI_GATEWAY_URL + "/models", {
      headers: { Authorization: "Bearer " + process.env.AI_GATEWAY_KEY }
    }).then(r => console.log("AI Gateway status:", r.status)).catch(console.error);
  '
  ```
* **Resolução:** Atualize `AI_GATEWAY_KEY` ou aponte `AI_MODEL` para um modelo alternativo como `auto/fast`.

---

## ⏰ Rotinas Automáticas (Scheduled Tasks no Coolify)

Para disparar o **Daily SRE Digest** automaticamente todos os dias às **08:00 BRT** (11:00 UTC):

1. No Coolify, em `sigapro-sre-agent` ➔ **Scheduled Tasks**.
2. Nome: `Daily SRE Digest`.
3. Cron Expression: `0 11 * * *` (ou `0 8 * * *` se o timezone do servidor for BRT).
4. Comando a executar:
   ```bash
   curl -X POST http://localhost:3030/triggers/daily-digest
   ```
