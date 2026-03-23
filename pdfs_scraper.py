import os
import re
import requests
from bs4 import BeautifulSoup
from PyPDF2 import PdfReader
import time
import random
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

# Strategies:
#   'scrape'       – parses HTML listing page for <a href="*.pdf"> links
#   'date_pattern' – generates URLs based on recent business days
#   'id_range'     – generates URLs based on incremental IDs (most recent first)

HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; DiarioBot/1.0)'}

sites = {
    'acre': {
        'strategy': 'scrape',
        'url_lista': 'https://diario.ac.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'alagoas': {
        'strategy': 'scrape',
        'url_lista': 'https://diario.imprensaoficial.al.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'amapa': {
        'strategy': 'id_range',
        # DIOFE-AP – IDs incrementais; ~9860 era 2024
        'url_pattern': 'https://diofe.portal.ap.gov.br/portal/edicoes/download/{id}',
        'id_start': 10100,
        'id_count': 30,
    },
    'amazonas': {
        'strategy': 'scrape',
        'url_lista': 'https://diario.imprensaoficial.am.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'bahia': {
        'strategy': 'id_range',
        # EGBANet – IDs incrementais; ~21260+ era início de 2026
        'url_pattern': 'https://egbanet.egba.ba.gov.br/alba/portal/edicoes/download/{id}',
        'id_start': 21260,
        'id_count': 30,
    },
    'ceara': {
        'strategy': 'scrape',
        'url_lista': 'https://www.casacivil.ce.gov.br/diario-oficial/',
        'selector': 'a[href$=".pdf"]',
    },
    'distrito_federal': {
        'strategy': 'scrape',
        'url_lista': 'https://dodf.df.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'espirito_santo': {
        'strategy': 'id_range',
        # IOES – IDs incrementais
        'url_pattern': 'https://ioes.dio.es.gov.br/portal/edicoes/download/{id}',
        'id_start': 8100,
        'id_count': 30,
    },
    'goias': {
        'strategy': 'id_range',
        # DOE-GO – IDs incrementais; ~6462 era 2024
        'url_pattern': 'https://diariooficial.abc.go.gov.br/portal/edicoes/download/{id}',
        'id_start': 6800,
        'id_count': 30,
    },
    'maranhao': {
        'strategy': 'date_pattern',
        # PDF direto por data
        'url_pattern': 'https://www.diariooficial.ma.gov.br/download.php?arqv=1&arq={date}',
        'days_back': 15,
    },
    'mato_grosso': {
        'strategy': 'id_range',
        # IOMAT – IDs incrementais; ~18226 era 2025
        'url_pattern': 'https://www.iomat.mt.gov.br/portal/edicoes/download/{id}',
        'id_start': 18500,
        'id_count': 30,
    },
    'mato_grosso_do_sul': {
        'strategy': 'scrape',
        'url_lista': 'https://www.spdo.ms.gov.br/diariodoe',
        'selector': 'a[href$=".pdf"]',
    },
    'minas_gerais': {
        'strategy': 'scrape',
        'url_lista': 'https://www.jornalminasgerais.mg.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'para': {
        'strategy': 'date_pattern',
        # PDF por data: ioepa.com.br/pages/YYYY/YYYY.MM.DD.DOE.pdf
        'url_pattern': 'https://ioepa.com.br/pages/{year}/{year}.{month}.{day}.DOE.pdf',
        'days_back': 15,
    },
    'paraiba': {
        'strategy': 'scrape',
        'url_lista': 'https://auniao.pb.gov.br/doe',
        'selector': 'a[href$=".pdf"]',
    },
    'parana': {
        'strategy': 'scrape',
        'url_lista': 'https://www.imprensaoficial.pr.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'pernambuco': {
        'strategy': 'date_pattern',
        # PDFs disponíveis diretamente no S3 da CEPE por data
        'url_pattern': 'https://cepebr-prod.s3.amazonaws.com/1/cadernos/{year}/{date}/1-PoderExecutivo/PoderExecutivo({date}).pdf',
        'days_back': 15,
    },
    'piaui': {
        'strategy': 'scrape',
        'url_lista': 'https://www.diario.pi.gov.br/doe/busca',
        'selector': 'a[href$=".pdf"]',
    },
    'rio_de_janeiro': {
        'strategy': 'scrape',
        'url_lista': 'https://portal.ioerj.com.br/diario-oficial/',
        'selector': 'a[href$=".pdf"]',
    },
    'rio_grande_do_norte': {
        'strategy': 'scrape',
        'url_lista': 'http://www.diariooficial.rn.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'rio_grande_do_sul': {
        'strategy': 'scrape',
        'url_lista': 'https://www.diariooficial.rs.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'rondonia': {
        'strategy': 'scrape',
        'url_lista': 'https://diof.ro.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'roraima': {
        'strategy': 'scrape',
        'url_lista': 'https://www.imprensaoficial.rr.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'santa_catarina': {
        'strategy': 'scrape',
        'url_lista': 'https://doe.sea.sc.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'sao_paulo': {
        'strategy': 'scrape',
        'url_lista': 'https://doe.sp.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
    'sergipe': {
        'strategy': 'scrape',
        'url_lista': 'https://iose.se.gov.br/diario-oficial',
        'selector': 'a[href$=".pdf"]',
    },
    'tocantins': {
        'strategy': 'scrape',
        'url_lista': 'https://diariooficial.to.gov.br/',
        'selector': 'a[href$=".pdf"]',
    },
}


# ──────────────────────────────────────────────
# Date extraction helpers
# ──────────────────────────────────────────────

def _extrair_data_da_url(url):
    """Tenta extrair data YYYYMMDD de uma URL ou nome de arquivo."""
    if not url:
        return None
    # Direct 8-digit date (YYYYMMDD)
    for pattern in [
        r'[/_-](\d{8})[/_.-]',
        r'(\d{8})\.pdf',
        r'[=(](\d{8})[).]',
    ]:
        m = re.search(pattern, url, re.IGNORECASE)
        if m:
            s = m.group(1)
            try:
                datetime.strptime(s, '%Y%m%d')
                return s
            except ValueError:
                pass
    # YYYY/MM/DD or YYYY-MM-DD (ISO order)
    m = re.search(r'\b(\d{4})[/_-](\d{2})[/_-](\d{2})\b', url)
    if m:
        try:
            d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            return d.strftime('%Y%m%d')
        except ValueError:
            pass
    # DD-MM-YYYY or DD/MM/YYYY (Brazilian/European order)
    m = re.search(r'\b(\d{2})[-/](\d{2})[-/](\d{4})\b', url)
    if m:
        try:
            d = datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            return d.strftime('%Y%m%d')
        except ValueError:
            pass
    return None


def _extrair_data_do_header(headers):
    """Extrai data do Content-Disposition ou Last-Modified."""
    # Content-Disposition: filename might contain date
    cd = headers.get('Content-Disposition', '') or headers.get('content-disposition', '')
    if cd:
        m = re.search(r'(\d{8})', cd)
        if m:
            try:
                datetime.strptime(m.group(1), '%Y%m%d')
                return m.group(1)
            except ValueError:
                pass
        # DD-MM-YYYY or DD.MM.YYYY
        m = re.search(r'(\d{2})[._-](\d{2})[._-](\d{4})', cd)
        if m:
            try:
                d = datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)))
                return d.strftime('%Y%m%d')
            except ValueError:
                pass
    # Last-Modified
    lm = headers.get('Last-Modified', '') or headers.get('last-modified', '')
    if lm:
        try:
            d = parsedate_to_datetime(lm)
            return d.strftime('%Y%m%d')
        except Exception:
            pass
    return None


