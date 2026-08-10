type MealRow = { consumerId: number; count: number };
type DepositRow = { consumerId: number; amount: number };
type ExpenseRow = { items: unknown };

export type AccountingSummary = {
  mealsByConsumer: Record<number, number>;
  depositsByConsumer: Record<number, number>;
  totalExpenses: number;
  totalMeals: number;
  mealRate: number;
};

export const calculateAccountingSummary = (
  mealRows: MealRow[],
  expenseRows: ExpenseRow[],
  depositRows: DepositRow[],
): AccountingSummary => {
  const mealsByConsumer: Record<number, number> = {};
  for (const row of mealRows) {
    mealsByConsumer[row.consumerId] =
      (mealsByConsumer[row.consumerId] ?? 0) + row.count;
  }

  const depositsByConsumer: Record<number, number> = {};
  for (const row of depositRows) {
    depositsByConsumer[row.consumerId] =
      (depositsByConsumer[row.consumerId] ?? 0) + row.amount;
  }

  const totalExpenses = expenseRows.reduce((total, row) => {
    const items = Array.isArray(row.items)
      ? (row.items as Array<{ amount?: number }>)
      : [];
    return total + items.reduce((sum, item) => sum + (item.amount ?? 0), 0);
  }, 0);
  const totalMeals = Object.values(mealsByConsumer).reduce(
    (total, count) => total + count,
    0,
  );

  return {
    mealsByConsumer,
    depositsByConsumer,
    totalExpenses,
    totalMeals,
    mealRate: totalMeals > 0 ? totalExpenses / totalMeals : 0,
  };
};

export const getConsumerFinancialSummary = (
  consumerId: number,
  accounting: AccountingSummary,
) => {
  const meals = accounting.mealsByConsumer[consumerId] ?? 0;
  const cost = meals * accounting.mealRate;
  const deposits = accounting.depositsByConsumer[consumerId] ?? 0;
  return {
    meals,
    cost,
    deposits,
    balance: deposits - cost,
    mealRate: accounting.mealRate,
    totalExpenses: accounting.totalExpenses,
    totalMeals: accounting.totalMeals,
  };
};

export const countSettledResults = (
  results: PromiseSettledResult<unknown>[],
) => ({
  sent: results.filter((result) => result.status === "fulfilled").length,
  failed: results.filter((result) => result.status === "rejected").length,
});

export const formatBlendedMonthLabel = (yearMonths: string[]): string => {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const labels = yearMonths.map((yearMonth) => {
    const [year, month] = yearMonth.split("-").map(Number);
    return `${monthNames[(month ?? 1) - 1]} '${(year ?? 2024).toString().slice(2)}`;
  });
  return `${yearMonths.length}-month blend (${labels.join(", ")})`;
};
