import {
  PROGRESS_STATUS_LEARNING,
  PROGRESS_STATUS_MASTERED,
  SPELLING_OUTCOME_FAILED,
  SPELLING_OUTCOME_HINTED,
  SPELLING_OUTCOME_PERFECT,
  SPELLING_OUTCOME_RETRY_SUCCESS,
  STUDY_RATING_AGAIN,
  STUDY_RATING_GOOD,
  STUDY_RATING_HARD,
} from "../types";
import type { Progress, SpellingOutcome, StudyRating } from "../types";
import { nextReviewTimeByDays } from "./dateUtils";

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MIN_EASE_SPELLING = 1.1;
const MAX_EASE = 3.0;
const ONE_MINUTE = 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const MASTERED_INTERVAL_DAYS_V3 = 21;
const MASTERED_MIN_REVIEW_COUNT_V3 = 2;
const MASTERED_INTERVAL_DAYS_V4 = 30;
const MASTERED_MIN_REVIEW_COUNT_V4 = 4;
const MASTERED_MIN_EASE = 2.3;
const MAX_GROWTH_FACTOR = 2.5;
const HARD_GROWTH_FACTOR = 1.2;
const SHORT_TERM_REVIEW_DECAY_HOURS = 12;
const V3_MIN_INTERVAL_DAYS = 1;
const V3_GOOD_INTERVAL_DAYS = 2;
const EBBINGHAUS_LADDER = [1, 2, 6, 14, 30];

export interface ScheduleResult {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  nextReviewTime: number;
  status: 1 | 2;
}

const updateEase = (currentEase: number, quality: number, minEase: number): number => {
  const updated = currentEase - 0.8 + 0.28 * quality - 0.02 * quality * quality;
  return Math.max(minEase, Math.min(MAX_EASE, updated));
};

const conservativeInterval = (oldInterval: number, ease: number): number => {
  const safeOld = Math.max(1, oldInterval);
  const byHard = Math.round(safeOld * HARD_GROWTH_FACTOR);
  const byEase = Math.round(safeOld * ease);
  return Math.max(1, Math.min(byHard, byEase));
};

const standardGoodInterval = (oldInterval: number, ease: number): number => {
  const safeOld = Math.max(1, oldInterval);
  const grown = Math.max(1, Math.round(safeOld * ease));
  const maxAllowed = Math.max(1, Math.round(safeOld * MAX_GROWTH_FACTOR));
  return Math.min(grown, maxAllowed);
};

const isLearningPhase = (current: Progress | null): boolean => {
  if (!current) return true;
  return current.intervalDays <= 0 || current.repetitions <= 0;
};

const resolveStatus = (
  intervalDays: number,
  reviewCount: number,
  easeFactor: number,
  algorithmV4Enabled: boolean,
): 1 | 2 => {
  const masteredIntervalDays = algorithmV4Enabled ? MASTERED_INTERVAL_DAYS_V4 : MASTERED_INTERVAL_DAYS_V3;
  const masteredReviewCount = algorithmV4Enabled ? MASTERED_MIN_REVIEW_COUNT_V4 : MASTERED_MIN_REVIEW_COUNT_V3;

  if (
    intervalDays >= masteredIntervalDays &&
    reviewCount >= masteredReviewCount &&
    easeFactor >= MASTERED_MIN_EASE
  ) {
    return PROGRESS_STATUS_MASTERED;
  }
  return PROGRESS_STATUS_LEARNING;
};

const estimateLastReview = (current: Progress | null, now: number): number | null => {
  if (!current || current.reviewCount <= 0 || current.nextReviewTime <= 0) return null;
  if (current.lastReviewTime > 0) return current.lastReviewTime;
  if (current.intervalDays > 0) {
    return current.nextReviewTime - current.intervalDays * 24 * 60 * 60 * 1000;
  }
  return now - TEN_MINUTES;
};

const reviewedWithinHours = (current: Progress | null, now: number, hours: number): boolean => {
  const estimated = estimateLastReview(current, now);
  if (!estimated) return false;
  const elapsed = now - estimated;
  if (elapsed < 0) return false;
  return elapsed <= hours * 60 * 60 * 1000;
};

const nextEbbinghausStep = (currentIntervalDays: number): number => {
  if (currentIntervalDays <= 0) return EBBINGHAUS_LADDER[0];
  return EBBINGHAUS_LADDER.find((step) => step > currentIntervalDays) ?? EBBINGHAUS_LADDER[EBBINGHAUS_LADDER.length - 1];
};