def _extrair_data_do_pdf(caminho):
    """Extrai data do metadata ou do texto da primeira página do PDF."""
    try:
        with open(caminho, 'rb') as f:
            leitor = PdfReader(f)
            # PDF metadata
            info = leitor.metadata
            if info:
                for campo in ['/CreationDate', '/ModDate']:
                    val = str(info.get(campo, ''))
                    m = re.search(r'D:(\d{8})', val)
                    if m:
                        try:
                            datetime.strptime(m.group(1), '%Y%m%d')
                            return m.group(1)
                        except ValueError:
                            pass
            # First page text – look for Brazilian DD/MM/YYYY
            if leitor.pages:
                texto = leitor.pages[0].extract_text() or ''
                m = re.search(r'\b(\d{2})/(\d{2})/(\d{4})\b', texto)
                if m:
                    try:
                        d = datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)))
                        return d.strftime('%Y%m%d')
                    except ValueError:
                        pass
    except Exception:
        pass
    return None


# ──────────────────────────────────────────────
# URL generators
# ──────────────────────────────────────────────

def _gerar_urls_por_data(pattern, days_back):
    """Retorna list[(url, date_str)] para os últimos dias úteis.

    Suporta os tokens: {date} (YYYYMMDD), {year}, {month} (MM), {day} (DD).
    """
    resultados = []
    dia = datetime.today()
    tentativas = 0
    while len(resultados) < days_back and tentativas < days_back * 3:
        tentativas += 1
        dia -= timedelta(days=1)
        if dia.weekday() >= 5:  # skip weekends
            continue
        date_str = dia.strftime('%Y%m%d')
        url = pattern.format(
            date=date_str,
            year=dia.strftime('%Y'),
            month=dia.strftime('%m'),
            day=dia.strftime('%d'),
        )
        resultados.append((url, date_str))
    return resultados


