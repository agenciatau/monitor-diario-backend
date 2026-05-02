# Tatu

Ferramenta de investigação de diários oficiais estaduais do Nordeste brasileiro com busca inteligente via IA. Permite que jornalistas façam perguntas sobre publicações oficiais dos 9 estados do Nordeste e configurem monitoramentos automáticos por tema.

## Como funciona

1. **Coleta:** O scraper roda a cada hora (dias úteis) e baixa novos PDFs dos diários oficiais dos 9 estados do Nordeste
2. **Armazenamento:** Os PDFs são salvos no Supabase Storage e os metadados na tabela `diarios`
3. **Indexação:** Os PDFs são enviados ao Vector Store da OpenAI para busca semântica
4. **Análise por evento:** Quando um novo diário é encontrado, o scraper chama `analyze` para cada monitor ativo do estado correspondente
5. **Análise agendada:** Um job diário dispara análises para todos os monitores ativos conforme sua frequência configurada (`daily` ou `weekly`)
6. **Consulta:** A API responde perguntas em linguagem natural, usando o contexto de monitoramento configurado pelo frontend

## Pré-requisitos

- Deno 2.x
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
MONITOR_SUPABASE_KEY=sua_service_role_key_aqui  # service role do projeto monitor
```

### Supabase — Projeto Scraper

**Storage bucket:** `diarios-oficiais` (público)

**Tabela `diarios`:**
```sql
create table diarios (
  id uuid primary key default gen_random_uuid(),
  estado text not null,
  data_publicacao date not null,
  arquivo_nome text not null unique,
  storage_url text,
  criado_em timestamptz default now()
);
```

### Supabase — Projeto Monitor (frontend)

**Tabela `monitores`** (gerenciada pelo frontend):
```sql
create table monitores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  title text,
  uf text not null,
  description text,
  keywords text,
  frequency text default 'daily',  -- 'daily' ou 'weekly'
  is_active boolean default true,
  user_name text,
  user_email text,
  created_at timestamptz default now()
);
```

**Tabela `analises`** (preenchida automaticamente pela função `analyze`):
```sql
create table analises (
  id uuid default gen_random_uuid() primary key,
  monitor_id uuid references monitores(id) on delete set null,
  uf text not null,
  resposta text,
  resumo text,
  fontes jsonb default '[]'::jsonb,
  wikidata jsonb default '[]'::jsonb,
  url_diario text,
  model text,
  monitor_description text,
  monitor_keywords text[],
  monitor_is_active boolean,
  criado_em timestamptz default now()
);
```

> O trigger `trg_fill_monitor_info` popula automaticamente `monitor_description`, `monitor_keywords` e `monitor_is_active` a partir da tabela `monitores` no INSERT. Certifique-se de que a função usa `string_to_array(keywords, ', ')` para converter o campo texto em array.

## Uso

### 1. Executar o scraper

```bash
deno run --allow-net --allow-read --allow-write --allow-env \
  --unsafely-ignore-certificate-errors=dool.egba.ba.gov.br \
  pdfs_scraper.ts
```

O scraper coleta PDFs dos 9 estados do Nordeste (AL, BA, CE, MA, PB, PE, PI, RN, SE), valida a camada de texto, faz upload ao Supabase Storage, registra os metadados na tabela `diarios`, indexa os arquivos no Vector Store da OpenAI e, ao encontrar novos diários, dispara análises para os monitores ativos do estado correspondente.

### 2. Sincronizar Vector Store

Caso existam arquivos na tabela `diarios` que ainda não foram indexados no Vector Store (ex: após migração ou falha), use:

```bash
deno run --allow-net --allow-read --allow-env sync_vector_store.ts
```

O script compara a tabela `diarios` com o Vector Store, faz upload dos arquivos faltantes em paralelo e os adiciona em lote.

### 3. Disparar análises agendadas manualmente

```bash
deno run --allow-net --allow-read --allow-env trigger_analyses.ts
```

### 4. Agendar coleta e análises via GitHub Actions

Adicione os seguintes **Actions Secrets** no repositório (`Settings → Secrets and variables → Actions`):

| Secret | Valor |
|--------|-------|
| `SUPABASE_URL` | URL do projeto scraper |
| `SUPABASE_KEY` | Service role key do projeto scraper |
| `OPEN_API_KEY` | Chave da OpenAI |
| `VECTOR_STORE_ID` | ID do Vector Store da OpenAI |
| `MONITOR_SUPABASE_URL` | URL do projeto monitor |
| `MONITOR_SUPABASE_KEY` | Service role key do projeto monitor |

Dois workflows são configurados automaticamente:

| Workflow | Cron | Descrição |
|----------|------|-----------|
| `hourly_scraper.yml` | A cada hora (dias úteis) | Coleta novos diários e dispara análises por evento |
| `daily_analyses.yml` | 09:00 UTC (dias úteis) | Dispara análises agendadas por frequência (`daily` / `weekly`) |

### 5. Deploy das Edge Functions

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

### 6. Configurar webhook para análise ao criar monitor

No dashboard do projeto monitor:

- **Database → Webhooks → Create webhook**
- Table: `monitores` / Event: `INSERT`
- Target: **Supabase Edge Function → analyze**

Ao criar um novo monitoramento no frontend, a análise é gerada imediatamente com o diário mais recente do estado.

## Estrutura do projeto

```
tatu/
├── pdfs_scraper.ts              # Scraper principal — coleta, indexa e dispara análises
├── trigger_analyses.ts          # Dispara análises agendadas para monitores ativos
├── sync_vector_store.ts         # Sincroniza arquivos do DB com o Vector Store
├── .github/
│   └── workflows/
│       ├── hourly_scraper.yml   # GitHub Actions — coleta horária (dias úteis)
│       └── daily_analyses.yml  # GitHub Actions — análises diárias (dias úteis)
└── supabase/
    ├── config.toml              # Configuração das Edge Functions
    └── functions/
        ├── _shared/
        │   ├── openai.ts        # Consulta ao Vector Store (Responses API)
        │   ├── instructions.ts  # Builder de prompt dinâmico
        │   └── wikidata.ts      # Enriquecimento via Wikidata
        ├── chat/index.ts        # Endpoint de perguntas em linguagem natural
        ├── analyze/index.ts     # Geração de análise a partir do diário mais recente
        └── upload/index.ts      # Upload manual de PDF ao Vector Store
```

## Edge Functions

| Função | Trigger | Descrição |
|--------|---------|-----------|
| `chat` | `POST /functions/v1/chat` | Responde perguntas em linguagem natural com fontes |
| `upload` | `POST /functions/v1/upload` | Faz upload de um PDF ao Vector Store |
| `analyze` | `POST /functions/v1/analyze` | Gera análise do diário mais recente para um monitor |

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

### Exemplo — analyze

```bash
curl -X POST https://SEU_PROJECT_REF.supabase.co/functions/v1/analyze \
  -H "Content-Type: application/json" \
  -d '{"record": {"id": "<monitor-uuid>", "uf": "PE", "description": "Licitações", "keywords": "licitação, pregão"}}'
```
