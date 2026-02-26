import dayjs from "dayjs";
import type { DayForecast, PressureLevel } from "../types";
import { pressureFromTotal } from "./dateUtils";

export const calculateNext7DaysPressure = (
  reviewTimes: number[],
  now: number,
  dailyNewWordLimit: number,
  todayRemainingNewWords: number,
): DayForecast[] => {
  const safeDailyLimit = Math.max(0, dailyNewWordLimit);
  const safeTodayRemaining = Math.max(0, Math.min(safeDailyLimit, todayRemainingNewWords));
  const startDate = dayjs(now).startOf("day");

  const reviewCountMap: Record<string, number> = {};
  reviewTimes
    .filter((time) => time > 0)
    .forEach((time) => {
      const key = dayjs(time).startOf("day").format("YYYY-MM-DD");
      reviewCountMap[key] = (reviewCountMap[key] ?? 0) + 1;
    });

  return Array.from({ length: 7 }, (_, index) => {
    const date = startDate.add(index, "day");
    const key = date.format("YYYY-MM-DD");
    const reviewCount = reviewCountMap[key] ?? 0;
    const newWordQuota = index === 0 ? safeTodayRemaining : safeDailyLimit;
    const totalCount = reviewCount + newWordQuota;

    return {
      date: date.valueOf(),
      reviewCount,
      newWordQuota,
      totalCount,
      pressureLevel: pressureFromTotal(totalCount) as PressureLevel,
    };
  });
};