def _gerar_urls_por_id(pattern, id_start, id_count):
    """Retorna list[(url, None)] em ordem decrescente (mais recentes primeiro)."""
    return [
        (pattern.format(id=i), None)
        for i in range(id_start + id_count - 1, id_start - 1, -1)
    ]


def coletar_links_pdf(site_info):
    """Retorna list[(url, date_str_or_None)] de acordo com a estratégia."""
    strategy = site_info['strategy']

    if strategy == 'date_pattern':
        return _gerar_urls_por_data(site_info['url_pattern'], site_info['days_back'])

    if strategy == 'id_range':
        return _gerar_urls_por_id(
            site_info['url_pattern'],
            site_info['id_start'],
            site_info['id_count'],
        )

    # strategy == 'scrape'
    url = site_info['url_lista']
    selector = site_info['selector']
    try:
        resp = requests.get(url, timeout=15, headers=HEADERS)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, 'html.parser')
        resultados = []
        for link in soup.select(selector):
            href = link.get('href', '')
            if not href:
                continue
            absolute = requests.compat.urljoin(url, href)
            if absolute.lower().endswith('.pdf'):
                date_str = _extrair_data_da_url(absolute)
                resultados.append((absolute, date_str))
        return resultados
    except Exception as e:
        print(f"  Erro ao acessar {url}: {e}")
        return []


# ──────────────────────────────────────────────
# Download
# ──────────────────────────────────────────────

def baixar_pdf(url, nome_arquivo):
    """Baixa PDF. Retorna (sucesso, headers, url_final)."""
    try:
        resp = requests.get(url, stream=True, timeout=30,
                            allow_redirects=True, headers=HEADERS)
        resp.raise_for_status()
        with open(nome_arquivo, 'wb') as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        return True, dict(resp.headers), resp.url
    except Exception as e:
        print(f"  Erro ao baixar {url}: {e}")
        return False, {}, url


def pdf_tem_texto(caminho_pdf):
    """Verifica se o PDF possui camada de texto (não é apenas imagem)."""
    try:
        with open(caminho_pdf, 'rb') as f:
            leitor = PdfReader(f)
            paginas = min(3, len(leitor.pages))
            for i in range(paginas):
                texto = leitor.pages[i].extract_text()
                if texto and len(texto.strip()) > 50:
                    return True
        return False
    except Exception as e:
        print(f"  Erro ao analisar PDF {caminho_pdf}: {e}")
        return False


