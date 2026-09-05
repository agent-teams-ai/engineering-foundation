import { available } from "../domain.js";

export interface StockReader { quantity(sku: string): Promise<number>; }

export function createAvailability(stock: StockReader) {
  return async (sku: string): Promise<boolean> => available(await stock.quantity(sku));
}
