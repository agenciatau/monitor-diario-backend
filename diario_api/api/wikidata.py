import requests

WIKIDATA_SEARCH_URL = "https://www.wikidata.org/w/api.php"
WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"
HEADERS = {"User-Agent": "TatuBot/1.0 (diarios-oficiais-research)"}


def search_entity(name: str) -> dict | None:
    """Search Wikidata for an entity by name. Returns QID + metadata if found."""
    params = {
        "action": "wbsearchentities",
        "search": name,
        "language": "pt",
        "format": "json",
        "limit": 1,
    }
    try:
        r = requests.get(WIKIDATA_SEARCH_URL, params=params, headers=HEADERS, timeout=5)
        r.raise_for_status()
        results = r.json().get("search", [])
        if results:
            item = results[0]
            return {
                "qid": item["id"],
                "label": item.get("label", name),
                "description": item.get("description", ""),
                "url": f"https://www.wikidata.org/wiki/{item['id']}",
            }
    except Exception:
        pass
    return None


def get_entity_facts(qid: str) -> dict:
    """Fetch key structured facts about a Wikidata entity via SPARQL."""
    query = f"""
    SELECT ?instanceLabel ?countryLabel ?foundedDate ?dissolutionDate WHERE {{
      OPTIONAL {{ wd:{qid} wdt:P31 ?instance }}
      OPTIONAL {{ wd:{qid} wdt:P17 ?country }}
      OPTIONAL {{ wd:{qid} wdt:P571 ?foundedDate }}
      OPTIONAL {{ wd:{qid} wdt:P576 ?dissolutionDate }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "pt,en". }}
    }}
    LIMIT 1
    """
    try:
        r = requests.get(
            WIKIDATA_SPARQL_URL,
            params={"query": query},
            headers={**HEADERS, "Accept": "application/sparql-results+json"},
            timeout=8,
        )
        r.raise_for_status()
        bindings = r.json().get("results", {}).get("bindings", [])
        if bindings:
            row = bindings[0]
            facts = {}
            if "instanceLabel" in row:
                facts["tipo"] = row["instanceLabel"]["value"]
            if "countryLabel" in row:
                facts["pais"] = row["countryLabel"]["value"]
            if "foundedDate" in row:
                facts["fundacao"] = row["foundedDate"]["value"][:10]
            if "dissolutionDate" in row:
                facts["dissolucao"] = row["dissolutionDate"]["value"][:10]
            return facts
    except Exception:
        pass
    return {}


def enrich_entities(entity_names: list) -> list:
    """
    For each entity name, search Wikidata and return enriched data.
    Caps at 5 entities to keep latency reasonable.
    """
    results = []
    seen_qids = set()
    for name in entity_names[:5]:
        entity = search_entity(name)
        if not entity or entity["qid"] in seen_qids:
            continue
        seen_qids.add(entity["qid"])
        facts = get_entity_facts(entity["qid"])
        results.append({**entity, "fatos": facts})
    return results
