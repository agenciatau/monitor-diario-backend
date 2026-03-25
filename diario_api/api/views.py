from django.conf import settings
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from openai import OpenAI
from supabase import create_client
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from .wikidata import enrich_entities

client = OpenAI(api_key=settings.OPENAI_API_KEY)
supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
monitor_supabase = create_client(settings.MONITOR_SUPABASE_URL, settings.MONITOR_SUPABASE_KEY)


class ChatRequestSerializer(serializers.Serializer):
    pergunta = serializers.CharField(help_text="Pergunta a ser respondida")
    estado = serializers.CharField(
        required=False, allow_blank=True,
        help_text="Sigla ou nome do estado (ex: 'bahia'). Usado para personalizar o contexto.",
    )


class WikidataEntrySerializer(serializers.Serializer):
    qid = serializers.CharField()
    label = serializers.CharField()
    description = serializers.CharField()
    url = serializers.CharField()
    fatos = serializers.DictField()


class ChatResponseSerializer(serializers.Serializer):
    resposta = serializers.CharField(help_text="Resposta gerada pelo modelo")
    fontes = serializers.ListField(
        child=serializers.DictField(), help_text="Arquivos utilizados como fonte"
    )
    wikidata = serializers.ListField(
        child=WikidataEntrySerializer(),
        help_text="Contexto externo do Wikidata para entidades mencionadas na resposta",
    )


def _search_monitor_config(estado: str) -> dict | None:
    """Busca configuração de monitoramento do estado na tabela monitores do Supabase."""
    if not estado:
        return None
    try:
        result = (
            monitor_supabase.table("monitores")
            .select("uf, description, keywords")
            .eq("uf", estado.upper().strip())
            .eq("is_active", True)
            .limit(1)
            .execute()
        )
        if not result.data:
            return None
        row = result.data[0]
        return {
            "descricao": row.get("description"),
            "palavras_chave": row.get("keywords"),
        }
    except Exception:
        return None


def _build_instructions(monitor_config: dict | None) -> str:
    base = (
        "Você é um assistente especializado em análise de diários oficiais do Nordeste brasileiro. "
        "Responda com base nos documentos fornecidos, citando as fontes relevantes. "
        "Use linguagem clara e objetiva, adequada para jornalistas investigativos."
    )
    if not monitor_config:
        return base

    partes = [base]
    if monitor_config.get("descricao"):
        partes.append(f"Contexto do monitoramento: {monitor_config['descricao']}")
    if monitor_config.get("palavras_chave"):
        keywords = monitor_config["palavras_chave"]
        if isinstance(keywords, list):
            keywords = ", ".join(keywords)
        partes.append(f"Foque especialmente em temas relacionados a: {keywords}.")

    return " ".join(partes)


class ChatView(APIView):
    @extend_schema(request=ChatRequestSerializer, responses=ChatResponseSerializer)
    def post(self, request):
        pergunta = request.data.get("pergunta")
        if not pergunta:
            return Response(
                {"erro": "Pergunta não fornecida"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        vector_store_id = settings.VECTOR_STORE_ID
        if not vector_store_id:
            return Response(
                {"erro": "VECTOR_STORE_ID não configurado. Execute upload_pdfs.py primeiro."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        estado = request.data.get("estado", "")
        monitor_config = _search_monitor_config(estado)
        instrucoes = _build_instructions(monitor_config)

        try:
            response = client.responses.create(
                model="gpt-4o-mini",
                instructions=instrucoes,
                input=pergunta,
                tools=[{
                    "type": "file_search",
                    "vector_store_ids": [vector_store_id],
                }],
            )
        except Exception as e:
            return Response(
                {"erro": f"Erro ao consultar a API: {str(e)}"},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # Extrai texto da resposta
        resposta_texto = ""
        fontes = []
        seen_files = set()
        for item in response.output:
            if item.type == "message":
                for content in item.content:
                    if content.type == "output_text":
                        resposta_texto = content.text
                        for annotation in getattr(content, "annotations", []):
                            if annotation.type == "file_citation":
                                filename = annotation.filename
                                if filename not in seen_files:
                                    seen_files.add(filename)
                                    fontes.append({"arquivo": filename})

        # Enriquecimento com Wikidata: extrai entidades da resposta e busca fatos externos
        wikidata_dados = []
        if resposta_texto:
            wikidata_dados = _enrich_response_with_wikidata(resposta_texto)

        return Response({"resposta": resposta_texto, "fontes": fontes, "wikidata": wikidata_dados})


def _enrich_response_with_wikidata(resposta_texto: str) -> list:
    """
    Uses GPT to extract named entities (people, companies, orgs) from the
    response text, then queries Wikidata for structured facts about each.
    Returns an empty list silently on any failure so the main response is unaffected.
    """
    try:
        extraction = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": (
                    "Liste apenas os nomes de pessoas, empresas e organizações "
                    "mencionadas neste texto. Máximo 5 itens, separados por vírgula, "
                    "sem explicações adicionais. Se não houver nenhum, responda com uma string vazia.\n\n"
                    f"{resposta_texto[:1500]}"
                ),
            }],
            max_tokens=80,
            temperature=0,
        )
        raw = extraction.choices[0].message.content.strip()
        if not raw:
            return []
        entity_names = [e.strip() for e in raw.split(",") if e.strip()]
        return enrich_entities(entity_names)
    except Exception:
        return []


class UploadView(APIView):
    """Endpoint para adicionar novos PDFs via API (opcional)."""

    def post(self, request):
        arquivo = request.FILES.get("arquivo")
        if not arquivo:
            return Response({"erro": "Nenhum arquivo enviado"}, status=status.HTTP_400_BAD_REQUEST)

        vector_store_id = settings.VECTOR_STORE_ID
        if not vector_store_id:
            return Response(
                {"erro": "VECTOR_STORE_ID não configurado"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            uploaded = client.files.create(file=arquivo, purpose="assistants")
            batch = client.vector_stores.file_batches.create_and_poll(
                vector_store_id=vector_store_id,
                file_ids=[uploaded.id],
            )
            return Response({
                "mensagem": "Arquivo indexado com sucesso",
                "file_id": uploaded.id,
                "status": batch.status,
            })
        except Exception as e:
            return Response(
                {"erro": f"Erro ao indexar arquivo: {str(e)}"},
                status=status.HTTP_502_BAD_GATEWAY,
            )
