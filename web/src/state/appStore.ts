import { del, get, set as setDb } from "idb-keyval";
import { create } from "zustand";
import {
  BOOK_TYPE_IMPORTED,
  BOOK_TYPE_NEW_WORDS,
  PROGRESS_STATUS_LEARNING,
  PROGRESS_STATUS_MASTERED,
  PROGRESS_STATUS_NEW,
} from "../types";
import type {
  AICacheEntry,
  AIConfig,
  Book,
  DailyStats,
  MlModelSnapshot,
  Progress,
  StudyLog,
  TodayNewWordsPlan,
  TrainingSample,
  UserSettings,
  Word,
  WordDraft,
} from "../types";
import {
  BUILTIN_BOOK_IDS,
  loadBuiltinWordbooks,
} from "../data/wordbookLoader";
import type { BuiltinWordbookData, WordbookPronunciation } from "../data/wordbookLoader";
import { currentLearningDate } from "../utils/dateUtils";

const STORAGE_KEY = "kaoyan_word_web_state_v1";

interface PersistedImportedBook {
  id: number;
  name: string;
  words: WordDraft[];
}

interface PersistedState {
  version: number;
  activeBookId: number | null;
  importedBooks: PersistedImportedBook[];
  progressMap: Record<string, Progress>;
  newWords: string[];
  earlyReviewMap: Record<string, string[]>;
  dailyStatsMap: Record<string, DailyStats>;
  studyLogMap: Record<string, StudyLog>;
  aiCacheMap: Record<string, AICacheEntry>;
  aiConfig: AIConfig;
  settings: UserSettings;
  todayPlan: TodayNewWordsPlan;
  trainingSamples: TrainingSample[];
  mlModel: MlModelSnapshot;
  lastBookId: number;
}

interface ImportBookResult {
  ok: boolean;
  message: string;
  bookId?: number;
}

interface DeleteBookResult {
  ok: boolean;
  message: string;
}

interface BackupPayload {
  exportedAt: number;
  version: number;
  data: PersistedState;
}

interface AppStore {
  initialized: boolean;
  initializing: boolean;
  initializeError: string | null;

  books: Book[];
  wordsByKey: Record<string, Word>;
  bookWordKeys: Record<number, string[]>;
  pronunciationIndex: Record<string, WordbookPronunciation>;
  importedBooks: PersistedImportedBook[];

  activeBookId: number | null;
  progressMap: Record<string, Progress>;
  newWords: string[];
  earlyReviewMap: Record<number, string[]>;
  dailyStatsMap: Record<string, DailyStats>;
  studyLogMap: Record<string, StudyLog>;

  aiConfig: AIConfig;
  aiCacheMap: Record<string, AICacheEntry>;

  settings: UserSettings;
  todayPlan: TodayNewWordsPlan;

  trainingSamples: TrainingSample[];
  mlModel: MlModelSnapshot;

  lastBookId: number;

  initialize: () => Promise<void>;
  clearPersistence: () => Promise<void>;
  persistState: () => Promise<void>;

  switchBook: (bookId: number) => void;
  setSettings: (updater: Partial<UserSettings>) => void;
  setAiConfig: (updater: Partial<AIConfig>) => void;
  clearAiCache: () => void;

  importBook: (name: string, drafts: WordDraft[]) => ImportBookResult;
  deleteBook: (bookId: number) => DeleteBookResult;

  addToNewWords: (wordKey: string) => boolean;
  removeFromNewWords: (wordKey: string) => void;
  clearNewWords: () => void;

  replaceEarlyReviewWords: (bookId: number, wordKeys: string[]) => void;
  saveTodayPlan: (bookId: number, wordKeys: string[]) => void;
  clearTodayPlan: () => void;

  setProgress: (wordKey: string, progress: Progress) => void;
  removeProgress: (wordKey: string) => void;

  updateDailyStats: (
    date: string,
    delta: Partial<{
      newWordsCount: number;
      reviewWordsCount: number;
      spellPracticeCount: number;
      durationMillis: number;
      gestureEasyCount: number;
      gestureNotebookCount: number;
      fuzzyWordsCount: number;
      recognizedWordsCount: number;
    }>,
  ) => void;

