const SEARCH_URL = "https://www.wikidata.org/w/api.php";
const SPARQL_URL = "https://query.wikidata.org/sparql";
const HEADERS = { "User-Agent": "TatuBot/1.0 (diarios-oficiais-research)" };

const PERSON_KEYWORDS = [
  "político", "política", "prefeito", "prefeita", "governador", "governadora",
  "deputado", "deputada", "senador", "senadora", "vereador", "vereadora",
  "secretário", "secretária", "juiz", "juíza", "promotor", "promotora",
  "servidor", "servidora", "gestor", "gestora", "diretor", "diretora",
  "ministro", "ministra", "presidente", "candidato", "candidata",
  "politician", "mayor", "governor", "senator", "judge",
];

interface WikidataEntity {
  qid: string;
  label: string;
  description: string;
  url: string;
  fatos: Record<string, string>;
}

function isPersonDescription(description: string): boolean {
  const lower = description.toLowerCase();
  return PERSON_KEYWORDS.some((kw) => lower.includes(kw));
}

async function searchEntity(name: string): Promise<{ qid: string; label: string; description: string; url: string } | null> {
  const params = new URLSearchParams({
    action: "wbsearchentities",
    search: name,
    language: "pt",
    format: "json",
    limit: "5",
  });
  try {
    const r = await fetch(`${SEARCH_URL}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    const results: any[] = data.search ?? [];
    if (results.length === 0) return null;

    // Prefer a result whose description looks like a person
    const chosen = results.find((item) => isPersonDescription(item.description ?? "")) ?? results[0];
    return {
      qid: chosen.id,
      label: chosen.label ?? name,
      description: chosen.description ?? "",
      url: `https://www.wikidata.org/wiki/${chosen.id}`,
    };
  } catch {
    return null;
  }
}

async function getEntityFacts(qid: string): Promise<Record<string, string>> {
  const query = `
    SELECT ?instanceLabel ?countryLabel ?foundedDate ?dissolutionDate
           ?birthDate ?deathDate ?occupationLabel ?positionLabel
           ?partyLabel ?citizenshipLabel ?birthPlaceLabel
           ?parentOrgLabel ?locationLabel ?population WHERE {
      OPTIONAL { wd:${qid} wdt:P31 ?instance }
      OPTIONAL { wd:${qid} wdt:P17 ?country }
      OPTIONAL { wd:${qid} wdt:P571 ?foundedDate }
      OPTIONAL { wd:${qid} wdt:P576 ?dissolutionDate }
      OPTIONAL { wd:${qid} wdt:P569 ?birthDate }
      OPTIONAL { wd:${qid} wdt:P570 ?deathDate }
      OPTIONAL { wd:${qid} wdt:P106 ?occupation }
      OPTIONAL { wd:${qid} wdt:P39 ?position }
      OPTIONAL { wd:${qid} wdt:P102 ?party }
      OPTIONAL { wd:${qid} wdt:P27 ?citizenship }
      OPTIONAL { wd:${qid} wdt:P19 ?birthPlace }
      OPTIONAL { wd:${qid} wdt:P749 ?parentOrg }
      OPTIONAL { wd:${qid} wdt:P131 ?location }
      OPTIONAL { wd:${qid} wdt:P1082 ?population }
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
    if (row.birthDate) facts.nascimento = row.birthDate.value.slice(0, 10);
    if (row.deathDate) facts.falecimento = row.deathDate.value.slice(0, 10);
    if (row.occupationLabel) facts.ocupacao = row.occupationLabel.value;
    if (row.positionLabel) facts.cargo = row.positionLabel.value;
    if (row.partyLabel) facts.partido = row.partyLabel.value;
    if (row.citizenshipLabel) facts.nacionalidade = row.citizenshipLabel.value;
    if (row.birthPlaceLabel) facts.naturalidade = row.birthPlaceLabel.value;
    if (row.parentOrgLabel) facts.orgao_superior = row.parentOrgLabel.value;
    if (row.locationLabel) facts.localizacao = row.locationLabel.value;
    if (row.population) facts.populacao = row.population.value.split("^^")[0];
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
