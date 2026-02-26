import type { MlModelSnapshot, Progress } from "../types";
import { nextReviewTimeByDays } from "./dateUtils";

const DEFAULT_RETENTION = 0.85;
const DEFAULT_RESPONSE_THRESHOLD_MS = 6_000;
const MIN_RESPONSE_THRESHOLD_MS = 3_000;
const MAX_RESPONSE_THRESHOLD_MS = 15_000;
const RESPONSE_THRESHOLD_SIGMA_MULTIPLIER = 1.5;

const COLD_START_THRESHOLD = 50;
const WARM_UP_THRESHOLD = 200;

const TARGET_RETENTION = 0.9;
const MAX_INTERVAL_ADJUSTMENT_RATIO = 0.5;
const MIN_INTERVAL_DAYS = 1;

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;

export interface MlScheduleBase {
  intervalDays: number;
  easeFactor: number;
  nextReviewTime: number;
}

export interface MlAdjustmentResult {
  intervalDays: number;
  easeFactor: number;
  nextReviewTime: number;
  forgetProbability: number;
  confidence: number;
  features: number[];
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const sigmoid = (x: number): number => {
  const clipped = clamp(x, -20, 20);
  return 1 / (1 + Math.exp(-clipped));
};

export const computeMlConfidence = (sampleCount: number): number => {
  if (sampleCount < COLD_START_THRESHOLD) {
    return clamp((sampleCount / COLD_START_THRESHOLD) * 0.3, 0, 1);
  }
  if (sampleCount < WARM_UP_THRESHOLD) {
    const progress = (sampleCount - COLD_START_THRESHOLD) / (WARM_UP_THRESHOLD - COLD_START_THRESHOLD);
    return clamp(0.3 + progress * 0.5, 0, 1);
  }
  return clamp(0.8 + (sampleCount - WARM_UP_THRESHOLD) / 1000, 0, 1);
};

export const computeAdaptiveResponseThreshold = (
  mlEnabled: boolean,
  mlModel: MlModelSnapshot,
): number => {
  if (!mlEnabled) return DEFAULT_RESPONSE_THRESHOLD_MS;
  if (mlModel.avgResponseTime <= 0) return DEFAULT_RESPONSE_THRESHOLD_MS;

  const threshold =
    mlModel.avgResponseTime + RESPONSE_THRESHOLD_SIGMA_MULTIPLIER * Math.max(0, mlModel.stdResponseTime);
  return clamp(threshold, MIN_RESPONSE_THRESHOLD_MS, MAX_RESPONSE_THRESHOLD_MS);
};

export const extractMlFeatures = (
  progress: Progress | null,
  sessionPosition: number,
  sessionTotal: number,
  mlModel: MlModelSnapshot,
  now: number = Date.now(),
): number[] => {
  const ef = progress?.easeFactor ?? DEFAULT_EASE;
  const intervalDays = progress?.intervalDays ?? 0;
  const reviewCount = progress?.reviewCount ?? 0;
  const spellWrongCount = progress?.spellWrongCount ?? 0;
  const consecutiveCorrect = progress?.consecutiveCorrect ?? 0;
  const avgResponseTimeMs = progress?.avgResponseTimeMs ?? 0;
  const lastReviewTime = progress?.lastReviewTime ?? 0;

  const current = new Date(now);
  const sessionRatio = sessionTotal > 0 ? sessionPosition / sessionTotal : 0;
  const hoursSinceLastReview =
    lastReviewTime > 0 ? Math.max(0, now - lastReviewTime) / (60 * 60 * 1000) : null;

  const f1 = clamp((3 - ef) / 1.7, 0, 1);
  const f2 = clamp(current.getHours() / 23, 0, 1);
  const f3 = clamp(current.getDay() / 6, 0, 1);
  const f4 = clamp(sessionRatio, 0, 1);
  const f5 = clamp(Math.log(intervalDays + 1) / Math.log(365), 0, 1);
  const f6 = clamp((ef - MIN_EASE) / (MAX_EASE - MIN_EASE), 0, 1);
  const f7 = reviewCount > 0 ? clamp((reviewCount - spellWrongCount) / reviewCount, 0, 1) : 0.5;
  const f8 = clamp(avgResponseTimeMs / 10_000, 0, 1);
  const f9 = sigmoid(consecutiveCorrect - 5);
  const f10 = hoursSinceLastReview === null
    ? 1
    : clamp(Math.log(hoursSinceLastReview + 1) / Math.log(720), 0, 1);
  const f11 = clamp(mlModel.userBaseRetention || DEFAULT_RETENTION, 0, 1);
  const f12 = 0;

  return [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12];
};

export const estimateForgetProbability = (
  features: number[],
  mlModel: MlModelSnapshot,
): { forgetProbability: number; confidence: number } => {
  const confidence = computeMlConfidence(mlModel.sampleCount);

  const priorPrediction = clamp(1 - (mlModel.userBaseRetention || DEFAULT_RETENTION), 0.01, 0.99);
  const personalWeight =
    mlModel.sampleCount < COLD_START_THRESHOLD
      ? 0
      : mlModel.sampleCount < WARM_UP_THRESHOLD
        ? (mlModel.sampleCount - COLD_START_THRESHOLD) / (WARM_UP_THRESHOLD - COLD_START_THRESHOLD)
        : 1;

  const logit =
    -1.2 +
    features[0] * 1.1 +
    features[3] * 0.3 +
    features[4] * 0.9 +
    (1 - features[6]) * 1.2 +
    features[7] * 0.7 +
    (1 - features[8]) * 0.5 +
    features[9] * 0.9 +
    (1 - features[10]) * 0.6;

  const personalPrediction = clamp(sigmoid(logit), 0.01, 0.99);
  const forgetProbability = clamp(
    priorPrediction * (1 - personalWeight) + personalPrediction * personalWeight,
    0.01,
    0.99,
  );

  return { forgetProbability, confidence };
};

export const applyMlScheduleAdjustment = (
  base: MlScheduleBase,
  forgetProbability: number,
  confidence: number,
  now: number,
): MlScheduleBase => {
  if (base.intervalDays <= 0 || confidence <= 0.01) {
    return base;
  }

  const targetForgetProbability = 1 - TARGET_RETENTION;
  const ratio = forgetProbability > 0.01 ? targetForgetProbability / forgetProbability : 1.5;
  const adjustedRatio = 1 + (ratio - 1) * confidence;
  const clampedRatio = clamp(
    adjustedRatio,
    1 - MAX_INTERVAL_ADJUSTMENT_RATIO,
    1 + MAX_INTERVAL_ADJUSTMENT_RATIO,
  );

  const adjustedIntervalDays = Math.max(MIN_INTERVAL_DAYS, Math.round(base.intervalDays * clampedRatio));
  const mlEase = DEFAULT_EASE - (forgetProbability - 0.5) * 1.5;
  const adjustedEase = clamp(
    DEFAULT_EASE * (1 - confidence) + mlEase * confidence,
    MIN_EASE,
    MAX_EASE,
  );

  return {
    intervalDays: adjustedIntervalDays,
    easeFactor: confidence > 0.1 ? adjustedEase : base.easeFactor,
    nextReviewTime:
      adjustedIntervalDays !== base.intervalDays
        ? nextReviewTimeByDays(adjustedIntervalDays, now)
        : base.nextReviewTime,
  };
};