  recordStudyLog: (date: string, count: number) => void;

  putAiCache: (entry: AICacheEntry) => void;
  getAiCacheByQuery: (queryContent: string, type: AICacheEntry["type"]) => AICacheEntry | null;
  getAiCacheByWord: (wordKey: string, type: AICacheEntry["type"]) => AICacheEntry | null;

  addTrainingSample: (sample: Omit<TrainingSample, "id">) => void;

  exportBackup: () => string;
  importBackup: (content: string) => { ok: boolean; message: string };
}

const defaultSettings: UserSettings = {
  newWordsLimit: 20,
  fontScale: 1,
  darkMode: 1,
  reviewPressureReliefEnabled: true,
  reviewPressureDailyCap: 120,
  swipeGestureGuideShown: false,
  algorithmV4Enabled: false,
  pronunciationEnabled: false,
  pronunciationSource: 0,
  recognitionAutoPronounceEnabled: false,
  newWordsShuffleEnabled: false,
  mlAdaptiveEnabled: false,
  plannedNewWordsEnabled: false,
};

const defaultAiConfig: AIConfig = {
  enabled: false,
  apiBaseUrl: "https://api.openai.com/v1/",
  apiKey: "",
  modelName: "gpt-3.5-turbo",
};

const defaultMlModel: MlModelSnapshot = {
  sampleCount: 0,
  userBaseRetention: 0.85,
  avgResponseTime: 0,
  stdResponseTime: 0,
};

const V4_MASTERED_MIN_INTERVAL_DAYS = 30;
const V4_MASTERED_MIN_REVIEW_COUNT = 4;
const V4_MASTERED_MIN_EASE = 2.3;

const normalizeWordKey = (word: string): string => word.trim().toLowerCase();

const emptyProgress = (wordKey: string): Progress => ({
  wordKey,
  status: PROGRESS_STATUS_NEW,
  repetitions: 0,
  intervalDays: 0,
  nextReviewTime: 0,
  easeFactor: 2.5,
  reviewCount: 0,
  spellCorrectCount: 0,
  spellWrongCount: 0,
  markedEasyCount: 0,
  lastEasyTime: 0,
  consecutiveCorrect: 0,
  avgResponseTimeMs: 0,
  lastReviewTime: 0,
});

const emptyDailyStats = (date: string): DailyStats => ({
  date,
  newWordsCount: 0,
  reviewWordsCount: 0,
  spellPracticeCount: 0,
  durationMillis: 0,
  gestureEasyCount: 0,
  gestureNotebookCount: 0,
  fuzzyWordsCount: 0,
  recognizedWordsCount: 0,
});

const coerceStats = (stats: DailyStats): DailyStats => ({
  ...stats,
  newWordsCount: Math.max(0, stats.newWordsCount),
  reviewWordsCount: Math.max(0, stats.reviewWordsCount),
  spellPracticeCount: Math.max(0, stats.spellPracticeCount),
  durationMillis: Math.max(0, stats.durationMillis),
  gestureEasyCount: Math.max(0, stats.gestureEasyCount),
  gestureNotebookCount: Math.max(0, stats.gestureNotebookCount),
  fuzzyWordsCount: Math.max(0, stats.fuzzyWordsCount),
  recognizedWordsCount: Math.max(0, stats.recognizedWordsCount),
});

const mergeWordData = (existing: Word | undefined, draft: WordDraft, wordId: number): Word => {
  if (!existing) {
    return {
      id: wordId,
      key: normalizeWordKey(draft.word),
      word: draft.word.trim(),
      phonetic: draft.phonetic.trim(),
      meaning: draft.meaning.trim(),
      example: draft.example.trim(),
      phrases: draft.phrases.trim(),
      synonyms: draft.synonyms.trim(),
      relWords: draft.relWords.trim(),
    };
  }

  return {
    ...existing,
    word: existing.word || draft.word.trim(),
    phonetic: existing.phonetic || draft.phonetic.trim(),
    meaning: existing.meaning || draft.meaning.trim(),
    example: existing.example || draft.example.trim(),
    phrases: existing.phrases || draft.phrases.trim(),
    synonyms: existing.synonyms || draft.synonyms.trim(),
    relWords: existing.relWords || draft.relWords.trim(),
  };
};