const closestEbbinghausStep = (intervalDays: number): number => {
  const safe = Math.max(1, intervalDays);
  let nearest = EBBINGHAUS_LADDER[0];
  for (const step of EBBINGHAUS_LADDER) {
    const diff = Math.abs(step - safe);
    const nearestDiff = Math.abs(nearest - safe);
    if (diff < nearestDiff || (diff === nearestDiff && step > nearest)) {
      nearest = step;
    }
  }
  return nearest;
};

const nextReviewTimeByInterval = (now: number, intervalDays: number): number => {
  if (intervalDays > 0) {
    return nextReviewTimeByDays(intervalDays, now);
  }
  return now + TEN_MINUTES;
};

export const scheduleRecognition = (
  current: Progress | null,
  rating: StudyRating,
  now: number = Date.now(),
  algorithmV4Enabled: boolean = false,
): ScheduleResult => {
  if (algorithmV4Enabled) {
    return scheduleRecognitionV4(current, rating, now);
  }

  let ease = updateEase(current?.easeFactor ?? DEFAULT_EASE, rating, MIN_EASE);
  const prevRepetitions = current?.repetitions ?? 0;
  const prevIntervalDays = current?.intervalDays ?? 0;
  const prevReviewCount = current?.reviewCount ?? 0;
  const learningPhase = isLearningPhase(current);

  if (rating === STUDY_RATING_AGAIN) {
    ease = Math.max(MIN_EASE, ease - 0.2);
    return {
      repetitions: 0,
      intervalDays: V3_MIN_INTERVAL_DAYS,
      easeFactor: ease,
      nextReviewTime: nextReviewTimeByDays(V3_MIN_INTERVAL_DAYS, now),
      status: PROGRESS_STATUS_LEARNING,
    };
  }

  if (learningPhase) {
    const intervalDays = rating === STUDY_RATING_HARD ? V3_MIN_INTERVAL_DAYS : V3_GOOD_INTERVAL_DAYS;
    const effectiveReviewCount = prevReviewCount + 1;
    return {
      repetitions: prevRepetitions + 1,
      intervalDays,
      easeFactor: ease,
      nextReviewTime: nextReviewTimeByInterval(now, intervalDays),
      status: resolveStatus(intervalDays, effectiveReviewCount, ease, false),
    };
  }

  const oldInterval = Math.max(1, prevIntervalDays);
  const intervalDays =
    rating === STUDY_RATING_HARD ? conservativeInterval(oldInterval, ease) : standardGoodInterval(oldInterval, ease);

  const effectiveReviewCount = prevReviewCount + 1;
  return {
    repetitions: prevRepetitions + 1,
    intervalDays,
    easeFactor: ease,
    nextReviewTime: nextReviewTimeByDays(intervalDays, now),
    status: resolveStatus(intervalDays, effectiveReviewCount, ease, false),
  };
};

const scheduleRecognitionV4 = (current: Progress | null, rating: StudyRating, now: number): ScheduleResult => {
  let ease = updateEase(current?.easeFactor ?? DEFAULT_EASE, rating, MIN_EASE);
  const prevRepetitions = current?.repetitions ?? 0;
  const prevIntervalDays = current?.intervalDays ?? 0;
  const prevReviewCount = current?.reviewCount ?? 0;
  const learningPhase = isLearningPhase(current);

  if (rating === STUDY_RATING_AGAIN) {
    ease = Math.max(MIN_EASE, ease - 0.2);
    return {
      repetitions: 0,
      intervalDays: 0,
      easeFactor: ease,
      nextReviewTime: now + ONE_MINUTE,
      status: PROGRESS_STATUS_LEARNING,
    };
  }

  let intervalDays = learningPhase
    ? rating === STUDY_RATING_HARD
      ? 0
      : nextEbbinghausStep(prevIntervalDays)
    : closestEbbinghausStep(
        rating === STUDY_RATING_HARD
          ? conservativeInterval(Math.max(1, prevIntervalDays), ease)
          : standardGoodInterval(Math.max(1, prevIntervalDays), ease),
      );

  if (intervalDays > 1 && reviewedWithinHours(current, now, SHORT_TERM_REVIEW_DECAY_HOURS)) {
    intervalDays = 1;
  }

  const effectiveReviewCount = prevReviewCount + 1;
  return {
    repetitions: prevRepetitions + 1,
    intervalDays,
    easeFactor: ease,
    nextReviewTime: nextReviewTimeByInterval(now, intervalDays),
    status: resolveStatus(intervalDays, effectiveReviewCount, ease, true),
  };
};

