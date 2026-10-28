import { CHAMADOS_SEED } from "./data";
import type { Chamado, Escalonamento } from "./schemas";

export interface TicketRepository {
  list(): Promise<Chamado[]>;
  findById(id: string): Promise<Chamado | undefined>;
}

export interface EscalationStore {
  findByIdempotencyKey(key: string): Promise<Escalonamento | undefined>;
  /** Atomic: inserts only if the key is new, otherwise returns the stored record. */
  insertOnce(
    data: Omit<Escalonamento, "id">,
  ): Promise<{ escalonamento: Escalonamento; created: boolean }>;
  list(): Promise<Escalonamento[]>;
}

export function createTicketRepository(
  seed: readonly Chamado[] = CHAMADOS_SEED,
): TicketRepository {
  const byId = new Map(
    seed.map((chamado) => [chamado.id, structuredClone(chamado)]),
  );
  return {
    async list() {
      return [...byId.values()].map((chamado) => structuredClone(chamado));
    },
    async findById(id) {
      const chamado = byId.get(id);
      return chamado && structuredClone(chamado);
    },
  };
}

export function createEscalationStore(): EscalationStore {
  const byKey = new Map<string, Escalonamento>();
  return {
    async findByIdempotencyKey(key) {
      const found = byKey.get(key);
      return found && structuredClone(found);
    },
    async insertOnce(data) {
      const existing = byKey.get(data.idempotencyKey);
      if (existing) {
        return { escalonamento: structuredClone(existing), created: false };
      }
      const escalonamento = {
        ...data,
        id: `ESC-${String(byKey.size + 1).padStart(4, "0")}`,
      };
      byKey.set(data.idempotencyKey, escalonamento);
      return { escalonamento: structuredClone(escalonamento), created: true };
    },
    async list() {
      return [...byKey.values()].map((e) => structuredClone(e));
    },
  };
}