# ──────────────────────────────────────────────
# Rename legacy files (no date in name)
# ──────────────────────────────────────────────

def renomear_pdfs_existentes(download_dir):
    """Renomeia arquivos no padrão antigo '{estado}_{N}.pdf' para incluir data."""
    pasta = Path(download_dir)
    padrao_legado = re.compile(r'^([a-z_]+)_(\d{1,4})\.pdf$')
    renomeados = 0

    for pdf in sorted(pasta.glob('*.pdf')):
        m = padrao_legado.match(pdf.name)
        if not m:
            continue  # already has date or different format
        estado, num = m.groups()
        data = _extrair_data_do_pdf(str(pdf))
        if data:
            novo_nome = pasta / f"{estado}_{data}.pdf"
            # Avoid overwriting an existing file
            if novo_nome.exists():
                novo_nome = pasta / f"{estado}_{data}_{num}.pdf"
            pdf.rename(novo_nome)
            print(f"  Renomeado: {pdf.name} → {novo_nome.name}")
            renomeados += 1
        else:
            print(f"  Sem data extraível: {pdf.name} (mantido)")

    if renomeados:
        print(f"  {renomeados} arquivo(s) renomeado(s).\n")


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main():
    alvo = 54          # ~2 PDFs por estado × 27 estados
    max_por_estado = 3
    download_dir = 'diarios_oficiais'
    os.makedirs(download_dir, exist_ok=True)

    print("=== Renomeando arquivos existentes ===")
    renomear_pdfs_existentes(download_dir)

    pdfs_baixados = 0
    nomes_usados = set(os.listdir(download_dir))  # evita sobreescrever
    datas_por_estado = {}                          # controla sufixos de duplicatas

    estados = list(sites.keys())
    random.shuffle(estados)

    for estado in estados:
        if pdfs_baixados >= alvo:
            break

        print(f"\n=== {estado.upper()} ===")
        links = coletar_links_pdf(sites[estado])

        if not links:
            print("  Nenhum link encontrado.")
            continue

        pdfs_deste_estado = 0
        for link, data_conhecida in links:
            if pdfs_baixados >= alvo or pdfs_deste_estado >= max_por_estado:
                break

            temp = os.path.join(download_dir, f"_tmp_{estado}_{int(time.time())}.pdf")
            print(f"  Baixando {link} ...")
            sucesso, headers, url_final = baixar_pdf(link, temp)

            if not sucesso:
                time.sleep(1)
                continue

            if not pdf_tem_texto(temp):
                os.remove(temp)
                print("  Descartado (sem camada de texto).")
                time.sleep(1)
                continue

            # Determine publication date – cascade through available sources
            data = (data_conhecida
                    or _extrair_data_da_url(url_final)
                    or _extrair_data_da_url(link)
                    or _extrair_data_do_header(headers)
                    or _extrair_data_do_pdf(temp)
                    or datetime.today().strftime('%Y%m%d'))

            # Build filename and handle same-state/same-date duplicates
            chave = f"{estado}_{data}"
            idx = datas_por_estado.get(chave, 0) + 1
            datas_por_estado[chave] = idx

            sufixo = f"_{idx}" if idx > 1 else ""
            nome_arquivo = f"{estado}_{data}{sufixo}.pdf"

            # Extra safety: don't overwrite
            while nome_arquivo in nomes_usados:
                idx += 1
                sufixo = f"_{idx}"
                nome_arquivo = f"{estado}_{data}{sufixo}.pdf"

            caminho_final = os.path.join(download_dir, nome_arquivo)
            os.rename(temp, caminho_final)
            nomes_usados.add(nome_arquivo)

            pdfs_baixados += 1
            pdfs_deste_estado += 1
            print(f"  ✓ Salvo: {nome_arquivo}  ({pdfs_baixados}/{alvo})")

            time.sleep(1)

    print(f"\nConcluído. {pdfs_baixados} PDFs textuais salvos em '{download_dir}'.")


if __name__ == "__main__":
    main()
