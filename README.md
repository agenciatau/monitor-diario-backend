# Tatu

Ferramenta de investigação de diários oficiais estaduais do Nordeste brasileiro com busca inteligente via IA. Permite que jornalistas façam perguntas sobre publicações oficiais dos 9 estados do Nordeste.

## Como funciona

1. **Coleta:** O scraper baixa PDFs dos diários oficiais dos estados do Nordeste diariamente (via cron)
2. **Armazenamento:** Os PDFs são salvos no Supabase Storage e os metadados na tabela `diarios`
3. **Indexação:** Os PDFs são enviados ao Vector Store da OpenAI para busca semântica
4. **Consulta:** A API Django responde perguntas em linguagem natural, usando o contexto de monitoramento configurado pelo frontend para personalizar as respostas por estado

## Pré-requisitos

- Python 3.10+
- Chave de API da OpenAI (com acesso à Responses API)
- Projeto no Supabase com as tabelas e bucket configurados

## Instalação

```bash
git clone <url-do-repositorio>
cd tatu

python3 -m venv .venv
source .venv/bin/activate  # No Windows: .venv\Scripts\activate

pip3 install -r requirements.txt
```

## Configuração

Crie um arquivo `.env` na raiz do projeto:

```env
OPEN_API_KEY=sua_chave_openai_aqui
VECTOR_STORE_ID=        # preenchido automaticamente pelo upload_pdfs.py
SUPABASE_URL=https://<seu-projeto>.supabase.co
SUPABASE_KEY=sua_service_role_key_aqui
DJANGO_SECRET_KEY=sua_secret_key_django
```

### Supabase

Crie os seguintes recursos no seu projeto Supabase:

**Storage bucket:** `diarios-oficiais` (público)

**Tabela `diarios`** (criada pelo scraper):
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

**Tabela `monitores`** (gerenciada pelo frontend):
```sql 
create table monitores (
  id uuid primary key default gen_random_uuid(),
  estado text not null unique,
  descricao text,
  palavras_chave text[]
);
```

## Uso

### 1. Baixar PDFs dos diários oficiais

```bash
python3 pdfs_scraper.py
```

Coleta PDFs dos 9 estados do Nordeste (AL, BA, CE, MA, PB, PE, PI, RN, SE), valida a camada de texto, faz upload ao Supabase Storage e registra os metadados na tabela `diarios`.

### 2. Agendar coleta diária (GitHub Actions)

O workflow `.github/workflows/daily_scraper.yml` executa o scraper automaticamente de segunda a sexta às 06h BRT.

Adicione as seguintes variáveis como **Actions Secrets** no repositório (`Settings → Secrets and variables → Actions`):

| Secret | Valor |
|--------|-------|
| `SUPABASE_URL` | URL do seu projeto Supabase |
| `SUPABASE_KEY` | Service role key do Supabase |

Para acionar manualmente: `Actions → Daily Scraper → Run workflow`.

> **Alternativa local:** use `run_scraper.sh` com crontab se preferir rodar em um servidor próprio.

### 3. Indexar PDFs no Vector Store da OpenAI

```bash
python3 upload_pdfs.py
```

Cria (ou reutiliza) um Vector Store na OpenAI, envia os PDFs locais e salva o `VECTOR_STORE_ID` no `.env`.

### 4. Iniciar o servidor da API

```bash
python3 diario_api/manage.py migrate  # primeira vez
python3 diario_api/manage.py runserver
```

O servidor estará disponível em `http://localhost:8000`.

## Endpoints da API

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/api/chat/` | POST | Envia uma pergunta e recebe resposta com fontes |
| `/api/upload/` | POST | Faz upload de um novo PDF ao Vector Store |
| `/api/docs/` | GET | Documentação Swagger da API |

### Exemplo de consulta

```bash
curl -X POST http://localhost:8000/api/chat/ \
  -H "Content-Type: application/json" \
  -d '{"pergunta": "Quais licitações de merenda foram publicadas?", "estado": "bahia"}'
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

O campo `estado` é opcional. Quando informado, a API busca a configuração de monitoramento correspondente na tabela `monitores` e usa a descrição e palavras-chave para personalizar o prompt enviado ao modelo.