export const scheduleSpelling = (
  current: Progress | null,
  outcome: SpellingOutcome,
  now: number = Date.now(),
  algorithmV4Enabled: boolean = false,
): ScheduleResult => {
  if (algorithmV4Enabled) {
    return scheduleSpellingV4(current, outcome, now);
  }

  const prevReviewCount = current?.reviewCount ?? 0;
  const prevIntervalDays = current?.intervalDays ?? 0;
  const prevRepetitions = current?.repetitions ?? 0;
  const learningPhase = isLearningPhase(current);
  let ease = updateEase(current?.easeFactor ?? DEFAULT_EASE, outcome, MIN_EASE_SPELLING);

  if (outcome === SPELLING_OUTCOME_FAILED) {
    ease = Math.max(MIN_EASE_SPELLING, ease - 0.2);
    return {
      repetitions: 0,
      intervalDays: V3_MIN_INTERVAL_DAYS,
      easeFactor: ease,
      nextReviewTime: nextReviewTimeByDays(V3_MIN_INTERVAL_DAYS, now),
      status: PROGRESS_STATUS_LEARNING,
    };
  }

  let intervalDays: number;
  if (learningPhase) {
    intervalDays =
      outcome === SPELLING_OUTCOME_RETRY_SUCCESS ? V3_MIN_INTERVAL_DAYS : V3_GOOD_INTERVAL_DAYS;
  } else if (outcome === SPELLING_OUTCOME_RETRY_SUCCESS) {
    intervalDays = conservativeInterval(Math.max(1, prevIntervalDays), ease);
  } else if (outcome === SPELLING_OUTCOME_HINTED) {
    intervalDays = standardGoodInterval(Math.max(1, prevIntervalDays), ease);
  } else {
    const base = standardGoodInterval(Math.max(1, prevIntervalDays), ease);
    intervalDays = Math.max(1, Math.round(base * 1.1));
  }

  const effectiveReviewCount = prevReviewCount + 1;
  return {
    repetitions: prevRepetitions + 1,
    intervalDays,
    easeFactor: ease,
    nextReviewTime: nextReviewTimeByInterval(now, intervalDays),
    status: resolveStatus(intervalDays, effectiveReviewCount, ease, false),
  };
};

const scheduleSpellingV4 = (
  current: Progress | null,
  outcome: SpellingOutcome,
  now: number,
): ScheduleResult => {
  const prevReviewCount = current?.reviewCount ?? 0;
  const prevIntervalDays = current?.intervalDays ?? 0;
  const prevRepetitions = current?.repetitions ?? 0;
  const learningPhase = isLearningPhase(current);
  let ease = updateEase(current?.easeFactor ?? DEFAULT_EASE, outcome, MIN_EASE_SPELLING);

  if (outcome === SPELLING_OUTCOME_FAILED) {
    ease = Math.max(MIN_EASE_SPELLING, ease - 0.2);
    return {
      repetitions: 0,
      intervalDays: 0,
      easeFactor: ease,
      nextReviewTime: now + ONE_MINUTE,
      status: PROGRESS_STATUS_LEARNING,
    };
  }

  let intervalDays: number;
  if (learningPhase) {
    intervalDays =
      outcome === SPELLING_OUTCOME_RETRY_SUCCESS ? 0 : nextEbbinghausStep(prevIntervalDays);
  } else {
    const oldInterval = Math.max(1, prevIntervalDays);
    let rawInterval: number;
    if (outcome === SPELLING_OUTCOME_RETRY_SUCCESS) {
      rawInterval = conservativeInterval(oldInterval, ease);
    } else if (outcome === SPELLING_OUTCOME_HINTED) {
      rawInterval = standardGoodInterval(oldInterval, ease);
    } else if (outcome === SPELLING_OUTCOME_PERFECT) {
      rawInterval = Math.max(1, Math.round(standardGoodInterval(oldInterval, ease) * 1.1));
    } else {
      rawInterval = 1;
    }
    intervalDays = closestEbbinghausStep(rawInterval);
  }

  if (intervalDays > 1 && reviewedWithinHours(current, now, SHORT_TERM_REVIEW_DECAY_HOURS)) {
    intervalDays = 1;
  }

  const effectiveReviewCount = prevReviewCount + 1;
  return {
    repetitions: prevRepetitions + 1,
    intervalDays,
    easeFactor: ease,
    nextReviewTime: nextReviewTimeByInterval(now, intervalDays),
    status: resolveStatus(intervalDays, effectiveReviewCount, ease, true),
  };
};

export const evaluateRecognitionByResponseTime = (
  rating: StudyRating,
  responseTimeMs: number,
  algorithmV4Enabled: boolean,
  thresholdMs: number,
): StudyRating => {
  if (!algorithmV4Enabled) return rating;
  if (responseTimeMs <= thresholdMs) return rating;
  if (rating === STUDY_RATING_GOOD) return STUDY_RATING_HARD;
  if (rating === STUDY_RATING_HARD) return STUDY_RATING_AGAIN;
  return STUDY_RATING_AGAIN;
};
