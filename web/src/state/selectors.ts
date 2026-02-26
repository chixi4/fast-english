import {
  BOOK_TYPE_NEW_WORDS,
  PROGRESS_STATUS_MASTERED,
  PROGRESS_STATUS_NEW,
} from "../types";
import type { Book, DailyStats, Progress, Word } from "../types";
import { currentLearningDate, isDue } from "../utils/dateUtils";

export interface StudyQueueSnapshot {
  queue: Word[];
  dueCount: number;
}

export const getActiveBook = (books: Book[], activeBookId: number | null): Book | null => {
  if (activeBookId !== null) {
    const found = books.find((book) => book.id === activeBookId);
    if (found) return found;
  }
  return books.find((book) => book.isActive) ?? books[0] ?? null;
};

export const getWordListForBook = (
  book: Book,
  wordsByKey: Record<string, Word>,
  bookWordKeys: Record<number, string[]>,
  newWords: string[],
): Word[] => {
  const sourceKeys = book.type === BOOK_TYPE_NEW_WORDS ? newWords : bookWordKeys[book.id] ?? [];
  return sourceKeys.map((key) => wordsByKey[key]).filter(Boolean);
};

export const getProgress = (progressMap: Record<string, Progress>, wordKey: string): Progress | null => {
  return progressMap[wordKey] ?? null;
};

const mixReviewAndNewWords = (reviewWords: Word[], newWords: Word[]): Word[] => {
  if (reviewWords.length === 0) return newWords;
  if (newWords.length === 0) return reviewWords;

  const mixed: Word[] = [];
  let reviewIndex = 0;
  let newIndex = 0;
  let continuousReviewCount = 0;

  while (reviewIndex < reviewWords.length || newIndex < newWords.length) {
    const shouldInjectNew = newIndex < newWords.length && continuousReviewCount >= 3;

    if (reviewIndex < reviewWords.length && !shouldInjectNew) {
      mixed.push(reviewWords[reviewIndex]);
      reviewIndex += 1;
      continuousReviewCount += 1;
    } else if (newIndex < newWords.length) {
      mixed.push(newWords[newIndex]);
      newIndex += 1;
      continuousReviewCount = 0;
    } else if (reviewIndex < reviewWords.length) {
      mixed.push(reviewWords[reviewIndex]);
      reviewIndex += 1;
      continuousReviewCount += 1;
    }
  }

  return mixed;
};