const markActiveBook = (books: Book[], activeBookId: number | null): Book[] => {
  const resolvedActiveId = activeBookId && books.some((book) => book.id === activeBookId)
    ? activeBookId
    : books[0]?.id ?? null;

  return books.map((book) => ({
    ...book,
    isActive: resolvedActiveId !== null && book.id === resolvedActiveId,
  }));
};

const mapEarlyReviewKeys = (source: Record<string, string[]> | Record<number, string[]>): Record<number, string[]> => {
  const result: Record<number, string[]> = {};
  Object.entries(source).forEach(([key, value]) => {
    const parsedKey = Number(key);
    if (!Number.isFinite(parsedKey)) return;
    result[parsedKey] = Array.from(new Set(value.map((item) => normalizeWordKey(item)).filter(Boolean)));
  });
  return result;
};

const hydrateImportedBooks = (
  builtin: BuiltinWordbookData,
  persistedImportedBooks: PersistedImportedBook[],
): {
  books: Book[];
  wordsByKey: Record<string, Word>;
  bookWordKeys: Record<number, string[]>;
  maxWordId: number;
  maxBookId: number;
} => {
  const wordsByKey: Record<string, Word> = { ...builtin.wordsByKey };
  const bookWordKeys: Record<number, string[]> = { ...builtin.bookWordKeys };
  const books: Book[] = [...builtin.books];

  let maxWordId = Object.values(wordsByKey).reduce((max, word) => Math.max(max, word.id), 0);
  let maxBookId = books.reduce((max, book) => Math.max(max, book.id), 0);

  persistedImportedBooks.forEach((importedBook) => {
    if (importedBook.id <= BUILTIN_BOOK_IDS.newWords) {
      return;
    }

    maxBookId = Math.max(maxBookId, importedBook.id);
    const wordKeys: string[] = [];
    const seen = new Set<string>();

    importedBook.words.forEach((draft) => {
      const key = normalizeWordKey(draft.word);
      if (!key || seen.has(key)) return;
      seen.add(key);
      wordKeys.push(key);

      const existing = wordsByKey[key];
      if (!existing) {
        maxWordId += 1;
      }
      wordsByKey[key] = mergeWordData(existing, draft, maxWordId);
    });

    bookWordKeys[importedBook.id] = wordKeys;

    books.push({
      id: importedBook.id,
      name: importedBook.name,
      type: BOOK_TYPE_IMPORTED,
      totalCount: wordKeys.length,
      isActive: false,
    });
  });

  return {
    books,
    wordsByKey,
    bookWordKeys,
    maxWordId,
    maxBookId,
  };
};

const sanitizeProgressMap = (input: Record<string, Progress>): Record<string, Progress> => {
  const result: Record<string, Progress> = {};
  Object.entries(input).forEach(([wordKey, progress]) => {
    const key = normalizeWordKey(wordKey);
    if (!key) return;
    result[key] = {
      ...emptyProgress(key),
      ...progress,
      wordKey: key,
    };
  });
  return result;
};

const repairMasteredStatusForV4 = (progressMap: Record<string, Progress>): Record<string, Progress> => {
  let changed = false;
  const repaired: Record<string, Progress> = {};

  Object.entries(progressMap).forEach(([wordKey, progress]) => {
    if (progress.status !== PROGRESS_STATUS_MASTERED) {
      repaired[wordKey] = progress;
      return;
    }

    const validMastered =
      progress.intervalDays >= V4_MASTERED_MIN_INTERVAL_DAYS &&
      progress.reviewCount >= V4_MASTERED_MIN_REVIEW_COUNT &&
      progress.easeFactor >= V4_MASTERED_MIN_EASE;

    if (validMastered) {
      repaired[wordKey] = progress;
      return;
    }

    changed = true;
    repaired[wordKey] = {
      ...progress,
      status: PROGRESS_STATUS_LEARNING,
    };
  });

  return changed ? repaired : progressMap;
};

