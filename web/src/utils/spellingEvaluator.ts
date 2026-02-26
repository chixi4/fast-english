import {
  SPELLING_OUTCOME_FAILED,
  SPELLING_OUTCOME_HINTED,
  SPELLING_OUTCOME_PERFECT,
  SPELLING_OUTCOME_RETRY_SUCCESS,
} from "../types";
import type { SpellingOutcome } from "../types";

const MAX_EDIT_DISTANCE_FOR_PASS = 2;

const boundedLevenshteinDistance = (source: string, target: string, maxDistance: number): number => {
  const sourceLen = source.length;
  const targetLen = target.length;

  if (Math.abs(sourceLen - targetLen) > maxDistance) {
    return maxDistance + 1;
  }
  if (sourceLen === 0) return targetLen;
  if (targetLen === 0) return sourceLen;

  let previous = new Array<number>(targetLen + 1).fill(0).map((_, i) => i);
  let current = new Array<number>(targetLen + 1).fill(0);

  for (let i = 1; i <= sourceLen; i += 1) {
    current[0] = i;
    let minInRow = current[0];
    const sourceChar = source[i - 1];

    for (let j = 1; j <= targetLen; j += 1) {
      const substitutionCost = sourceChar === target[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
      if (current[j] < minInRow) {
        minInRow = current[j];
      }
    }

    if (minInRow > maxDistance) {
      return maxDistance + 1;
    }

    const temp = previous;
    previous = current;
    current = temp;
  }

  return previous[targetLen];
};

export const evaluateSpelling = (
  input: string,
  correctWord: string,
  hintUsed: boolean,
  attemptCount: number,
  algorithmV4Enabled: boolean,
): SpellingOutcome => {
  if (!algorithmV4Enabled) {
    const normalizedInput = input.trim();
    const isCorrect = normalizedInput.toLowerCase() === correctWord.trim().toLowerCase();
    if (!isCorrect) return SPELLING_OUTCOME_FAILED;
    if (hintUsed) return SPELLING_OUTCOME_HINTED;
    if (attemptCount > 1) return SPELLING_OUTCOME_RETRY_SUCCESS;
    return SPELLING_OUTCOME_PERFECT;
  }

  const normalizedInput = input.trim().toLowerCase();
  const normalizedCorrect = correctWord.trim().toLowerCase();
  if (!normalizedInput || !normalizedCorrect) {
    return SPELLING_OUTCOME_FAILED;
  }

  const editDistance = boundedLevenshteinDistance(
    normalizedInput,
    normalizedCorrect,
    MAX_EDIT_DISTANCE_FOR_PASS,
  );
  if (editDistance > MAX_EDIT_DISTANCE_FOR_PASS) {
    return SPELLING_OUTCOME_FAILED;
  }

  let finalQuality = 0;
  if (editDistance === 0) finalQuality = 5;
  else if (editDistance === 1) finalQuality = 4;
  else if (editDistance === 2) finalQuality = 3;

  if (hintUsed && finalQuality > 3) {
    finalQuality -= 1;
  }
  if (attemptCount > 1 && finalQuality > 3) {
    finalQuality -= 1;
  }

  if (finalQuality === 5) return SPELLING_OUTCOME_PERFECT;
  if (finalQuality === 4) return SPELLING_OUTCOME_HINTED;
  if (finalQuality === 3) return SPELLING_OUTCOME_RETRY_SUCCESS;
  return SPELLING_OUTCOME_FAILED;
};
