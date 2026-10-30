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
