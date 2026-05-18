#!/usr/bin/env python
# coding: utf-8

# In[1]:


import json
import os
from datetime import datetime, timezone
import requests
import uuid

# --------------------
# CONFIG
# --------------------
URL_JSON = "https://diario.imprensaoficial.al.gov.br/apinova/api/editions/published?page=1"
OUTPUT_FILE = "alagoas.json"
DOWNLOAD_BASE_URL = "https://diario.imprensaoficial.al.gov.br/apinova/api/editions/downloadPdf/"
PDF_DIR = "diarios_originais"

# --------------------
# DATA DE HOJE (UTC)
# --------------------
hoje_utc = datetime.now(timezone.utc).date()

# --------------------
# GARANTE QUE A PASTA EXISTE
# --------------------
os.makedirs(PDF_DIR, exist_ok=True)

# --------------------
# CARREGA JSON REMOTO
# --------------------
response = requests.get(URL_JSON, timeout=30)
response.raise_for_status()
data = response.json()
editions = data.get("editions", [])

# --------------------
# CARREGA JSON LOCAL (ou cria vazio)
# --------------------
if os.path.exists(OUTPUT_FILE):
    with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
        saved_editions = json.load(f)
else:
    saved_editions = []

# Para comparação rápida
saved_set = {
    json.dumps(e, sort_keys=True)
    for e in saved_editions
}

novas_edicoes = []

# --------------------
# PROCESSA EDIÇÕES
# --------------------
for edition in editions:
    pub_date_str = edition.get("publication_date")
    if not pub_date_str:
        continue

    pub_date = datetime.fromisoformat(
        pub_date_str.replace("Z", "+00:00")
    ).date()

    if pub_date != hoje_utc:
        continue

    # Gera identificador único para o arquivo PDF
    uid = str(uuid.uuid4())
    pdf_filename = f"{uid}_diario_{edition['number']}.pdf"
    pdf_path = os.path.join(PDF_DIR, pdf_filename)

    registro = {
        "id": edition["id"],
        "number": edition["number"],
        "publication_date": pub_date_str,
        "suplement": edition["suplement"],
        "link": f"{DOWNLOAD_BASE_URL}{edition['id']}",
        "pdf_file": pdf_filename
    }

    registro_serializado = json.dumps(registro, sort_keys=True)

    if registro_serializado not in saved_set:
        # --------------------
        # FAZ DOWNLOAD DO PDF
        # --------------------
        try:
            pdf_url = f"{DOWNLOAD_BASE_URL}{edition['id']}"
            pdf_response = requests.get(pdf_url, timeout=60)
            pdf_response.raise_for_status()

            with open(pdf_path, "wb") as pdf_file:
                pdf_file.write(pdf_response.content)

            print(f"PDF salvo: {pdf_filename}")

        except requests.RequestException as e:
            print(f"Erro ao baixar PDF da edição {edition['id']}: {e}")
            registro["pdf_file"] = None  # Marca como falha no JSON

        novas_edicoes.append(registro)
        saved_set.add(json.dumps(registro, sort_keys=True))

# --------------------
# SALVA SE HOUVER NOVIDADE
# --------------------
if novas_edicoes:
    saved_editions.extend(novas_edicoes)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(saved_editions, f, ensure_ascii=False, indent=2)
    print(f"{len(novas_edicoes)} nova(s) edição(ões) salva(s) em {OUTPUT_FILE}")
else:
    print("Nenhuma edição nova do dia para salvar.")


# In[ ]:




