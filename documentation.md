# Documentação do Projeto: Análise de Diários Oficiais com APIs Gerenciadas

---

## Sumário

1. [Visão Geral](#1-visão-geral)
2. [Arquitetura Revisada](#2-arquitetura-revisada)
   - 2.1 [Fluxo de Dados](#21-fluxo-de-dados)
3. [Componentes e Decisões Técnicas](#3-componentes-e-decisões-técnicas)
   - 3.1 [Preparação dos Documentos (Sem OCR)](#31-preparação-dos-documentos-sem-ocr)
   - 3.2 [Google Gemini File Search (Alternativa Principal)](#32-google-gemini-file-search-alternativa-principal)
   - 3.3 [OpenAI Retrieval (Alternativa Secundária)](#33-openai-retrieval-alternativa-secundária)
   - 3.4 [Backend Django (Orquestrador)](#34-backend-django-orquestrador)
   - 3.5 [Integração com Frontend Existente](#35-integração-com-frontend-existente)
4. [Pipeline do MVP (4 Semanas)](#4-pipeline-do-mvp-4-semanas)
5. [Custos Estimados](#5-custos-estimados)
6. [Considerações de Segurança e Privacidade](#6-considerações-de-segurança-e-privacidade)
7. [Próximos Passos e Evoluções](#7-próximos-passos-e-evoluções)
8. [Apêndice: Exemplo de Código](#8-apêndice-exemplo-de-código)

---

## 1. Visão Geral

Este projeto tem como objetivo fornecer uma ferramenta para jornalistas investigarem diários oficiais de municípios. A solução utiliza APIs gerenciadas (Google Gemini File Search ou OpenAI Retrieval) para todo o pipeline de **RAG (Retrieval-Augmented Generation)**. Isso elimina a necessidade de:

- Infraestrutura local (banco vetorial, LLM)
- Treinamento ou hospedagem de modelos próprios
- OCR, pois trabalharemos apenas com PDFs que já possuem camada de texto

A arquitetura final consiste em:

- **Indexação:** upload dos PDFs para a plataforma escolhida, que gerencia chunking, embeddings e armazenamento.
- **Consulta:** um backend Django simples que recebe perguntas do frontend existente ([MonitorDiario](https://monitordiario.com.br)), chama a API da plataforma com file search ativado e retorna a resposta já contextualizada, com citações automáticas.

---

## 2. Arquitetura Revisada

### 2.1 Fluxo de Dados

1. **Preparação (uma vez ou periódica)**
   - PDFs textuais dos diários são enviados para o Google Gemini File Search (via Google AI Studio ou API) ou para o OpenAI Assistants (como arquivos anexados).
   - A plataforma automaticamente divide os documentos em chunks, gera embeddings e cria uma base de conhecimento pesquisável.

2. **Consulta (online)**
   - O jornalista digita uma pergunta no frontend existente.
   - O frontend envia a pergunta para o endpoint `/api/chat` do backend Django.
   - O backend chama a API do Gemini (ou OpenAI), incluindo a pergunta e instruções para usar o corpus/index de arquivos.
   - A plataforma retorna a resposta gerada pelo modelo de linguagem, já enriquecida com citações que indicam quais trechos dos documentos foram usados.
   - O backend repassa essa resposta ao frontend, que a exibe ao usuário.

---

## 3. Componentes e Decisões Técnicas

### 3.1 Preparação dos Documentos (Sem OCR)

**Critério de inclusão:** apenas PDFs que já possuem camada de texto (digitalizados com texto selecionável).

**Ação:**
- Coletar um lote inicial (ex.: 50 a 100 PDFs).
- Fazer upload via Google AI Studio (ou via API) para criar um **corpus** no Gemini File Search.
- Alternativamente, usar o **Assistants API** da OpenAI: criar um assistente, anexar os arquivos e habilitar a ferramenta de recuperação.

**Vantagens:**
- Nenhum trabalho manual de chunking, embedding ou indexação.
- Atualização simples: basta adicionar novos PDFs à base.

### 3.2 Google Gemini File Search (Alternativa Principal)

Com base no [anúncio oficial](https://blog.google/innovation-and-ai/technology/developers-tools/file-search-gemini-api/), o File Search Tool é um sistema RAG totalmente gerenciado:

- **Armazenamento e embeddings em consulta:** gratuitos.
- **Criação de embeddings na indexação:** $0,15 por 1 milhão de tokens.
- **Citações automáticas:** as respostas incluem referências aos trechos usados.
- **Formatos suportados:** PDF, DOCX, TXT, JSON e vários outros.

**Uso na API:**

```python
import google.generativeai as genai

genai.configure(api_key="YOUR_API_KEY")

# Criar um corpus (se ainda não existir)
corpus = genai.create_corpus(display_name="Diários Oficiais")

# Fazer upload de arquivos
file = genai.upload_file("diario_exemplo.pdf", corpus=corpus)

# Consulta
model = genai.GenerativeModel('gemini-1.5-flash')
response = model.generate_content(
    "Quais licitações de merenda foram publicadas em 2023?",
    tools=[genai.tools.FileSearchTool(corpus=corpus)]
)
print(response.text)
print(response.citations)  # fontes utilizadas
```

### 3.3 OpenAI Retrieval (Alternativa Secundária)

Caso opte pelo ecossistema OpenAI, a funcionalidade equivalente é o Assistants API com Retrieval.

- O assistente pode ter arquivos anexados; a recuperação é ativada automaticamente.
- **Cobrança:** armazenamento (US$ 0,10/GB/mês) + tokens de entrada/saída.

Exemplo simplificado (usando a biblioteca OpenAI):

```python
from openai import OpenAI

client = OpenAI(api_key="YOUR_KEY")

# Criar um assistente com ferramenta de retrieval
assistant = client.beta.assistants.create(
    name="Analisador de Diários",
    instructions="Você responde com base nos arquivos fornecidos.",
    model="gpt-4o-mini",
    tools=[{"type": "file_search"}]
)

# Fazer upload de um arquivo
file = client.files.create(
    file=open("diario.pdf", "rb"),
    purpose="assistants"
)

# Atualizar o assistente com o arquivo
assistant = client.beta.assistants.update(
    assistant.id,
    file_ids=[file.id]
)

# Criar uma thread e uma mensagem
thread = client.beta.threads.create()
message = client.beta.threads.messages.create(
    thread_id=thread.id,
    role="user",
    content="Quais contratos foram assinados em janeiro?"
)

# Executar
run = client.beta.threads.runs.create_and_poll(
    thread_id=thread.id,
    assistant_id=assistant.id
)

# Obter resposta
messages = client.beta.threads.messages.list(thread_id=thread.id)
print(messages.data[0].content[0].text.value)
```

### 3.4 Backend Django (Orquestrador)

O backend será extremamente enxuto:

- **Framework:** Django + Django REST Framework.
- **Endpoints:**
  - `POST /api/chat/` – recebe `{"pergunta": "..."}` e retorna `{"resposta": "...", "fontes": [...]}`.
  - Opcional: `POST /api/upload/` – para adicionar novos PDFs à base (em versões futuras).
- **Integração:** dentro da view, o código chama a API escolhida (Gemini ou OpenAI) e traduz a resposta para o formato esperado pelo frontend.
- **Autenticação:** pode ser usada uma chave de API para restringir acesso apenas ao frontend autorizado.

Estrutura do projeto (simplificada):

```
diario_api/
├── manage.py
├── diario_api/
│   ├── settings.py
│   └── urls.py
└── api/
    ├── views.py          # ChatView com chamada à API externa
    ├── urls.py
    └── utils.py          # (opcional) funções auxiliares
```

### 3.5 Integração com Frontend Existente

O frontend monitordiario.com.br já é uma ferramenta de monitoramento. A integração será feita por:

- API pública que o backend Django expõe (ex.: `https://api.monitordiario.com.br/v1/chat`).
- O frontend deve fazer uma chamada HTTP (POST) com a pergunta do usuário e exibir a resposta e as fontes.

Formato de requisição (exemplo):

```json
{
  "pergunta": "Mostre licitações de merenda escolar em 2023"
}
```

Formato de resposta:

```json
{
  "resposta": "Foram encontradas as seguintes licitações...",
  "fontes": [
    {
      "arquivo": "diario_2023_01_15.pdf",
      "trecho": "Extrato de Contrato nº 001/2023...",
      "pagina": 5
    }
  ]
}
```

Caso o frontend já tenha um formato próprio, adaptamos o backend para corresponder.

---

## 4. Pipeline do MVP (4 Semanas)

| Semana | Atividades Principais |
|--------|----------------------|
| 1 | Configuração das contas (Google Cloud / OpenAI), seleção de PDFs de teste, upload inicial para File Search (ou Assistants). |
| 2 | Desenvolvimento do backend Django: endpoint `/chat`, chamada à API externa, tratamento de respostas e citações. |
| 3 | Integração com frontend existente: alinhamento de formato, testes de ponta a ponta, ajustes. |
| 4 | Testes com volume maior, documentação da API, refinamentos finais. |

**Marcos de entrega:**

- Fim da semana 1: pelo menos 50 PDFs indexados e verificados.
- Fim da semana 2: backend funcional (testável via Postman).
- Fim da semana 3: integração completa com frontend, fluxo de usuário funcionando.
- Fim da semana 4: documentação final e demonstração.

---

## 5. Custos Estimados

Considerando o uso do Gemini File Search (mais transparente):

| Item | Cálculo | Custo |
|------|---------|-------|
| Indexação de 50 PDFs (estimativa 500k tokens) | 500k tokens × $0,15 / 1M tokens | $0,075 (único) |
| Armazenamento (primeiros 1 GB) | Gratuito | $0 |
| Consultas: 100 perguntas/dia × 30 dias | 3.000 consultas/mês | Embeddings em consulta: gratuito |
| Saída (Gemini 1.5 Flash): $0,0025/1k tokens | ~$7,50/mês | — |
| **Total mensal (após indexação)** | — | **< $10/mês** |

Caso use OpenAI Retrieval:

- Armazenamento: ~$0,10/GB/mês (para 100 PDFs, < 0,5 GB) → $0,05/mês.
- Tokens de entrada e saída: dependem do uso, mas para o mesmo volume, cerca de $5–10/mês.
- Total mensal também muito baixo (< $15/mês).

Infraestrutura: o backend Django pode rodar em instâncias gratuitas (Render, Fly.io) ou em um servidor pequeno (~$5/mês).

---

## 6. Considerações de Segurança e Privacidade

- Os PDFs são públicos, mas as perguntas dos jornalistas podem revelar linhas de investigação.
- Gemini/OpenAI: os dados podem ser processados nos servidores dos provedores. É importante verificar as políticas de privacidade e, se necessário, optar por regiões específicas (ex.: Google Cloud na América do Sul).
- Recomenda-se não armazenar histórico de perguntas no backend, a menos que haja autorização.
- O acesso à API deve ser restrito ao frontend autorizado (via chave de API ou JWT).

---

## 7. Próximos Passos e Evoluções

- Melhorar a cobertura de documentos: automatizar o download diário de novos diários e o upload para a base.
- Adicionar outros tipos de documentos: leis, editais, etc.
- Criar um painel de administração para gerenciar a base de conhecimento.
- Implementar feedback dos usuários para melhorar as respostas.
- Avaliar a troca para modelos mais poderosos (ex.: Gemini 1.5 Pro) se a qualidade das respostas exigir.

---

## 8. Apêndice: Exemplo de Código (Backend Django com Gemini)

**`api/views.py`** (usando a biblioteca `google-generativeai`):

```python
import google.generativeai as genai
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status

genai.configure(api_key="YOUR_GEMINI_API_KEY")
CORPUS_ID = "diarios_oficiais"  # substitua pelo ID do seu corpus

class ChatView(APIView):
    def post(self, request):
        pergunta = request.data.get("pergunta")
        if not pergunta:
            return Response({"erro": "Pergunta não fornecida"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            # Recuperar o corpus (ou criar se não existir)
            corpus = genai.get_corpus(CORPUS_ID)
        except:
            corpus = genai.create_corpus(display_name="Diários Oficiais", name=CORPUS_ID)

        # Chamar o modelo com File Search Tool
        model = genai.GenerativeModel('gemini-1.5-flash')
        response = model.generate_content(
            pergunta,
            tools=[genai.tools.FileSearchTool(corpus=corpus)]
        )

        # Extrair citações
        fontes = []
        if hasattr(response, 'citations'):
            for citation in response.citations:
                fontes.append({
                    "arquivo": citation.file_name,
                    "trecho": citation.text,
                    "pagina": citation.page_number
                })

        return Response({
            "resposta": response.text,
            "fontes": fontes
        })
```

**`api/urls.py`:**

```python
from django.urls import path
from .views import ChatView

urlpatterns = [
    path('chat/', ChatView.as_view(), name='chat'),
]
```

**`diario_api/urls.py`:**

```python
from django.urls import path, include

urlpatterns = [
    path('api/', include('api.urls')),
]
```

---

## Conclusão

Esta documentação descreve a arquitetura simplificada e o plano de implementação para o sistema de análise de diários oficiais utilizando APIs gerenciadas. A abordagem reduz drasticamente a complexidade, os custos e o tempo de desenvolvimento, permitindo a entrega de um MVP funcional em 4 semanas, integrado ao frontend existente do MonitorDiario. A solução é escalável, segura e pode ser evoluída com novas funcionalidades conforme a demanda.
