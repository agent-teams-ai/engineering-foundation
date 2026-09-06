import { createAvailability } from "./features/availability/application.js";
import { MemoryStock } from "./features/availability/adapters/memory.js";

export function createStock(quantities: ReadonlyMap<string, number>) {
  return { isAvailable: createAvailability(new MemoryStock(quantities)) };
}
