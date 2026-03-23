# Tatu

Ferramenta de investigação de diários oficiais municipais brasileiros com busca inteligente via IA. Permite que jornalistas façam perguntas sobre publicações oficiais de municípios do Ceará, Pernambuco e Bahia.

## Como funciona

1. **Coleta:** O scraper baixa PDFs dos sites oficiais dos municípios
2. **Indexação:** Os PDFs são enviados ao Vector Store da OpenAI
3. **Consulta:** A API Django responde perguntas em linguagem natural com citações das fontes

## Pré-requisitos

- Python 3.7+
- Chave de API da OpenAI (com acesso à Assistants API)

## Instalação

```bash
# Clone o repositório
git clone <url-do-repositorio>
cd tatu

# Crie e ative o ambiente virtual
python3 -m venv .venv
source .venv/bin/activate  # No Windows: .venv\Scripts\activate

# Instale as dependências
pip install -r requirements.txt
```

## Configuração

Crie um arquivo `.env` na raiz do projeto:

```env
OPEN_API_KEY=sua_chave_openai_aqui
VECTOR_STORE_ID=  # será preenchido automaticamente no passo de indexação
```

## Uso

### 1. Baixar PDFs dos diários oficiais

```bash
python pdfs_scraper.py
```

Os PDFs serão salvos na pasta `diarios_oficiais/`. O script suporta municípios do Ceará, Pernambuco e Bahia e valida automaticamente se os PDFs possuem camada de texto (necessário para busca).

### 2. Indexar PDFs no Vector Store da OpenAI

```bash
python upload_pdfs.py
```

O script cria um Vector Store na OpenAI, envia os PDFs e salva o `VECTOR_STORE_ID` automaticamente no arquivo `.env`.

### 3. Iniciar o servidor da API

```bash
# Aplicar migrações (primeira vez)
python diario_api/manage.py migrate

# Iniciar o servidor
python diario_api/manage.py runserver
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
  -d '{"pergunta": "Quais licitações de merenda foram publicadas em 2023?"}'
```

Resposta:
```json
{
  "resposta": "Foram encontradas as seguintes licitações...",
  "fontes": [
    { "arquivo": "bahia_1.pdf" }
  ]
}
```
