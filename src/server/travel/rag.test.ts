import { describe, expect, it } from "vitest";
import { DOCUMENTOS_VIAGEM } from "../mocks/viagens";
import { callRag, createTravelRetriever } from "./rag";
import { callRagOutputSchema, documentoViagemSchema } from "./schemas";

const retriever = createTravelRetriever(DOCUMENTOS_VIAGEM);

const fontes = async (input: Record<string, unknown>) => {
  const result = await callRag(retriever, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.trechos.map((t) => t.fonte);
};

describe("travel knowledge base", () => {
  it("is valid, marked as simulation and covers France and another country", () => {
    for (const doc of DOCUMENTOS_VIAGEM) {
      expect(documentoViagemSchema.safeParse(doc).success).toBe(true);
      expect(doc.conteudo).toContain("SIMULAÇÃO");
    }
    const destinos = new Set(DOCUMENTOS_VIAGEM.map((d) => d.destino));
    expect(destinos.has("França")).toBe(true);
    expect(destinos.size).toBeGreaterThan(1);
    expect(new Set(DOCUMENTOS_VIAGEM.map((d) => d.id)).size).toBe(
      DOCUMENTOS_VIAGEM.length,
    );
  });
});

describe("callRag", () => {
  it("returns excerpts with their source and who they apply to", async () => {
    const result = await callRag(retriever, {
      pergunta: "Qual documentação preciso para viajar para a França?",
      destino: "França",
      nacionalidade: "brasileira",
      finalidade: "turismo",
      duracaoDias: 15,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(callRagOutputSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.simulacao).toBe(true);
    expect(result.data.trechos).toEqual([
      expect.objectContaining({
        fonte: "FR-BR-TURISMO",
        aplicaSe: {
          destino: "França",
          nacionalidade: "brasileira",
          finalidade: "turismo",
          duracao: "até 90 dias",
        },
      }),
    ]);
  });

  it("accepts common spellings of destination and nationality", async () => {
    expect(
      await fontes({
        pergunta: "visto de turismo",
        destino: "franca",
        nacionalidade: "Brasileiro",
        finalidade: "turismo",
      }),
    ).toEqual(["FR-BR-TURISMO"]);
  });

  it("covers Germany, Portugal and the United States by their usual names", async () => {
    expect(
      await fontes({
        pergunta: "visto de turismo",
        destino: "EUA",
        nacionalidade: "brasileira",
        finalidade: "turismo",
      }),
    ).toEqual(["US-BR-TURISMO"]);
    expect(
      await fontes({
        pergunta: "trabalhar",
        destino: "Germany",
        finalidade: "trabalho",
      }),
    ).toEqual(["DE-BR-TRABALHO"]);
    expect(
      await fontes({
        pergunta: "estudar",
        destino: "Portugal",
        nacionalidade: "brasileiro",
        duracaoDias: 365,
      }),
    ).toEqual(["PT-BR-ESTUDO"]);
  });

  it("returns every profile for the destination when filters are missing", async () => {
    expect(
      (await fontes({ pergunta: "documentos", destino: "França" })).sort(),
    ).toEqual([
      "FR-BR-ESTUDO",
      "FR-BR-TRABALHO",
      "FR-BR-TURISMO",
      "FR-PT-TURISMO",
    ]);
  });

  it("ranks the excerpts that match the question first", async () => {
    const [first] = await fontes({
      pergunta: "carta de aceite da instituição de ensino",
      destino: "França",
    });
    expect(first).toBe("FR-BR-ESTUDO");
  });

  it("filters by stay length", async () => {
    expect(
      await fontes({
        pergunta: "estudar",
        destino: "França",
        nacionalidade: "brasileira",
        duracaoDias: 30,
      }),
    ).toEqual(["FR-BR-TURISMO"]);
  });

  it("returns no excerpts when the base has no evidence", async () => {
    expect(
      await fontes({
        pergunta: "visto para a Austrália",
        destino: "Austrália",
      }),
    ).toEqual([]);
    expect(
      await fontes({
        pergunta: "trabalho no Japão",
        destino: "Japão",
        finalidade: "trabalho",
      }),
    ).toEqual([]);
  });

  it("rejects input without a destination", async () => {
    const result = await callRag(retriever, { pergunta: "preciso de visto?" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });
});
