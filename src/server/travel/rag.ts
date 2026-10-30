import { ok, parseInput, type Result } from "../shared/result";
import {
  callRagInputSchema,
  type CallRagInput,
  type CallRagOutput,
  type DocumentoViagem,
  type Trecho,
} from "./schemas";

/** Lowercase, accent-free form used for every comparison. */
const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

// Spellings users and models tend to send, mapped to the base's values.
const DESTINOS: Record<string, string> = {
  franca: "franca",
  france: "franca",
  japao: "japao",
  japan: "japao",
  alemanha: "alemanha",
  germany: "alemanha",
  deutschland: "alemanha",
  portugal: "portugal",
  "estados unidos": "estados unidos",
  "estados unidos da america": "estados unidos",
  eua: "estados unidos",
  usa: "estados unidos",
  "united states": "estados unidos",
  canada: "canada",
};
const NACIONALIDADES: Record<string, string> = {
  brasileira: "brasileira",
  brasileiro: "brasileira",
  brasil: "brasileira",
  portuguesa: "portuguesa",
  portugues: "portuguesa",
  portugal: "portuguesa",
};
const canonical = (aliases: Record<string, string>, value: string) =>
  aliases[normalize(value)] ?? normalize(value);

const STOPWORDS = new Set(
  "a o as os de da do das dos para por com sem em no na nos nas um uma que qual quais e ou eu meu minha preciso precisa vou ir viajar viagem".split(
    " ",
  ),
);
const terms = (text: string) =>
  normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

const MAX_TRECHOS = 4;

function appliesTo(doc: DocumentoViagem, input: CallRagInput): boolean {
  if (normalize(doc.destino) !== canonical(DESTINOS, input.destino))
    return false;
  if (
    input.nacionalidade &&
    normalize(doc.nacionalidade) !==
      canonical(NACIONALIDADES, input.nacionalidade)
  )
    return false;
  if (input.finalidade && doc.finalidade !== input.finalidade) return false;
  const dias = input.duracaoDias;
  if (
    dias !== undefined &&
    (dias < doc.duracao.minDias ||
      (doc.duracao.maxDias !== null && dias > doc.duracao.maxDias))
  )
    return false;
  return true;
}

const describeDuracao = ({ minDias, maxDias }: DocumentoViagem["duracao"]) =>
  maxDias === null
    ? minDias > 1
      ? `acima de ${minDias - 1} dias`
      : "qualquer duração"
    : `até ${maxDias} dias`;

const toTrecho = (doc: DocumentoViagem): Trecho => ({
  fonte: doc.id,
  titulo: doc.titulo,
  aplicaSe: {
    destino: doc.destino,
    nacionalidade: doc.nacionalidade,
    finalidade: doc.finalidade,
    duracao: describeDuracao(doc.duracao),
  },
  texto: doc.conteudo,
});

/**
 * Retrieval over the local base: documents must match the filters the user
 * gave (destination is mandatory), then are ranked by term overlap with the
 * question. No match means no evidence; nothing is ever made up.
 */
export function createTravelRetriever(docs: readonly DocumentoViagem[]) {
  const indexed = docs.map((doc) => ({
    doc,
    terms: new Set(terms(`${doc.titulo} ${doc.conteudo}`)),
  }));
  return {
    search(input: CallRagInput): Trecho[] {
      const query = terms(input.pergunta);
      return indexed
        .filter(({ doc }) => appliesTo(doc, input))
        .map((entry) => ({
          entry,
          score: query.filter((t) => entry.terms.has(t)).length,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_TRECHOS)
        .map(({ entry }) => toTrecho(entry.doc));
    },
  };
}

export type TravelRetriever = ReturnType<typeof createTravelRetriever>;

export async function callRag(
  retriever: TravelRetriever,
  input: unknown,
): Promise<Result<CallRagOutput>> {
  const parsed = parseInput(callRagInputSchema, input);
  if (!parsed.ok) return parsed;
  return ok({ simulacao: true, trechos: retriever.search(parsed.data) });
}
