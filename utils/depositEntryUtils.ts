type DepositEntryResponseSource = {
  id: number;
  consumerId: number;
  amount: number;
  depositedAt: Date;
  note: string | null;
};

export const toDepositEntryResponse = (entry: DepositEntryResponseSource) => ({
  id: entry.id,
  consumerId: entry.consumerId,
  amount: entry.amount,
  depositedAt: entry.depositedAt.toISOString(),
  note: entry.note,
});
