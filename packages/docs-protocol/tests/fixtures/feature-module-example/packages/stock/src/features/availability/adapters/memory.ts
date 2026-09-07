import type { StockReader } from "../application.js";

export class MemoryStock implements StockReader {
  constructor(private readonly quantities: ReadonlyMap<string, number>) {}
  async quantity(sku: string): Promise<number> { return this.quantities.get(sku) ?? 0; }
}
