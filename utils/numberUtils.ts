export const parsePositiveInteger = (value: unknown): number | null => {
  const parsedValue = Number.parseInt(String(value), 10);
  return Number.isNaN(parsedValue) || parsedValue <= 0 ? null : parsedValue;
};
