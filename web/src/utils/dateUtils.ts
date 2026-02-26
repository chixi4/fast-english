import dayjs from "dayjs";

const DAY_REFRESH_HOUR = 4;

export const currentLearningDate = (now: number = Date.now()): string => {
  const current = dayjs(now);
  const adjusted = current.hour() < DAY_REFRESH_HOUR ? current.subtract(1, "day") : current;
  return adjusted.format("YYYY-MM-DD");
};

export const toLearningDate = (timestamp: number): dayjs.Dayjs => {
  const current = dayjs(timestamp);
  return current.hour() < DAY_REFRESH_HOUR ? current.subtract(1, "day") : current;
};

export const daysBetweenLearningDate = (from: number, to: number): number => {
  const fromDate = toLearningDate(from).startOf("day");
  const toDate = toLearningDate(to).startOf("day");
  return toDate.diff(fromDate, "day");
};

export const isDue = (nextReviewTime: number, now: number = Date.now()): boolean => {
  if (nextReviewTime <= 0) return false;
  if (nextReviewTime <= now) return true;
  return daysBetweenLearningDate(now, nextReviewTime) < 0;
};

export const formatDateTime = (timestamp: number): string => {
  if (timestamp <= 0) return "暂无";
  return dayjs(timestamp).format("YYYY-MM-DD HH:mm");
};

export const formatReviewDay = (timestamp: number, now: number = Date.now()): string => {
  if (timestamp <= 0) return "无";
  const diffDays = daysBetweenLearningDate(now, timestamp);
  if (diffDays < 0) return "已到期";
  if (diffDays === 0) return "今日";
  if (diffDays === 1) return "明天";
  return `${diffDays}天后`;
};

export const reviewTag = (timestamp: number, now: number = Date.now()): string => {
  if (timestamp <= 0) return "未安排";
  const diffDays = daysBetweenLearningDate(now, timestamp);
  if (diffDays < 0) return "已到期";
  if (diffDays === 0) return "今日";
  if (diffDays === 1) return "明天";
  return `${diffDays}天后`;
};

export const reviewDescription = (timestamp: number, now: number = Date.now()): string => {
  if (timestamp <= 0) return "暂无安排";
  const diffDays = daysBetweenLearningDate(now, timestamp);
  if (diffDays < 0) return "已到期，建议现在复习";
  if (diffDays === 0) return "今日复习";
  if (diffDays === 1) return "明天复习";
  return `${diffDays}天后复习`;
};

export const nextReviewTimeByDays = (intervalDays: number, now: number = Date.now()): number => {
  const safeDays = Math.max(1, intervalDays);
  const current = dayjs(now);
  const learningDate = current.hour() < DAY_REFRESH_HOUR ? current.subtract(1, "day") : current;
  return learningDate
    .startOf("day")
    .add(safeDays, "day")
    .hour(DAY_REFRESH_HOUR)
    .minute(0)
    .second(0)
    .millisecond(0)
    .valueOf();
};

export const estimateLastReviewTime = (
  nextReviewTime: number,
  intervalDays: number,
  reviewCount: number,
): number | null => {
  if (reviewCount <= 0 || nextReviewTime <= 0) return null;
  if (intervalDays > 0) {
    return dayjs(nextReviewTime).subtract(intervalDays, "day").valueOf();
  }
  return nextReviewTime - 10 * 60 * 1000;
};

export const chartDateLabel = (date: string): string => {
  const target = dayjs(date);
  const today = dayjs();
  if (target.isSame(today, "day")) return "今天";
  if (target.isSame(today.add(1, "day"), "day")) return "明天";
  return target.format("M/D");
};

export const pressureFromTotal = (total: number): "LOW" | "MEDIUM" | "HIGH" => {
  if (total < 50) return "LOW";
  if (total <= 100) return "MEDIUM";
  return "HIGH";
};
