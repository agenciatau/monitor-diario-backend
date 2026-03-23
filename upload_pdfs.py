"""
Script para fazer upload dos PDFs para um Vector Store da OpenAI.
Execute uma vez (ou quando novos PDFs forem adicionados).
Salva o VECTOR_STORE_ID no arquivo .env automaticamente.
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

client = OpenAI(api_key=os.environ["OPEN_API_KEY"])
PDF_DIR = Path("diarios_oficiais")
ENV_FILE = Path(".env")


def get_or_create_vector_store():
    vector_store_id = os.environ.get("VECTOR_STORE_ID")
    if vector_store_id:
        try:
            vs = client.vector_stores.retrieve(vector_store_id)
            print(f"Usando Vector Store existente: {vs.id} ({vs.name})")
            return vs
        except Exception:
            print("Vector Store do .env não encontrado, criando novo...")

    vs = client.vector_stores.create(name="Diários Oficiais")
    print(f"Vector Store criado: {vs.id}")

    # Salva no .env
    env_content = ENV_FILE.read_text() if ENV_FILE.exists() else ""
    if "VECTOR_STORE_ID" not in env_content:
        with ENV_FILE.open("a") as f:
            f.write(f"\nVECTOR_STORE_ID={vs.id}\n")
    else:
        lines = env_content.splitlines()
        lines = [l if not l.startswith("VECTOR_STORE_ID=") else f"VECTOR_STORE_ID={vs.id}" for l in lines]
        ENV_FILE.write_text("\n".join(lines) + "\n")

    return vs


def list_uploaded_files(vector_store_id):
    """Retorna set de nomes de arquivos já indexados."""
    uploaded = set()
    for f in client.vector_stores.files.list(vector_store_id):
        file_info = client.files.retrieve(f.id)
        uploaded.add(file_info.filename)
    return uploaded


def upload_pdfs(vector_store):
    pdfs = sorted(PDF_DIR.glob("*.pdf"))
    if not pdfs:
        print("Nenhum PDF encontrado em diarios_oficiais/")
        sys.exit(1)

    print(f"\nEncontrados {len(pdfs)} PDFs.")
    already_uploaded = list_uploaded_files(vector_store.id)
    print(f"Já indexados: {len(already_uploaded)}")

    to_upload = [p for p in pdfs if p.name not in already_uploaded]
    if not to_upload:
        print("Todos os PDFs já estão indexados.")
        return

    print(f"Fazendo upload de {len(to_upload)} novos PDFs...\n")
    file_ids = []
    for pdf in to_upload:
        print(f"  Enviando {pdf.name}...", end=" ", flush=True)
        with pdf.open("rb") as f:
            uploaded = client.files.create(file=f, purpose="assistants")
        file_ids.append(uploaded.id)
        print(f"OK ({uploaded.id})")

    # Adiciona todos ao vector store em batch
    print(f"\nAdicionando {len(file_ids)} arquivos ao Vector Store...")
    batch = client.vector_stores.file_batches.create_and_poll(
        vector_store_id=vector_store.id,
        file_ids=file_ids,
    )
    print(f"Status do batch: {batch.status}")
    print(f"Arquivos processados: {batch.file_counts.completed} / {batch.file_counts.total}")
    if batch.file_counts.failed > 0:
        print(f"Falhas: {batch.file_counts.failed}")


def main():
    vs = get_or_create_vector_store()
    upload_pdfs(vs)
    print(f"\nDone. VECTOR_STORE_ID={vs.id}")


if __name__ == "__main__":
    main()
