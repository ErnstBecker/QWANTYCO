import type { Chamado } from "../tickets/schemas";

// Fictitious data for the Aurora exercise. CH-101 and CH-103 are the only open tickets.
export const CHAMADOS_SEED: readonly Chamado[] = [
  {
    id: "CH-101",
    titulo: "Falha no login do portal do cliente",
    descricao:
      "Usuários da filial Norte recebem erro 500 ao autenticar no portal desde a última atualização.",
    cliente: "Lumen Logística",
    prioridade: "alta",
    situacao: "aberto",
    criadoEm: "2026-10-20T09:15:00.000Z",
    atualizadoEm: "2026-10-26T14:02:00.000Z",
  },
  {
    id: "CH-102",
    titulo: "Relatório mensal com valores duplicados",
    descricao:
      "O relatório de faturamento de setembro exibia lançamentos em duplicidade. Corrigido no reprocessamento.",
    cliente: "Vértice Alimentos",
    prioridade: "media",
    situacao: "resolvido",
    criadoEm: "2026-10-02T11:40:00.000Z",
    atualizadoEm: "2026-10-09T16:25:00.000Z",
  },
  {
    id: "CH-103",
    titulo: "Integração de pedidos parada",
    descricao:
      "A fila de integração de pedidos com o ERP não processa novos itens há mais de 6 horas.",
    cliente: "Boreal Varejo",
    prioridade: "critica",
    situacao: "aberto",
    criadoEm: "2026-10-27T07:05:00.000Z",
    atualizadoEm: "2026-10-27T08:30:00.000Z",
  },
  {
    id: "CH-104",
    titulo: "Dúvida sobre exportação de notas",
    descricao:
      "Cliente pediu orientação para exportar notas fiscais em lote. Orientação enviada.",
    cliente: "Lumen Logística",
    prioridade: "baixa",
    situacao: "resolvido",
    criadoEm: "2026-09-28T13:00:00.000Z",
    atualizadoEm: "2026-09-29T10:10:00.000Z",
  },
];