export const getStudyQueueSnapshot = (
  book: Book,
  sourceWords: Word[],
  progressMap: Record<string, Progress>,
  earlyReviewKeys: string[],
  options: {
    newWordLimit: number;
    shuffleNewWords: boolean;
    plannedNewWordKeys: string[];
    plannedModeEnabled: boolean;
    dailyStatsMap: Record<string, DailyStats>;
  },
): StudyQueueSnapshot => {
  if (sourceWords.length === 0) {
    return {
      queue: [],
      dueCount: 0,
    };
  }

  const progressEntries = sourceWords
    .map((word) => ({ word, progress: progressMap[word.key] }))
    .filter((item) => item.progress) as Array<{ word: Word; progress: Progress }>;

  const dueProgress = progressEntries
    .filter((item) => {
      return (
        item.progress.status !== PROGRESS_STATUS_MASTERED &&
        item.progress.nextReviewTime > 0 &&
        isDue(item.progress.nextReviewTime)
      );
    })
    .sort((a, b) => a.progress.nextReviewTime - b.progress.nextReviewTime);

  const dueCount = dueProgress.length;

  const dueKeys = dueProgress.map((item) => item.word.key);
  const dueSet = new Set(dueKeys);

  const earlyReviewWords = earlyReviewKeys
    .map((key) => sourceWords.find((word) => word.key === key))
    .filter(Boolean)
    .filter((word) => !dueSet.has((word as Word).key)) as Word[];

  const progressWordSet = new Set(progressEntries.map((item) => item.word.key));
  const excludedWordSet = new Set([...dueKeys, ...earlyReviewWords.map((word) => word.key)]);

  const inLearningButUncompletedCount = Object.values(progressMap).filter(
    (progress) => progress.status !== PROGRESS_STATUS_MASTERED && progress.reviewCount <= 0,
  ).length;

  let effectiveNewWordLimit = Number.MAX_SAFE_INTEGER;
  if (book.type !== BOOK_TYPE_NEW_WORDS) {
    const learningDate = currentLearningDate();
    const todayLearned = options.dailyStatsMap[learningDate]?.newWordsCount ?? 0;
    const remainingByDailyLimit = Math.max(0, options.newWordLimit - todayLearned);
    const remainingInBook = sourceWords.filter((word) => !progressWordSet.has(word.key)).length;
    effectiveNewWordLimit = Math.min(remainingByDailyLimit, remainingInBook);
  }

  const adjustedNewWordLimit = Math.max(0, effectiveNewWordLimit - inLearningButUncompletedCount);

  const autoNewWords = sourceWords
    .filter((word) => !progressWordSet.has(word.key) && !excludedWordSet.has(word.key))
    .slice(0, adjustedNewWordLimit);

  const plannedCandidatesMap = new Map(
    sourceWords
      .filter((word) => !progressWordSet.has(word.key) && !excludedWordSet.has(word.key))
      .map((word) => [word.key, word]),
  );

  const plannedNewWords = options.plannedNewWordKeys
    .map((key) => plannedCandidatesMap.get(key))
    .filter(Boolean)
    .slice(0, adjustedNewWordLimit) as Word[];

  const newWords =
    book.type === BOOK_TYPE_NEW_WORDS
      ? autoNewWords
      : options.plannedModeEnabled
        ? plannedNewWords.length > 0
          ? plannedNewWords
          : autoNewWords
        : plannedNewWords.length > 0
          ? plannedNewWords
          : autoNewWords;

  const orderedNewWords = options.shuffleNewWords ? [...newWords].sort(() => Math.random() - 0.5) : newWords;
  const reviewWords = [...dueProgress.map((item) => item.word), ...earlyReviewWords];
  const mixedQueue = mixReviewAndNewWords(reviewWords, orderedNewWords);

  if (mixedQueue.length > 0) {
    return {
      queue: mixedQueue,
      dueCount,
    };
  }

  // 当日新词额度耗尽且无复习词时，保底回退 1 个未学习词，避免学习页长期处于“暂无单词”。
  const fallbackWord = sourceWords.find((word) => !progressWordSet.has(word.key) && !excludedWordSet.has(word.key));
  if (fallbackWord) {
    return {
      queue: [fallbackWord],
      dueCount,
    };
  }

  // 如果全部单词都已有进度且都未到期，也保底回退 1 个未掌握词，避免首页长期空态。
  const fallbackInProgressWord = progressEntries
    .filter((item) => item.progress.status !== PROGRESS_STATUS_MASTERED)
    .sort((a, b) => {
      const aNext = a.progress.nextReviewTime > 0 ? a.progress.nextReviewTime : Number.MAX_SAFE_INTEGER;
      const bNext = b.progress.nextReviewTime > 0 ? b.progress.nextReviewTime : Number.MAX_SAFE_INTEGER;
      return aNext - bNext;
    })
    .map((item) => item.word)[0];

  if (fallbackInProgressWord) {
    return {
      queue: [fallbackInProgressWord],
      dueCount,
    };
  }

  return {
    queue: mixedQueue,
    dueCount,
  };
};

export const calculateMasteryDistribution = (
  _book: Book,
  sourceWords: Word[],
  progressMap: Record<string, Progress>,
): { unlearned: number; learning: number; mastered: number; total: number; learned: number } => {
  const total = sourceWords.length;
  const progressList = sourceWords.map((word) => progressMap[word.key]).filter(Boolean) as Progress[];
  const learned = progressList.length;
  const mastered = progressList.filter((progress) => progress.status === PROGRESS_STATUS_MASTERED).length;
  const learning = Math.max(0, learned - mastered);
  const unlearned = Math.max(0, total - learned);

  return {
    unlearned,
    learning,
    mastered,
    total,
    learned,
  };
};

export const computeDueCountByBook = (
  book: Book,
  sourceWords: Word[],
  progressMap: Record<string, Progress>,
): number => {
  if (book.type === BOOK_TYPE_NEW_WORDS) return 0;
  return sourceWords.filter((word) => {
    const progress = progressMap[word.key];
    if (!progress) return false;
    if (progress.status === PROGRESS_STATUS_MASTERED) return false;
    if (progress.nextReviewTime <= 0) return false;
    return isDue(progress.nextReviewTime);
  }).length;
};

export const computeProgressStatusLabel = (progress: Progress | null): string => {
  if (!progress) return "未学习";
  if (progress.status === PROGRESS_STATUS_MASTERED) return "已掌握";
  if (progress.status === PROGRESS_STATUS_NEW) return "新词";
  return "学习中";
};
