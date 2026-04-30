# Tatu

Ferramenta de investigação de diários oficiais estaduais do Nordeste brasileiro com busca inteligente via IA. Permite que jornalistas façam perguntas sobre publicações oficiais dos 9 estados do Nordeste.

## Como funciona

1. **Coleta:** O scraper baixa PDFs dos diários oficiais dos estados do Nordeste diariamente (via cron)
2. **Armazenamento:** Os PDFs são salvos no Supabase Storage e os metadados na tabela `diarios`
3. **Indexação:** Os PDFs são enviados ao Vector Store da OpenAI para busca semântica
4. **Análise automática:** Quando um novo monitoramento é criado no frontend, um webhook dispara a função `analyze`, que gera uma análise automática e salva o resultado na tabela `analises`
5. **Consulta:** A API responde perguntas em linguagem natural, usando o contexto de monitoramento configurado pelo frontend para personalizar as respostas por estado

## Pré-requisitos

- Deno 2.x (scraper)
- Chave de API da OpenAI (com acesso à Responses API)
- Conta no Supabase (dois projetos: scraper e monitor/frontend)
- Supabase CLI (para deploy das Edge Functions)

## Instalação

```bash
git clone <url-do-repositorio>
cd tatu

# Instalar Deno (caso não tenha)
curl -fsSL https://deno.land/install.sh | sh
```

## Configuração

Crie um arquivo `.env` na raiz do projeto:

```env
OPEN_API_KEY=sua_chave_openai_aqui
VECTOR_STORE_ID=        # ID do Vector Store da OpenAI
SUPABASE_URL=https://<projeto-scraper>.supabase.co
SUPABASE_KEY=sua_service_role_key_aqui
MONITOR_SUPABASE_URL=https://<projeto-monitor>.supabase.co
MONITOR_SUPABASE_KEY=sua_service_role_key_aqui
```

### Supabase — Projeto Scraper

**Storage bucket:** `diarios-oficiais` (público)

**Tabela `diarios`:**
```sql
create table diarios (
  id uuid primary key default gen_random_uuid(),
  estado text not null,
  data_publicacao date not null,
  arquivo_nome text not null,
  storage_url text,
  criado_em timestamptz default now()
);
```

### Supabase — Projeto Monitor (frontend)

**Tabela `monitores`** (gerenciada pelo frontend):
```sql
create table monitores (
  id uuid primary key default gen_random_uuid(),
  uf text not null,
  description text,
  keywords text[],
  is_active boolean default true
);
```

**Tabela `analises`** (preenchida automaticamente pela função `analyze`):
```sql
create table analises (
  id uuid default gen_random_uuid() primary key,
  monitor_id uuid references monitores(id) on delete set null,
  uf text not null,
  resposta text,
  fontes jsonb default '[]'::jsonb,
  wikidata jsonb default '[]'::jsonb,
  criado_em timestamptz default now()
);
```

## Uso

### 1. Executar o scraper

```bash
deno run --allow-net --allow-read --allow-write --allow-env \
  --unsafely-ignore-certificate-errors=dool.egba.ba.gov.br \
  pdfs_scraper.ts
```

O scraper coleta PDFs dos 9 estados do Nordeste (AL, BA, CE, MA, PB, PE, PI, RN, SE), valida a camada de texto, faz upload ao Supabase Storage, registra os metadados na tabela `diarios` e indexa os arquivos no Vector Store da OpenAI.

### 2. Agendar coleta diária

**GitHub Actions:** O workflow `.github/workflows/daily_scraper.yml` executa o scraper automaticamente de segunda a sexta às 06h BRT.

Adicione as seguintes variáveis como **Actions Secrets** no repositório (`Settings → Secrets and variables → Actions`):

| Secret | Valor |
|--------|-------|
| `SUPABASE_URL` | URL do projeto scraper |
| `SUPABASE_KEY` | Service role key do projeto scraper |
| `OPEN_API_KEY` | Chave da OpenAI |
| `VECTOR_STORE_ID` | ID do Vector Store da OpenAI |

**Cron local:** Use o script `run_scraper.sh` e adicione ao crontab:

```bash
0 6 * * 1-5 /caminho/para/tatu/run_scraper.sh >> /caminho/para/tatu/logs/scraper.log 2>&1
```

### 3. Deploy das Edge Functions

As Edge Functions rodam diretamente no Supabase (sem servidor externo).

```bash
# Instalar Supabase CLI
brew install supabase/tap/supabase

# Linkar ao projeto monitor
supabase link --project-ref SEU_PROJECT_REF

# Configurar segredos (lê do .env)
supabase secrets set --env-file .env

# Fazer deploy
supabase functions deploy chat
supabase functions deploy upload
supabase functions deploy analyze
```

O `PROJECT_REF` está em **Supabase dashboard → Project Settings → General → Reference ID**.

### 4. Configurar webhook de análise automática

No dashboard do projeto monitor:

- **Database → Webhooks → Create webhook**
- Table: `monitores` / Event: `INSERT`
- Target: **Supabase Edge Function → analyze**

A partir daí, toda vez que um novo monitoramento for criado no frontend, a análise é gerada automaticamente e salva em `analises`.

## Estrutura do projeto

```
tatu/
├── pdfs_scraper.ts              # Scraper principal (Deno/TypeScript)
├── run_scraper.sh               # Wrapper para cron local
├── .github/
│   └── workflows/
│       └── daily_scraper.yml    # GitHub Actions (coleta diária)
└── supabase/
    ├── config.toml              # Configuração das Edge Functions
    └── functions/
        ├── _shared/
        │   ├── openai.ts        # Consulta ao Vector Store
        │   ├── instructions.ts  # Builder de prompt dinâmico
        │   └── wikidata.ts      # Enriquecimento via Wikidata
        ├── chat/index.ts        # Endpoint de perguntas
        ├── analyze/index.ts     # Handler do webhook de análise
        └── upload/index.ts      # Endpoint de upload de PDF
```

## Edge Functions

| Função | Trigger | Descrição |
|--------|---------|-----------|
| `chat` | `POST /functions/v1/chat` | Responde perguntas em linguagem natural com fontes e dados do Wikidata |
| `upload` | `POST /functions/v1/upload` | Faz upload de um PDF ao Vector Store |
| `analyze` | DB webhook (`monitores` INSERT) | Gera análise automática ao criar um novo monitoramento |

### Exemplo — chat

```bash
curl -X POST https://SEU_PROJECT_REF.supabase.co/functions/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"pergunta": "Quais licitações de merenda foram publicadas?", "estado": "BA"}'
```

Resposta:
```json
{
  "resposta": "Foram encontradas as seguintes licitações...",
  "fontes": [
    { "arquivo": "bahia_20260324.pdf" }
  ],
  "wikidata": []
}
```

O campo `estado` é opcional. Quando informado, a função busca a configuração de monitoramento correspondente em `monitores` e usa a descrição e palavras-chave para personalizar o prompt.
