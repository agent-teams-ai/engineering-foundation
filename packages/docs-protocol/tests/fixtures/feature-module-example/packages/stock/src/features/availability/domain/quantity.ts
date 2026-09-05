export function available(quantity: number): boolean {
  return Number.isSafeInteger(quantity) && quantity > 0;
}
