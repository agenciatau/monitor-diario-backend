export interface MonitorConfig {
  descricao?: string | null;
  palavras_chave?: string | string[] | null;
}

export function buildInstructions(config: MonitorConfig | null): string {
  const base =
    "Você é um assistente especializado em análise de diários oficiais do Nordeste brasileiro. " +
    "Responda com base nos documentos fornecidos, citando as fontes relevantes. " +
    "Use linguagem clara e objetiva, adequada para jornalistas investigativos.";

  if (!config) return base;

  const partes = [base];

  if (config.descricao) {
    partes.push(`Contexto do monitoramento: ${config.descricao}`);
  }

  if (config.palavras_chave) {
    const keywords = Array.isArray(config.palavras_chave)
      ? config.palavras_chave.join(", ")
      : config.palavras_chave;
    partes.push(`Foque especialmente em temas relacionados a: ${keywords}.`);
  }

  return partes.join(" ");
}
