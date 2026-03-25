const SEARCH_URL = "https://www.wikidata.org/w/api.php";
const SPARQL_URL = "https://query.wikidata.org/sparql";
const HEADERS = { "User-Agent": "TatuBot/1.0 (diarios-oficiais-research)" };

interface WikidataEntity {
  qid: string;
  label: string;
  description: string;
  url: string;
  fatos: Record<string, string>;
}

async function searchEntity(name: string): Promise<{ qid: string; label: string; description: string; url: string } | null> {
  const params = new URLSearchParams({
    action: "wbsearchentities",
    search: name,
    language: "pt",
    format: "json",
    limit: "1",
  });
  try {
    const r = await fetch(`${SEARCH_URL}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    const results = data.search ?? [];
    if (results.length === 0) return null;
    const item = results[0];
    return {
      qid: item.id,
      label: item.label ?? name,
      description: item.description ?? "",
      url: `https://www.wikidata.org/wiki/${item.id}`,
    };
  } catch {
    return null;
  }
}

async function getEntityFacts(qid: string): Promise<Record<string, string>> {
  const query = `
    SELECT ?instanceLabel ?countryLabel ?foundedDate ?dissolutionDate WHERE {
      OPTIONAL { wd:${qid} wdt:P31 ?instance }
      OPTIONAL { wd:${qid} wdt:P17 ?country }
      OPTIONAL { wd:${qid} wdt:P571 ?foundedDate }
      OPTIONAL { wd:${qid} wdt:P576 ?dissolutionDate }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "pt,en". }
    }
    LIMIT 1
  `;
  try {
    const r = await fetch(`${SPARQL_URL}?query=${encodeURIComponent(query)}`, {
      headers: { ...HEADERS, Accept: "application/sparql-results+json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    const bindings = data.results?.bindings ?? [];
    if (bindings.length === 0) return {};
    const row = bindings[0];
    const facts: Record<string, string> = {};
    if (row.instanceLabel) facts.tipo = row.instanceLabel.value;
    if (row.countryLabel) facts.pais = row.countryLabel.value;
    if (row.foundedDate) facts.fundacao = row.foundedDate.value.slice(0, 10);
    if (row.dissolutionDate) facts.dissolucao = row.dissolutionDate.value.slice(0, 10);
    return facts;
  } catch {
    return {};
  }
}

export async function enrichEntities(names: string[]): Promise<WikidataEntity[]> {
  const results: WikidataEntity[] = [];
  const seenQids = new Set<string>();
  for (const name of names.slice(0, 5)) {
    const entity = await searchEntity(name);
    if (!entity || seenQids.has(entity.qid)) continue;
    seenQids.add(entity.qid);
    const fatos = await getEntityFacts(entity.qid);
    results.push({ ...entity, fatos });
  }
  return results;
}