const buildPersistedSnapshot = (state: AppStore): PersistedState => {
  return {
    version: 1,
    activeBookId: state.activeBookId,
    importedBooks: state.importedBooks,
    progressMap: state.progressMap,
    newWords: state.newWords,
    earlyReviewMap: Object.fromEntries(
      Object.entries(state.earlyReviewMap).map(([key, value]) => [key, value]),
    ),
    dailyStatsMap: state.dailyStatsMap,
    studyLogMap: state.studyLogMap,
    aiCacheMap: state.aiCacheMap,
    aiConfig: state.aiConfig,
    settings: state.settings,
    todayPlan: state.todayPlan,
    trainingSamples: state.trainingSamples,
    mlModel: state.mlModel,
    lastBookId: state.lastBookId,
  };
};

const loadPersistedState = async (): Promise<PersistedState | null> => {
  const raw = await get<PersistedState | undefined>(STORAGE_KEY);
  if (!raw) return null;
  if (raw.version !== 1) return null;
  return raw;
};

const withTimeout = async <T>(task: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer = 0;
  const timeoutTask = new Promise<T>((_, reject) => {
    timer = globalThis.setTimeout(() => {
      reject(new Error("请求超时"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutTask]);
  } finally {
    globalThis.clearTimeout(timer);
  }
};

export const useAppStore = create<AppStore>((set, getState) => ({
  initialized: false,
  initializing: false,
  initializeError: null,

  books: [],
  wordsByKey: {},
  bookWordKeys: {},
  pronunciationIndex: {},
  importedBooks: [],

  activeBookId: null,
  progressMap: {},
  newWords: [],
  earlyReviewMap: {},
  dailyStatsMap: {},
  studyLogMap: {},

  aiConfig: defaultAiConfig,
  aiCacheMap: {},

  settings: defaultSettings,
  todayPlan: {
    learningDate: "",
    bookId: null,
    wordKeys: [],
  },

  trainingSamples: [],
  mlModel: defaultMlModel,

  lastBookId: BUILTIN_BOOK_IDS.newWords,

  initialize: async () => {
    if (getState().initialized || getState().initializing) return;

    set({ initializing: true, initializeError: null });

    try {
      const persistedState = await withTimeout(loadPersistedState(), 6_000).catch(() => null);
      const builtinData = await loadBuiltinWordbooks();

      const hydrated = hydrateImportedBooks(builtinData, persistedState?.importedBooks ?? []);

      const newWords = Array.from(
        new Set((persistedState?.newWords ?? []).map((item) => normalizeWordKey(item)).filter(Boolean)),
      );

      const booksWithNewWordsCount = hydrated.books.map((book) =>
        book.id === BUILTIN_BOOK_IDS.newWords ? { ...book, totalCount: newWords.length } : book,
      );

      const persistedActiveBookId = persistedState?.activeBookId ?? null;
      const failedBuiltinIds = new Set<number>(builtinData.failedBookIds);
      const fallbackActiveBookId =
        booksWithNewWordsCount.find((book) => {
          if (failedBuiltinIds.has(book.id)) return false;
          return (hydrated.bookWordKeys[book.id]?.length ?? 0) > 0;
        })?.id ??
        booksWithNewWordsCount.find((book) => !failedBuiltinIds.has(book.id))?.id ??
        booksWithNewWordsCount[0]?.id ??
        null;

      const activeBookId =
        persistedActiveBookId !== null &&
        booksWithNewWordsCount.some((book) => book.id === persistedActiveBookId) &&
        !failedBuiltinIds.has(persistedActiveBookId)
          ? persistedActiveBookId
          : fallbackActiveBookId;

      set({
        books: markActiveBook(booksWithNewWordsCount, activeBookId),
        wordsByKey: hydrated.wordsByKey,
        bookWordKeys: {
          ...hydrated.bookWordKeys,
          [BUILTIN_BOOK_IDS.newWords]: newWords,
        },
        pronunciationIndex: builtinData.pronunciationIndex,
        importedBooks: persistedState?.importedBooks ?? [],
        activeBookId,
        progressMap: sanitizeProgressMap(persistedState?.progressMap ?? {}),
        newWords,
        earlyReviewMap: mapEarlyReviewKeys(persistedState?.earlyReviewMap ?? {}),
        dailyStatsMap: persistedState?.dailyStatsMap ?? {},
        studyLogMap: persistedState?.studyLogMap ?? {},
        aiConfig: {
          ...defaultAiConfig,
          ...(persistedState?.aiConfig ?? {}),
        },
        aiCacheMap: persistedState?.aiCacheMap ?? {},
        settings: {
          ...defaultSettings,
          ...(persistedState?.settings ?? {}),
        },
        todayPlan: {
          learningDate: persistedState?.todayPlan?.learningDate ?? "",
          bookId: persistedState?.todayPlan?.bookId ?? null,
          wordKeys: (persistedState?.todayPlan?.wordKeys ?? []).map((item) => normalizeWordKey(item)),
        },
        trainingSamples: persistedState?.trainingSamples ?? [],
        mlModel: {
          ...defaultMlModel,
          ...(persistedState?.mlModel ?? {}),
        },
        lastBookId: Math.max(
          hydrated.maxBookId,
          persistedState?.lastBookId ?? BUILTIN_BOOK_IDS.newWords,
        ),
        initialized: true,
        initializing: false,
        initializeError: null,
      });
    } catch (error) {
      set({
        initializing: false,
        initialized: false,
        initializeError: error instanceof Error ? error.message : "初始化失败",
      });
    }
  },

  clearPersistence: async () => {
    await del(STORAGE_KEY);
  },

  persistState: async () => {
    const snapshot = buildPersistedSnapshot(getState());
    await setDb(STORAGE_KEY, snapshot);
  },

  switchBook: (bookId: number) => {
    const current = getState();
    if (!current.books.some((book) => book.id === bookId)) return;
    const books = markActiveBook(current.books, bookId);
    set({ books, activeBookId: bookId });
    void getState().persistState();
  },

  setSettings: (updater) => {
    const current = getState();
    const settings: UserSettings = {
      ...current.settings,
      ...updater,
    };
    const shouldRepairV4 = !current.settings.algorithmV4Enabled && !!updater.algorithmV4Enabled;
    const progressMap = shouldRepairV4
      ? repairMasteredStatusForV4(current.progressMap)
      : current.progressMap;

    set({ settings, progressMap });
    void getState().persistState();
  },

  setAiConfig: (updater) => {
    const current = getState();
    const aiConfig: AIConfig = {
      ...current.aiConfig,
      ...updater,
    };
    set({ aiConfig });
    void getState().persistState();
  },

  clearAiCache: () => {
    set({ aiCacheMap: {} });
    void getState().persistState();
  },

  importBook: (name, drafts) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return { ok: false, message: "请输入词书名称" };
    }

    const normalizedDrafts = drafts
      .map((draft) => ({
        ...draft,
        word: draft.word.trim(),
        phonetic: draft.phonetic.trim(),
        meaning: draft.meaning.trim(),
        example: draft.example.trim(),
        phrases: draft.phrases.trim(),
        synonyms: draft.synonyms.trim(),
        relWords: draft.relWords.trim(),
      }))
      .filter((draft) => draft.word);

    if (normalizedDrafts.length === 0) {
      return { ok: false, message: "未解析到有效词条" };
    }

    const current = getState();
    const newBookId = current.lastBookId + 1;

    const wordsByKey = { ...current.wordsByKey };
    const wordKeys: string[] = [];
    const seen = new Set<string>();

    let maxWordId = Object.values(wordsByKey).reduce((max, word) => Math.max(max, word.id), 0);

    normalizedDrafts.forEach((draft) => {
      const key = normalizeWordKey(draft.word);
      if (!key || seen.has(key)) return;
      seen.add(key);
      wordKeys.push(key);

      const existing = wordsByKey[key];
      if (!existing) {
        maxWordId += 1;
      }
      wordsByKey[key] = mergeWordData(existing, draft, maxWordId);
    });

    const importedBook: PersistedImportedBook = {
      id: newBookId,
      name: trimmedName,
      words: normalizedDrafts,
    };

    const books = markActiveBook(
      [
        ...current.books,
        {
          id: newBookId,
          name: trimmedName,
          type: BOOK_TYPE_IMPORTED,
          totalCount: wordKeys.length,
          isActive: false,
        },
      ],
      current.activeBookId,
    );

    set({
      wordsByKey,
      bookWordKeys: {
        ...current.bookWordKeys,
        [newBookId]: wordKeys,
      },
      books,
      importedBooks: [...current.importedBooks, importedBook],
      lastBookId: newBookId,
    });

    void getState().persistState();

    return {
      ok: true,
      message: `已导入 ${wordKeys.length} 条词条`,
      bookId: newBookId,
    };
  },

  deleteBook: (bookId) => {
    const current = getState();
    const target = current.books.find((book) => book.id === bookId);
    if (!target) {
      return { ok: false, message: "词书不存在" };
    }
    if (target.type === BOOK_TYPE_NEW_WORDS) {
      return { ok: false, message: "生词本不可删除" };
    }

    const booksWithoutTarget = current.books.filter((book) => book.id !== bookId);
    const fallbackBook =
      booksWithoutTarget.find((book) => book.type !== BOOK_TYPE_NEW_WORDS) ?? booksWithoutTarget[0] ?? null;

    const activeBookId =
      current.activeBookId === bookId ? fallbackBook?.id ?? null : current.activeBookId;

    const nextBookWordKeys = { ...current.bookWordKeys };
    delete nextBookWordKeys[bookId];

    const nextEarlyReview = { ...current.earlyReviewMap };
    delete nextEarlyReview[bookId];

    set({
      books: markActiveBook(booksWithoutTarget, activeBookId),
      activeBookId,
      importedBooks: current.importedBooks.filter((item) => item.id !== bookId),
      bookWordKeys: nextBookWordKeys,
      earlyReviewMap: nextEarlyReview,
    });

    void getState().persistState();

    return {
      ok: true,
      message: `已删除词书：${target.name}`,
    };
  },

  addToNewWords: (wordKey) => {
    const key = normalizeWordKey(wordKey);
    if (!key) return false;

    const current = getState();
    if (current.newWords.includes(key)) {
      return false;
    }

    const newWords = [key, ...current.newWords];
    const books = current.books.map((book) =>
      book.id === BUILTIN_BOOK_IDS.newWords ? { ...book, totalCount: newWords.length } : book,
    );

    set({
      newWords,
      books,
      bookWordKeys: {
        ...current.bookWordKeys,
        [BUILTIN_BOOK_IDS.newWords]: newWords,
      },
    });

    void getState().persistState();
    return true;
  },

  removeFromNewWords: (wordKey) => {
    const key = normalizeWordKey(wordKey);
    const current = getState();
    if (!current.newWords.includes(key)) return;

    const newWords = current.newWords.filter((item) => item !== key);
    const books = current.books.map((book) =>
      book.id === BUILTIN_BOOK_IDS.newWords ? { ...book, totalCount: newWords.length } : book,
    );

    set({
      newWords,
      books,
      bookWordKeys: {
        ...current.bookWordKeys,
        [BUILTIN_BOOK_IDS.newWords]: newWords,
      },
    });

    void getState().persistState();
  },

  clearNewWords: () => {
    const current = getState();
    const books = current.books.map((book) =>
      book.id === BUILTIN_BOOK_IDS.newWords ? { ...book, totalCount: 0 } : book,
    );

    set({
      newWords: [],
      books,
      bookWordKeys: {
        ...current.bookWordKeys,
        [BUILTIN_BOOK_IDS.newWords]: [],
      },
    });

    void getState().persistState();
  },

  replaceEarlyReviewWords: (bookId, wordKeys) => {
    const dedup = Array.from(new Set(wordKeys.map((item) => normalizeWordKey(item)).filter(Boolean)));
    const earlyReviewMap = {
      ...getState().earlyReviewMap,
      [bookId]: dedup,
    };
    set({ earlyReviewMap });
    void getState().persistState();
  },

  saveTodayPlan: (bookId, wordKeys) => {
    const dedup = Array.from(new Set(wordKeys.map((item) => normalizeWordKey(item)).filter(Boolean)));
    const todayPlan: TodayNewWordsPlan = {
      learningDate: currentLearningDate(),
      bookId,
      wordKeys: dedup,
    };
    set({ todayPlan });
    void getState().persistState();
  },

  clearTodayPlan: () => {
    set({
      todayPlan: {
        learningDate: "",
        bookId: null,
        wordKeys: [],
      },
    });
    void getState().persistState();
  },

  setProgress: (wordKey, progress) => {
    const key = normalizeWordKey(wordKey);
    const progressMap = {
      ...getState().progressMap,
      [key]: {
        ...emptyProgress(key),
        ...progress,
        wordKey: key,
      },
    };

    set({ progressMap });
    void getState().persistState();
  },

  removeProgress: (wordKey) => {
    const key = normalizeWordKey(wordKey);
    const progressMap = { ...getState().progressMap };
    delete progressMap[key];
    set({ progressMap });
    void getState().persistState();
  },

  updateDailyStats: (date, delta) => {
    const current = getState().dailyStatsMap[date] ?? emptyDailyStats(date);
    const next = coerceStats({
      ...current,
      newWordsCount: current.newWordsCount + (delta.newWordsCount ?? 0),
      reviewWordsCount: current.reviewWordsCount + (delta.reviewWordsCount ?? 0),
      spellPracticeCount: current.spellPracticeCount + (delta.spellPracticeCount ?? 0),
      durationMillis: current.durationMillis + (delta.durationMillis ?? 0),
      gestureEasyCount: current.gestureEasyCount + (delta.gestureEasyCount ?? 0),
      gestureNotebookCount: current.gestureNotebookCount + (delta.gestureNotebookCount ?? 0),
      fuzzyWordsCount: current.fuzzyWordsCount + (delta.fuzzyWordsCount ?? 0),
      recognizedWordsCount: current.recognizedWordsCount + (delta.recognizedWordsCount ?? 0),
    });

    set({
      dailyStatsMap: {
        ...getState().dailyStatsMap,
        [date]: next,
      },
    });
    void getState().persistState();
  },

  recordStudyLog: (date, count) => {
    const current = getState().studyLogMap[date];
    const next: StudyLog = current
      ? {
          ...current,
          count: current.count + count,
          updateTime: Date.now(),
        }
      : {
          date,
          count,
          updateTime: Date.now(),
        };

    set({
      studyLogMap: {
        ...getState().studyLogMap,
        [date]: next,
      },
    });

    void getState().persistState();
  },

  putAiCache: (entry) => {
    set({
      aiCacheMap: {
        ...getState().aiCacheMap,
        [entry.key]: entry,
      },
    });
    void getState().persistState();
  },

  getAiCacheByQuery: (queryContent, type) => {
    const normalized = queryContent.trim().toLowerCase();
    const caches = Object.values(getState().aiCacheMap);
    return (
      caches.find(
        (item) => item.queryContent.trim().toLowerCase() === normalized && item.type === type,
      ) ?? null
    );
  },

  getAiCacheByWord: (wordKey, type) => {
    const normalized = normalizeWordKey(wordKey);
    const caches = Object.values(getState().aiCacheMap);
    return caches.find((item) => item.wordKey === normalized && item.type === type) ?? null;
  },

  addTrainingSample: (sample) => {
    const current = getState();
    const id = (current.trainingSamples[0]?.id ?? 0) + 1;
    const entry: TrainingSample = {
      ...sample,
      id,
    };
    const merged = [entry, ...current.trainingSamples].slice(0, 5000);

    const outcomes = merged.map((item) => item.outcome);
    const remembered = outcomes.filter((item) => item === 0).length;
    const retention = outcomes.length > 0 ? remembered / outcomes.length : current.mlModel.userBaseRetention;

    const responseTimes = merged
      .map((item) => item.features?.[6] ?? 0)
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => value * 30000);

    const avgResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((sum, item) => sum + item, 0) / responseTimes.length
        : current.mlModel.avgResponseTime;

    const stdResponseTime =
      responseTimes.length > 0
        ? Math.sqrt(
            responseTimes.reduce((sum, item) => sum + (item - avgResponseTime) ** 2, 0) /
              responseTimes.length,
          )
        : current.mlModel.stdResponseTime;

    set({
      trainingSamples: merged,
      mlModel: {
        sampleCount: merged.length,
        userBaseRetention: retention,
        avgResponseTime,
        stdResponseTime,
      },
    });

    void getState().persistState();
  },

  exportBackup: () => {
    const snapshot = buildPersistedSnapshot(getState());
    const payload: BackupPayload = {
      exportedAt: Date.now(),
      version: 1,
      data: snapshot,
    };
    return JSON.stringify(payload, null, 2);
  },

  importBackup: (content) => {
    try {
      const parsed = JSON.parse(content) as BackupPayload;
      const snapshot = parsed?.data;
      if (!snapshot || typeof snapshot !== "object") {
        return { ok: false, message: "备份文件格式无效" };
      }

      const normalizeImportedBooks = (snapshot.importedBooks ?? []).filter(
        (item): item is PersistedImportedBook =>
          typeof item.id === "number" &&
          typeof item.name === "string" &&
          Array.isArray(item.words),
      );

      const builtin = getState();
      const hydrated = hydrateImportedBooks(
        {
          books: builtin.books.filter((item) => item.type !== BOOK_TYPE_IMPORTED),
          wordsByKey: Object.fromEntries(
            Object.entries(builtin.wordsByKey).filter(([_, word]) => word.id <= Object.values(builtin.wordsByKey).length),
          ),
          bookWordKeys: Object.fromEntries(
            Object.entries(builtin.bookWordKeys)
              .map(([key, value]) => [Number(key), value] as const)
              .filter(([bookId]) => bookId <= BUILTIN_BOOK_IDS.newWords),
          ),
          pronunciationIndex: builtin.pronunciationIndex,
        } as BuiltinWordbookData,
        normalizeImportedBooks,
      );

      const activeBookId = snapshot.activeBookId;
      const newWords = (snapshot.newWords ?? []).map((item) => normalizeWordKey(item));

      set({
        books: markActiveBook(
          hydrated.books.map((book) =>
            book.id === BUILTIN_BOOK_IDS.newWords ? { ...book, totalCount: newWords.length } : book,
          ),
          activeBookId,
        ),
        wordsByKey: hydrated.wordsByKey,
        bookWordKeys: {
          ...hydrated.bookWordKeys,
          [BUILTIN_BOOK_IDS.newWords]: newWords,
        },
        importedBooks: normalizeImportedBooks,
        activeBookId,
        progressMap: sanitizeProgressMap(snapshot.progressMap ?? {}),
        newWords,
        earlyReviewMap: mapEarlyReviewKeys(snapshot.earlyReviewMap ?? {}),
        dailyStatsMap: snapshot.dailyStatsMap ?? {},
        studyLogMap: snapshot.studyLogMap ?? {},
        aiCacheMap: snapshot.aiCacheMap ?? {},
        aiConfig: {
          ...defaultAiConfig,
          ...(snapshot.aiConfig ?? {}),
        },
        settings: {
          ...defaultSettings,
          ...(snapshot.settings ?? {}),
        },
        todayPlan: {
          learningDate: snapshot.todayPlan?.learningDate ?? "",
          bookId: snapshot.todayPlan?.bookId ?? null,
          wordKeys: (snapshot.todayPlan?.wordKeys ?? []).map((item) => normalizeWordKey(item)),
        },
        trainingSamples: snapshot.trainingSamples ?? [],
        mlModel: {
          ...defaultMlModel,
          ...(snapshot.mlModel ?? {}),
        },
        lastBookId: Math.max(snapshot.lastBookId ?? BUILTIN_BOOK_IDS.newWords, hydrated.maxBookId),
      });

      void getState().persistState();
      return { ok: true, message: "恢复完成" };
    } catch {
      return { ok: false, message: "备份文件解析失败" };
    }
  },
}));

export type { ImportBookResult, DeleteBookResult, PersistedImportedBook };
