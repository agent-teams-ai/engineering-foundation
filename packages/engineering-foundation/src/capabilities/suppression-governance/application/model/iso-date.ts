export function isoDateToEpochDay(value: string): number | undefined {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthLength = monthLengths[month - 1];
  if (monthLength === undefined || day < 1 || day > monthLength) {
    return undefined;
  }
  let total = 365 * (year - 1);
  total += Math.floor((year - 1) / 4);
  total -= Math.floor((year - 1) / 100);
  total += Math.floor((year - 1) / 400);
  for (let index = 0; index < month - 1; index += 1) {
    total += monthLengths[index] ?? 0;
  }
  return total + day;
}
