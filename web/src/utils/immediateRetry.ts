export interface RetryInsertPolicy {
  tailInsertMaxSize: number;
  randomInsertStartIndex: number;
  excludeTailInRandom: boolean;
}

export const legacyRetryPolicy: RetryInsertPolicy = {
  tailInsertMaxSize: 5,
  randomInsertStartIndex: 2,
  excludeTailInRandom: true,
};

export const v4RetryPolicy: RetryInsertPolicy = {
  tailInsertMaxSize: 3,
  randomInsertStartIndex: 1,
  excludeTailInRandom: true,
};

export const resolveRetryInsertIndex = (
  queueSize: number,
  policy: RetryInsertPolicy,
  random: () => number = Math.random,
): number => {
  const safeSize = Math.max(0, queueSize);
  if (safeSize === 0) return 0;
  if (safeSize <= policy.tailInsertMaxSize) return safeSize;

  const from = Math.max(0, Math.min(safeSize - 1, policy.randomInsertStartIndex));
  const until = policy.excludeTailInRandom ? safeSize : safeSize + 1;

  if (from >= until) return safeSize;

  const randomValue = random();
  const offset = Math.floor(randomValue * (until - from));
  return from + offset;
};
