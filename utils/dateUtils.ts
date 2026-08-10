const APP_TIME_ZONE = process.env.APP_TIME_ZONE ?? "Asia/Dhaka";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const dateInAppTimeZone = (value: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const getPart = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
};

export const getBufferedMonthBounds = (yearMonth: string) => {
  const [year, month] = yearMonth.split("-").map(Number);
  return {
    startDate: new Date(Date.UTC(year!, month! - 1, 1) - ONE_DAY_MS),
    endDate: new Date(Date.UTC(year!, month!, 1) + ONE_DAY_MS),
  };
};
