import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  CalendarClock,
  CircleHelp,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Flame,
  LoaderCircle,
  NotebookPen,
  Search,
  Star,
  User,
  Volume2,
} from "lucide-react";
import dayjs from "dayjs";
import { useAppStore } from "./state/appStore";
import {
  BOOK_TYPE_NEW_WORDS,
  PROGRESS_STATUS_LEARNING,
  PROGRESS_STATUS_MASTERED,
  SPELLING_OUTCOME_FAILED,
  STUDY_RATING_AGAIN,
  STUDY_RATING_GOOD,
  STUDY_RATING_HARD,
} from "./types";
import type { DailyStats, Progress, SearchSentenceAnalysis, StudyRating, Word, WordDraft } from "./types";
import {
  calculateMasteryDistribution,
  computeDueCountByBook,
  computeProgressStatusLabel,
  getActiveBook,
  getStudyQueueSnapshot,
  getWordListForBook,
} from "./state/selectors";
import {
  chartDateLabel,
  currentLearningDate,
  estimateLastReviewTime,
  formatDateTime,
  formatReviewDay,
  reviewDescription,
  reviewTag,
} from "./utils/dateUtils";
import {
  evaluateRecognitionByResponseTime,
  scheduleRecognition,
  scheduleSpelling,
} from "./utils/sm2Scheduler";
import { evaluateSpelling } from "./utils/spellingEvaluator";
import {
  applyMlScheduleAdjustment,
  computeAdaptiveResponseThreshold,
  estimateForgetProbability,
  extractMlFeatures,
} from "./utils/mlAdaptive";
import { parseWordFile } from "./utils/wordFileParser";
import { generateAiContent, inferProviderName, providerPresets, testAiConnection } from "./services/aiService";
import { parseSentenceAnalysis } from "./utils/aiContentFormatter";
import { getPronunciationAudioUrl } from "./services/pronunciation";
import {
  HeatmapGrid,
  HeatmapLegend,
  MasteryDonutChart,
  MasteryLegend,
  MemoryHeatmapCard,
  MemoryLineChart,
  MemoryStabilityCard,
} from "./components/charts";
import { AIGeneratedBadge, AnimatedStarToggle, LoadingInline } from "./components/common";
import { calculateNext7DaysPressure } from "./utils/forecast";
import { isStartInActiveZone, resolveSwipeAction, triggerThreshold } from "./utils/gesture";
import type { SwipeAction } from "./utils/gesture";
import { fontScaleClass } from "./theme";
import "./index.css";

type TabKey = "learning" | "search" | "books" | "profile";
type OverlayPage = "aiLab" | "stats" | "buildGuide" | "todayPlan" | null;

type SnackbarState = {
  id: number;
  message: string;
  actionText?: string;
  actionType?: "UNDO_TOO_EASY";
};

const MAX_SPELL_ATTEMPTS = 3;

function downloadTextFile(name: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function readTextFile(file: File): Promise<string> {
  return await file.text();
}

function App() {
  const store = useAppStore();
  const [tab, setTab] = useState<TabKey>("learning");
  const [learningMode, setLearningMode] = useState<"RECOGNITION" | "SPELLING">("RECOGNITION");
  const [overlay, setOverlay] = useState<OverlayPage>(null);
  const [todayPlanBookId, setTodayPlanBookId] = useState<number | null>(null);
  const [startupVisible, setStartupVisible] = useState(true);
  const androidVisualMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("androidVisual") === "1";

  useEffect(() => {
    void store.initialize();
  }, [store]);

  useEffect(() => {
    if (!store.initialized) return;
    const timer = window.setTimeout(() => setStartupVisible(false), 650);
    return () => window.clearTimeout(timer);
  }, [store.initialized]);

  useEffect(() => {
    const root = document.documentElement;
    const darkMode = store.settings.darkMode;
    const shouldDark =
      darkMode === 2 ||
      (darkMode === 0 && window.matchMedia("(prefers-color-scheme: dark)").matches);

    root.classList.toggle("dark-theme", shouldDark);
    root.classList.remove("font-scale-small", "font-scale-normal", "font-scale-large");
    root.classList.add(fontScaleClass(store.settings.fontScale));
  }, [store.settings.darkMode, store.settings.fontScale]);

  useEffect(() => {
    const exposedWindow = window as Window & { __WORD_WEB_STORE__?: unknown };
    exposedWindow.__WORD_WEB_STORE__ = store;
    return () => {
      if (exposedWindow.__WORD_WEB_STORE__ === store) {
        delete exposedWindow.__WORD_WEB_STORE__;
      }
    };
  }, [store]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("android-visual-mode", androidVisualMode);
    return () => {
      root.classList.remove("android-visual-mode");
    };
  }, [androidVisualMode]);

  if (store.initializing || !store.initialized || startupVisible) {
    return <StartupScreen error={store.initializeError} />;
  }

  const activeBook = getActiveBook(store.books, store.activeBookId);

  const openTodayPlan = (bookId: number) => {
    setTodayPlanBookId(bookId);
    setOverlay("todayPlan");
  };

  if (overlay === "aiLab") {
    return <AILabPage onBack={() => setOverlay(null)} />;
  }

  if (overlay === "stats") {
    return <StatsPage onBack={() => setOverlay(null)} />;
  }

  if (overlay === "buildGuide") {
    return <BuildGuidePage onBack={() => setOverlay(null)} />;
  }

  if (overlay === "todayPlan") {
    return (
      <TodayPlanPage
        initialBookId={todayPlanBookId}
        onBack={() => setOverlay(null)}
      />
    );
  }

  return (
    <div className={`app-shell ${androidVisualMode ? "android-visual-shell" : ""}`}>
      {androidVisualMode && <StatusBarMock />}
      <main className="app-main">
        {tab === "learning" && (
          <LearningTab
            activeBook={activeBook}
            initialMode={learningMode}
            onModeChange={setLearningMode}
          />
        )}
        {tab === "search" && <SearchTab activeBook={activeBook} />}
        {tab === "books" && (
          <BookTab
            activeBook={activeBook}
            onOpenBuildGuide={() => setOverlay("buildGuide")}
            onOpenTodayPlan={openTodayPlan}
            onOpenSpelling={() => {
              setLearningMode("SPELLING");
              setTab("learning");
            }}
          />
        )}
        {tab === "profile" && (
          <ProfileTab
            onOpenStats={() => setOverlay("stats")}
            onOpenAiLab={() => setOverlay("aiLab")}
          />
        )}
      </main>
      <BottomTabBar activeTab={tab} onChange={setTab} />
    </div>
  );
}

function StatusBarMock() {
  return (
    <div className="status-bar-mock" aria-hidden="true">
      <span className="status-time">18:18</span>
      <span className="status-net">VPN 0.2 KB/s · 5G · 100</span>
    </div>
  );
}

function StartupScreen({ error }: { error: string | null }) {
  return (
    <div className="startup-screen">
      <div className="startup-content">
        <img src="/vite.svg" alt="app" className="startup-logo" />
        <h1>敏捷英语</h1>
        <p>{error ? `初始化失败：${error}` : "准备学习内容中..."}</p>
      </div>
    </div>
  );
}

function BottomTabBar({ activeTab, onChange }: { activeTab: TabKey; onChange: (tab: TabKey) => void }) {
  const tabs: Array<{ key: TabKey; label: string; icon: ReactNode }> = [
    { key: "learning", label: "学习", icon: <BookOpen size={20} /> },
    { key: "search", label: "查词", icon: <Search size={20} /> },
    { key: "books", label: "词库", icon: <NotebookPen size={20} /> },
    { key: "profile", label: "我的", icon: <User size={20} /> },
  ];

  return (
    <footer className="bottom-tab-bar">
      {tabs.map((item) => (
        <button
          type="button"
          key={item.key}
          className={`tab-item ${activeTab === item.key ? "active" : ""}`}
          onClick={() => onChange(item.key)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </footer>
  );
}

function LearningTab({
  activeBook,
  initialMode,
  onModeChange,
}: {
  activeBook: ReturnType<typeof getActiveBook>;
  initialMode: "RECOGNITION" | "SPELLING";
  onModeChange: (mode: "RECOGNITION" | "SPELLING") => void;
}) {
  const store = useAppStore();
  const [learningMode, setLearningMode] = useState<"RECOGNITION" | "SPELLING">(initialMode);
  const [isFlipped, setIsFlipped] = useState(false);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [showAiPage, setShowAiPage] = useState(false);
  const [showAiGuide, setShowAiGuide] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const [showSwipeGuideLocal, setShowSwipeGuideLocal] = useState(false);
  const [snackbar, setSnackbar] = useState<SnackbarState | null>(null);

  const [currentAnswering, setCurrentAnswering] = useState(false);
  const [answeredInSession, setAnsweredInSession] = useState(0);
  const [sessionSkippedWordKeys, setSessionSkippedWordKeys] = useState<string[]>([]);
  const [immediateRetryWordKeys, setImmediateRetryWordKeys] = useState<string[]>([]);
  const [pendingFailedWordKey, setPendingFailedWordKey] = useState<string | null>(null);
  const [memoryAidSuggestionWordKey, setMemoryAidSuggestionWordKey] = useState<string | null>(null);
  const [presentedAt, setPresentedAt] = useState(0);
  const [lastRating, setLastRating] = useState<StudyRating | null>(null);
  const [pronouncingWordKey, setPronouncingWordKey] = useState<string | null>(null);
  const [undoTooEasyState, setUndoTooEasyState] = useState<{
    token: number;
    wordKey: string;
    snapshot: Progress | null;
  } | null>(null);
  const [swipeOffsetX, setSwipeOffsetX] = useState(0);
  const [swipeActionHint, setSwipeActionHint] = useState<SwipeAction>("NONE");
  const [swipeDragging, setSwipeDragging] = useState(false);
  const swipePointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    width: number;
    dragging: boolean;
    offsetX: number;
  } | null>(null);
  const suppressFlipClickRef = useRef(false);

  const [learningAiState, setLearningAiState] = useState({
    isLoading: false,
    activeType: null as "EXAMPLE" | "MEMORY_AID" | null,
    content: "",
    error: "",
  });

  const [exampleContent, setExampleContent] = useState("");
  const [memoryAidContent, setMemoryAidContent] = useState("");

  const allWords = useMemo(() => {
    if (!activeBook) return [];
    return getWordListForBook(activeBook, store.wordsByKey, store.bookWordKeys, store.newWords);
  }, [activeBook, store.wordsByKey, store.bookWordKeys, store.newWords]);

  const activeBookEarlyReview = activeBook ? store.earlyReviewMap[activeBook.id] ?? [] : [];
  const plannedKeys = useMemo(() => {
    if (!activeBook) return [];
    if (!store.settings.plannedNewWordsEnabled) return [];
    if (activeBook.type === BOOK_TYPE_NEW_WORDS) return [];
    const learningDate = currentLearningDate();
    if (store.todayPlan.learningDate !== learningDate) return [];
    if (store.todayPlan.bookId !== activeBook.id) return [];
    return store.todayPlan.wordKeys;
  }, [activeBook, store.settings.plannedNewWordsEnabled, store.todayPlan]);

  const queueSnapshot = useMemo(() => {
    if (!activeBook) {
      return { queue: [], dueCount: 0 };
    }

    return getStudyQueueSnapshot(activeBook, allWords, store.progressMap, activeBookEarlyReview, {
      newWordLimit: store.settings.newWordsLimit,
      shuffleNewWords: store.settings.newWordsShuffleEnabled,
      plannedNewWordKeys: plannedKeys,
      plannedModeEnabled: store.settings.plannedNewWordsEnabled,
      dailyStatsMap: store.dailyStatsMap,
    });
  }, [
    activeBook,
    allWords,
    store.progressMap,
    activeBookEarlyReview,
    store.settings.newWordsLimit,
    store.settings.newWordsShuffleEnabled,
    store.settings.plannedNewWordsEnabled,
    plannedKeys,
    store.dailyStatsMap,
  ]);

  const mergedQueue = useMemo(() => {
    const retryWords = immediateRetryWordKeys
      .map((key) => store.wordsByKey[key])
      .filter(Boolean);
    const retrySet = new Set(retryWords.map((word) => word.key));

    const baseQueue = queueSnapshot.queue
      .filter((word) => !retrySet.has(word.key))
      .filter((word) => !sessionSkippedWordKeys.includes(word.key));

    const merged = [...baseQueue];

    retryWords.forEach((word) => {
      const queueSize = merged.length;
      if (queueSize <= (store.settings.algorithmV4Enabled ? 3 : 5)) {
        merged.push(word);
        return;
      }
      const from = store.settings.algorithmV4Enabled ? 1 : 2;
      const insertIndex = Math.floor(Math.random() * (queueSize - from)) + from;
      merged.splice(insertIndex, 0, word);
    });

    return merged;
  }, [
    queueSnapshot.queue,
    immediateRetryWordKeys,
    store.wordsByKey,
    sessionSkippedWordKeys,
    store.settings.algorithmV4Enabled,
  ]);

  const queueHeadWord = mergedQueue[0] ?? null;
  const pendingFailedWord = pendingFailedWordKey ? store.wordsByKey[pendingFailedWordKey] ?? null : null;
  const currentWord = pendingFailedWord ?? queueHeadWord;
  const dueCount = queueSnapshot.dueCount;
  const totalCount = answeredInSession + mergedQueue.length + (pendingFailedWord ? 1 : 0);
  const currentIndex = totalCount === 0
    ? 0
    : pendingFailedWord
      ? answeredInSession + 1
      : mergedQueue.length === 0
        ? totalCount
        : answeredInSession + 1;
  const isInNewWords = currentWord ? store.newWords.includes(currentWord.key) : false;
  const aiAvailable = !!store.aiConfig.enabled && !!store.aiConfig.apiKey && !!store.aiConfig.modelName && !!store.aiConfig.apiBaseUrl;

  const currentProgress = currentWord ? store.progressMap[currentWord.key] ?? null : null;

  useEffect(() => {
    setPresentedAt(currentWord ? Date.now() : 0);
    setIsFlipped(false);
    setLearningAiState({ isLoading: false, activeType: null, content: "", error: "" });
    setShowAiPage(false);
    setShowAiGuide(false);
    setSwipeOffsetX(0);
    setSwipeActionHint("NONE");
    setSwipeDragging(false);
    swipePointerRef.current = null;
    suppressFlipClickRef.current = false;

    if (!currentWord) {
      setExampleContent("");
      setMemoryAidContent("");
      return;
    }

    const cachedExample = store.getAiCacheByWord(currentWord.key, "EXAMPLE");
    const cachedMemory = store.getAiCacheByWord(currentWord.key, "MEMORY_AID");
    setExampleContent(cachedExample?.aiContent ?? "");
    setMemoryAidContent(cachedMemory?.aiContent ?? "");
  }, [currentWord?.key]);

  useEffect(() => {
    if (!store.settings.swipeGestureGuideShown && currentWord && learningMode === "RECOGNITION") {
      setShowSwipeGuideLocal(true);
    }
  }, [currentWord, learningMode, store.settings.swipeGestureGuideShown]);

  useEffect(() => {
    if (currentWord || !activeBook) return;

    const activeBookWordCount = store.bookWordKeys[activeBook.id]?.length ?? 0;
    const shouldSwitchByEmptyBook = activeBookWordCount <= 0;
    const shouldSwitchByEmptyNewWords = activeBook.type === BOOK_TYPE_NEW_WORDS && store.newWords.length <= 0;

    if (!shouldSwitchByEmptyBook && !shouldSwitchByEmptyNewWords) return;

    const fallbackBook = store.books.find((book) => {
      if (book.id === activeBook.id) return false;
      if (book.type === BOOK_TYPE_NEW_WORDS) return false;
      return (store.bookWordKeys[book.id]?.length ?? 0) > 0;
    });

    if (!fallbackBook) return;

    store.switchBook(fallbackBook.id);
    setSnackbar({
      id: Date.now(),
      message: shouldSwitchByEmptyNewWords ? "生词本为空，已切换到可学习词书" : "当前词书为空，已切换到可学习词书",
    });
  }, [currentWord, activeBook, store.bookWordKeys, store.books, store.newWords.length]);

  useEffect(() => {
    setLearningMode(initialMode);
    if (initialMode !== "RECOGNITION") {
      setIsFlipped(false);
    }
  }, [initialMode]);

  useEffect(() => {
    if (!snackbar) return;
    const timer = window.setTimeout(() => setSnackbar(null), 3000);
    return () => window.clearTimeout(timer);
  }, [snackbar]);

  useEffect(() => {
    if (!currentWord) return;
    if (learningMode !== "RECOGNITION") return;
    if (!store.settings.pronunciationEnabled || !store.settings.recognitionAutoPronounceEnabled) return;
    void playWordPronunciation(currentWord);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWord?.key, learningMode, store.settings.pronunciationEnabled, store.settings.recognitionAutoPronounceEnabled]);

  const canRelieveReviewPressure =
    !!activeBook &&
    activeBook.type !== BOOK_TYPE_NEW_WORDS &&
    store.settings.reviewPressureReliefEnabled &&
    dueCount > store.settings.reviewPressureDailyCap;

  async function playWordPronunciation(word: Word): Promise<void> {
    if (pronouncingWordKey === word.key) return;
    setPronouncingWordKey(word.key);

    try {
      const url = await getPronunciationAudioUrl(
        word.word,
        store.settings.pronunciationSource,
        store.pronunciationIndex,
      );
      const audio = new Audio(url);
      await audio.play();
    } catch (error) {
      setSnackbar({
        id: Date.now(),
        message: error instanceof Error ? error.message : "单词发音失败",
      });
    } finally {
      setPronouncingWordKey(null);
    }
  }

  function openAiEntry(): void {
    if (currentAnswering) return;
    if (!aiAvailable) {
      setShowAiGuide(true);
      return;
    }
    setShowAiPage(true);
  }

  function recordStudyMetrics(delta: Partial<DailyStats>): void {
    const learningDate = currentLearningDate();
    store.updateDailyStats(learningDate, {
      newWordsCount: delta.newWordsCount ?? 0,
      reviewWordsCount: delta.reviewWordsCount ?? 0,
      spellPracticeCount: delta.spellPracticeCount ?? 0,
      durationMillis: delta.durationMillis ?? 0,
      gestureEasyCount: delta.gestureEasyCount ?? 0,
      gestureNotebookCount: delta.gestureNotebookCount ?? 0,
      fuzzyWordsCount: delta.fuzzyWordsCount ?? 0,
      recognizedWordsCount: delta.recognizedWordsCount ?? 0,
    });

    const completeCount =
      (delta.newWordsCount ?? 0) +
      (delta.reviewWordsCount ?? 0) +
      (delta.spellPracticeCount ?? 0);

    if (completeCount > 0) {
      store.recordStudyLog(learningDate, completeCount);
    }
  }

  function setWordProgress(wordKey: string, progress: Progress): void {
    store.setProgress(wordKey, progress);
  }

  function removeRetryWord(wordKey: string): void {
    setImmediateRetryWordKeys((prev) => prev.filter((item) => item !== wordKey));
  }

  function enqueueRetryWord(wordKey: string): void {
    setImmediateRetryWordKeys((prev) => {
      const filtered = prev.filter((item) => item !== wordKey);
      return [...filtered, wordKey];
    });
  }

  function markAnswered(): void {
    setAnsweredInSession((prev) => prev + 1);
  }

  function resolveMlContext(progress: Progress | null, now: number): {
    features: number[];
    forgetProbability: number;
    confidence: number;
  } | null {
    if (!store.settings.mlAdaptiveEnabled) return null;
    const features = extractMlFeatures(
      progress,
      answeredInSession,
      Math.max(1, totalCount),
      store.mlModel,
      now,
    );
    const { forgetProbability, confidence } = estimateForgetProbability(features, store.mlModel);
    return {
      features,
      forgetProbability,
      confidence,
    };
  }

  function submitRecognition(rating: StudyRating, removeFromNewWords = false): void {
    if (!currentWord || !activeBook || currentAnswering || !!pendingFailedWordKey) return;
    setCurrentAnswering(true);
    setLastRating(rating);

    const now = Date.now();
    const responseTimeMs = Math.max(0, now - presentedAt);
    const responseThresholdMs = computeAdaptiveResponseThreshold(
      store.settings.mlAdaptiveEnabled,
      store.mlModel,
    );
    const resolvedRating = evaluateRecognitionByResponseTime(
      rating,
      responseTimeMs,
      store.settings.algorithmV4Enabled,
      responseThresholdMs,
    );

    const existingProgress = store.progressMap[currentWord.key] ?? null;
    const baseSchedule = scheduleRecognition(
      existingProgress,
      resolvedRating,
      now,
      store.settings.algorithmV4Enabled,
    );
    const mlContext = resolveMlContext(existingProgress, now);
    const mlAdjusted = mlContext
      ? applyMlScheduleAdjustment(
          {
            intervalDays: baseSchedule.intervalDays,
            easeFactor: baseSchedule.easeFactor,
            nextReviewTime: baseSchedule.nextReviewTime,
          },
          mlContext.forgetProbability,
          mlContext.confidence,
          now,
        )
      : null;

    const schedule = mlAdjusted
      ? {
          ...baseSchedule,
          intervalDays: mlAdjusted.intervalDays,
          easeFactor: mlAdjusted.easeFactor,
          nextReviewTime: mlAdjusted.nextReviewTime,
        }
      : baseSchedule;

    const previousReviewCount = existingProgress?.reviewCount ?? 0;
    const qualifiesAsCompleted = resolvedRating >= STUDY_RATING_HARD;
    const reviewCount = previousReviewCount + (qualifiesAsCompleted ? 1 : 0);
    const isNewLearningCompletion = qualifiesAsCompleted && previousReviewCount === 0;
    const isReviewCompletion = qualifiesAsCompleted && previousReviewCount > 0;

    const nextProgress: Progress = {
      ...(existingProgress ?? {
        status: PROGRESS_STATUS_LEARNING,
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
      }),
      wordKey: currentWord.key,
      status: schedule.status,
      repetitions: schedule.repetitions,
      intervalDays: schedule.intervalDays,
      nextReviewTime: schedule.nextReviewTime,
      easeFactor: schedule.easeFactor,
      reviewCount,
      consecutiveCorrect:
        resolvedRating !== STUDY_RATING_AGAIN ? (existingProgress?.consecutiveCorrect ?? 0) + 1 : 0,
      avgResponseTimeMs:
        responseTimeMs > 0
          ? existingProgress && existingProgress.reviewCount > 0
            ?
                (existingProgress.avgResponseTimeMs * existingProgress.reviewCount + responseTimeMs) /
                (existingProgress.reviewCount + 1)
            : responseTimeMs
          : existingProgress?.avgResponseTimeMs ?? 0,
      lastReviewTime: now,
    };

    if (removeFromNewWords) {
      store.removeFromNewWords(currentWord.key);
    }

    setWordProgress(currentWord.key, nextProgress);

    if (mlContext) {
      const outcome = resolvedRating === STUDY_RATING_AGAIN ? 1 : 0;
      store.addTrainingSample({
        wordKey: currentWord.key,
        features: mlContext.features,
        outcome,
        timestamp: now,
        predictionError: Math.abs(mlContext.forgetProbability - outcome),
      });
    }

    if (resolvedRating === STUDY_RATING_AGAIN) {
      enqueueRetryWord(currentWord.key);
      setMemoryAidSuggestionWordKey(currentWord.key);
      setCurrentAnswering(false);
      return;
    }

    removeRetryWord(currentWord.key);
    setMemoryAidSuggestionWordKey(null);
    setPendingFailedWordKey(null);
    markAnswered();

    recordStudyMetrics({
      newWordsCount: isNewLearningCompletion ? 1 : 0,
      reviewWordsCount: isReviewCompletion ? 1 : 0,
      fuzzyWordsCount: resolvedRating === STUDY_RATING_HARD ? 1 : 0,
      recognizedWordsCount: resolvedRating === STUDY_RATING_GOOD ? 1 : 0,
    });

    setCurrentAnswering(false);
  }

  function markTooEasyByGesture(): void {
    if (!currentWord || !activeBook || currentAnswering || !!pendingFailedWordKey) return;
    const wordKey = currentWord.key;
    const existing = store.progressMap[wordKey] ?? null;
    const snapshot = existing ? { ...existing } : null;
    const now = Date.now();

    const next: Progress = {
      ...(existing ?? {
        status: PROGRESS_STATUS_LEARNING,
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
      }),
      wordKey,
      status: PROGRESS_STATUS_MASTERED,
      repetitions: Math.max(existing?.repetitions ?? 0, 1),
      intervalDays: 30,
      nextReviewTime: dayjs(now).add(30, "day").hour(4).minute(0).second(0).millisecond(0).valueOf(),
      markedEasyCount: (existing?.markedEasyCount ?? 0) + 1,
      lastEasyTime: now,
    };

    store.setProgress(wordKey, next);
    markAnswered();
    recordStudyMetrics({ gestureEasyCount: 1 });

    const undoToken = Date.now();
    const undoSnapshot = snapshot ? { ...snapshot } : null;
    setUndoTooEasyState({ token: undoToken, wordKey, snapshot: undoSnapshot });
    setSnackbar({
      id: undoToken,
      message: "已标记为太简单，30天后复习",
      actionText: "撤销",
      actionType: "UNDO_TOO_EASY",
    });
  }

  function addNotebookByGesture(): void {
    if (!currentWord || currentAnswering || !!pendingFailedWordKey) return;
    const inserted = store.addToNewWords(currentWord.key);
    markAnswered();
    setSessionSkippedWordKeys((prev) => [...prev, currentWord.key]);
    recordStudyMetrics({ gestureNotebookCount: 1 });

    setSnackbar({
      id: Date.now(),
      message: inserted ? "已加入生词本" : "已在生词本中",
    });
  }

  async function requestLearningAi(type: "EXAMPLE" | "MEMORY_AID", forceRefresh: boolean): Promise<void> {
    if (!currentWord) return;
    if (!aiAvailable) {
      setLearningAiState({ isLoading: false, activeType: type, content: "", error: "请先在我的实验室中配置 AI" });
      return;
    }

    const cache = store.getAiCacheByWord(currentWord.key, type);
    if (!forceRefresh && cache?.aiContent) {
      setLearningAiState({ isLoading: false, activeType: type, content: cache.aiContent, error: "" });
      if (type === "EXAMPLE") setExampleContent(cache.aiContent);
      if (type === "MEMORY_AID") setMemoryAidContent(cache.aiContent);
      return;
    }

    setLearningAiState({ isLoading: true, activeType: type, content: "", error: "" });
    try {
      const content = await generateAiContent(store.aiConfig, type, currentWord.word);
      store.putAiCache({
        key: `${type}:${currentWord.key}:${currentWord.word}`,
        wordKey: currentWord.key,
        queryContent: currentWord.word,
        type,
        aiContent: content,
        modelName: store.aiConfig.modelName,
        createdAt: Date.now(),
      });
      setLearningAiState({ isLoading: false, activeType: type, content, error: "" });
      if (type === "EXAMPLE") setExampleContent(content);
      if (type === "MEMORY_AID") {
        setMemoryAidContent(content);
        setMemoryAidSuggestionWordKey(null);
      }
    } catch (error) {
      setLearningAiState({
        isLoading: false,
        activeType: type,
        content: "",
        error: error instanceof Error ? error.message : "AI 请求失败",
      });
    }
  }

  function submitSpellingOutcome(outcome: number, attemptCount: number, durationMillis: number): void {
    if (!currentWord || currentAnswering) return;
    setCurrentAnswering(true);
    const wordKey = currentWord.key;
    const failedOutcome = outcome === SPELLING_OUTCOME_FAILED;
    const now = Date.now();

    if (failedOutcome) {
      setPendingFailedWordKey(wordKey);
      setMemoryAidSuggestionWordKey(wordKey);
    }

    const existingProgress = store.progressMap[wordKey] ?? null;
    const baseSchedule = scheduleSpelling(
      existingProgress,
      outcome as typeof SPELLING_OUTCOME_FAILED,
      now,
      store.settings.algorithmV4Enabled,
    );
    const mlContext = resolveMlContext(existingProgress, now);
    const mlAdjusted = mlContext
      ? applyMlScheduleAdjustment(
          {
            intervalDays: baseSchedule.intervalDays,
            easeFactor: baseSchedule.easeFactor,
            nextReviewTime: baseSchedule.nextReviewTime,
          },
          mlContext.forgetProbability,
          mlContext.confidence,
          now,
        )
      : null;

    const schedule = mlAdjusted
      ? {
          ...baseSchedule,
          intervalDays: mlAdjusted.intervalDays,
          easeFactor: mlAdjusted.easeFactor,
          nextReviewTime: mlAdjusted.nextReviewTime,
        }
      : baseSchedule;

    const previousReviewCount = existingProgress?.reviewCount ?? 0;
    const qualifiesAsCompleted = outcome >= STUDY_RATING_HARD;
    const reviewCount = previousReviewCount + (qualifiesAsCompleted ? 1 : 0);
    const isNewLearningCompletion = qualifiesAsCompleted && previousReviewCount === 0;
    const isReviewCompletion = qualifiesAsCompleted && previousReviewCount > 0;

    const nextProgress: Progress = {
      ...(existingProgress ?? {
        status: PROGRESS_STATUS_LEARNING,
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
      }),
      wordKey,
      status: schedule.status,
      repetitions: schedule.repetitions,
      intervalDays: schedule.intervalDays,
      nextReviewTime: schedule.nextReviewTime,
      easeFactor: schedule.easeFactor,
      reviewCount,
      spellCorrectCount: (existingProgress?.spellCorrectCount ?? 0) + (outcome === SPELLING_OUTCOME_FAILED ? 0 : 1),
      spellWrongCount: (existingProgress?.spellWrongCount ?? 0) + (outcome === SPELLING_OUTCOME_FAILED ? 1 : 0),
      consecutiveCorrect:
        outcome === SPELLING_OUTCOME_FAILED ? 0 : (existingProgress?.consecutiveCorrect ?? 0) + 1,
      avgResponseTimeMs:
        durationMillis > 0
          ? existingProgress && existingProgress.reviewCount > 0
            ?
                (existingProgress.avgResponseTimeMs * existingProgress.reviewCount + durationMillis) /
                (existingProgress.reviewCount + 1)
            : durationMillis
          : existingProgress?.avgResponseTimeMs ?? 0,
      lastReviewTime: now,
    };

    store.setProgress(wordKey, nextProgress);

    if (mlContext) {
      const trainingOutcome = failedOutcome ? 1 : 0;
      store.addTrainingSample({
        wordKey,
        features: mlContext.features,
        outcome: trainingOutcome,
        timestamp: now,
        predictionError: Math.abs(mlContext.forgetProbability - trainingOutcome),
      });
    }

    recordStudyMetrics({
      newWordsCount: isNewLearningCompletion ? 1 : 0,
      reviewWordsCount: isReviewCompletion ? 1 : 0,
      spellPracticeCount: Math.max(1, attemptCount),
      durationMillis,
    });

    if (failedOutcome) {
      setCurrentAnswering(false);
      return;
    }

    setPendingFailedWordKey(null);
    setMemoryAidSuggestionWordKey(null);
    removeRetryWord(wordKey);
    markAnswered();
    setCurrentAnswering(false);
  }

  function continueAfterSpellingFailure(): void {
    if (!pendingFailedWordKey) return;
    enqueueRetryWord(pendingFailedWordKey);
    setPendingFailedWordKey(null);
    markAnswered();
  }

  function toggleNewWordForLearning(wordKey: string): void {
    const latest = useAppStore.getState();
    if (latest.newWords.includes(wordKey)) {
      latest.removeFromNewWords(wordKey);
    } else {
      latest.addToNewWords(wordKey);
    }
  }

  function handleSnackbarAction(): void {
    if (!snackbar) return;
    if (snackbar.actionType === "UNDO_TOO_EASY") {
      const payload = undoTooEasyState;
      if (!payload || payload.token !== snackbar.id) {
        setSnackbar(null);
        return;
      }

      if (payload.snapshot) {
        store.setProgress(payload.wordKey, payload.snapshot);
      } else {
        store.removeProgress(payload.wordKey);
      }
      store.updateDailyStats(currentLearningDate(), { gestureEasyCount: -1 });
      setAnsweredInSession((prev) => Math.max(0, prev - 1));
      setUndoTooEasyState(null);
      setSnackbar({ id: Date.now(), message: "已撤销太简单标记" });
      return;
    }

    setSnackbar(null);
  }

  function clearSwipeState(): void {
    setSwipeOffsetX(0);
    setSwipeActionHint("NONE");
    setSwipeDragging(false);
    swipePointerRef.current = null;
  }

  function handleFlipAreaClick(): void {
    if (suppressFlipClickRef.current) {
      suppressFlipClickRef.current = false;
      return;
    }
    setIsFlipped((prev) => !prev);
  }

  function handleWordCardPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (!currentWord || currentAnswering || !!pendingFailedWordKey) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    if (!isStartInActiveZone(localX, rect.width)) return;
    suppressFlipClickRef.current = false;
    clearSwipeState();
    swipePointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      dragging: false,
      offsetX: 0,
    };
    target.setPointerCapture(event.pointerId);
  }

  function handleWordCardPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const state = swipePointerRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;

    if (!state.dragging) {
      if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) {
        clearSwipeState();
        return;
      }
      if (Math.abs(deltaX) < 8) return;
      state.dragging = true;
      setSwipeDragging(true);
    }

    event.preventDefault();
    const maxOffset = state.width * 0.6;
    const clampedOffset = Math.max(-maxOffset, Math.min(maxOffset, deltaX));
    state.offsetX = clampedOffset;
    setSwipeOffsetX(clampedOffset);
    setSwipeActionHint(resolveSwipeAction(clampedOffset, triggerThreshold(state.width)));
  }

  function handleWordCardPointerEnd(event: ReactPointerEvent<HTMLButtonElement>): void {
    const state = swipePointerRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const wasDragging = state.dragging;
    const action = wasDragging ? resolveSwipeAction(state.offsetX, triggerThreshold(state.width)) : "NONE";
    clearSwipeState();

    if (action === "TOO_EASY") {
      suppressFlipClickRef.current = true;
      markTooEasyByGesture();
      return;
    }
    if (action === "ADD_TO_NOTEBOOK") {
      suppressFlipClickRef.current = true;
      addNotebookByGesture();
      return;
    }
    if (wasDragging) {
      suppressFlipClickRef.current = true;
    }
  }

  function relieveReviewPressure(): void {
    if (!activeBook) return;
    const cap = Math.max(1, store.settings.reviewPressureDailyCap);
    const dueWords = allWords
      .map((word) => ({ word, progress: store.progressMap[word.key] }))
      .filter((item) => item.progress)
      .filter((item) => {
        const progress = item.progress as Progress;
        return progress.status !== PROGRESS_STATUS_MASTERED && progress.nextReviewTime > 0 && dayjs(progress.nextReviewTime).isBefore(dayjs().add(1, "minute"));
      }) as Array<{ word: Word; progress: Progress }>;

    if (dueWords.length <= cap) {
      setSnackbar({ id: Date.now(), message: "当前待复习数量未超过上限" });
      return;
    }

    const overflow = dueWords.slice(cap);
    overflow.forEach((item, index) => {
      const dayOffset = (index % Math.ceil(overflow.length / cap)) + 1;
      store.setProgress(item.word.key, {
        ...item.progress,
        nextReviewTime: dayjs().add(dayOffset, "day").hour(4).minute(0).second(0).millisecond(0).valueOf(),
      });
    });

    setSnackbar({ id: Date.now(), message: `已分散 ${overflow.length} 个待复习单词到后续天` });
  }

  const currentReviewTag = reviewTag(currentProgress?.nextReviewTime ?? 0);
  const currentReviewDesc = reviewDescription(currentProgress?.nextReviewTime ?? 0);
  const lastReviewTime = estimateLastReviewTime(
    currentProgress?.nextReviewTime ?? 0,
    currentProgress?.intervalDays ?? 0,
    currentProgress?.reviewCount ?? 0,
  );
  const learningWordSizeClass =
    currentWord && currentWord.word.length >= 11
      ? "compact"
      : currentWord && currentWord.word.length >= 8
        ? "medium"
        : "";

  return (
    <div className={`page-wrap learning-page ${learningMode === "RECOGNITION" ? "mode-recognition" : "mode-spelling"}`}>
      <header className="panel-card learning-header">
        <div className="segment-tabs">
          <button
            type="button"
            className={learningMode === "RECOGNITION" ? "active" : ""}
            onClick={() => {
              setLearningMode("RECOGNITION");
              onModeChange("RECOGNITION");
            }}
          >
            认词模式
          </button>
          <button
            type="button"
            className={learningMode === "SPELLING" ? "active" : ""}
            onClick={() => {
              setLearningMode("SPELLING");
              onModeChange("SPELLING");
            }}
          >
            拼写模式
          </button>
        </div>
        <div className="learning-meta-line">
          <span>当前词书：{activeBook?.name ?? "-"}</span>
          <span>学习进度 {currentIndex}/{totalCount}</span>
        </div>
      </header>

      {canRelieveReviewPressure && (
        <div className="panel-card pressure-banner">
          <div>
            <strong>今日待复习 {dueCount}，超过上限 {store.settings.reviewPressureDailyCap}</strong>
            <p>点击后会把超出部分均匀顺延到后续天。</p>
          </div>
          <button type="button" className="outlined" onClick={relieveReviewPressure}>分散压力</button>
        </div>
      )}

      {!currentWord && (
        <div className="panel-card empty-center">
          <p>暂无单词</p>
        </div>
      )}

      {currentWord && learningMode === "RECOGNITION" && (
        <>
          <div className={`panel-card learning-word-card ${lastRating ? "animate-switch" : ""}`}>
            <div className="learning-word-card-top">
              <button type="button" className="review-tag" onClick={() => setShowReviewDialog(true)}>
                <CalendarClock size={14} /> {currentReviewTag}
              </button>
              <div className="top-right-actions">
                {store.settings.pronunciationEnabled && (
                  <button
                    type="button"
                    className="outlined small"
                    onClick={() => void playWordPronunciation(currentWord)}
                    disabled={pronouncingWordKey === currentWord.key}
                  >
                    {pronouncingWordKey === currentWord.key ? <LoaderCircle size={14} className="spinning" /> : <Volume2 size={14} />} 发音
                  </button>
                )}
                <AnimatedStarToggle
                  checked={isInNewWords}
                  onToggle={() => toggleNewWordForLearning(currentWord.key)}
                  disabled={currentAnswering}
                />
              </div>
            </div>

            <button
              type="button"
              className={`word-flip-area ${swipeDragging ? "swipe-dragging" : ""} ${swipeActionHint === "TOO_EASY" ? "swipe-too-easy" : ""} ${swipeActionHint === "ADD_TO_NOTEBOOK" ? "swipe-add-notebook" : ""}`}
              style={{
                transform: `translateX(${swipeOffsetX}px)`,
                transition: swipeDragging ? "none" : "transform 180ms ease",
              }}
              onClick={handleFlipAreaClick}
              onPointerDown={handleWordCardPointerDown}
              onPointerMove={handleWordCardPointerMove}
              onPointerUp={handleWordCardPointerEnd}
              onPointerCancel={handleWordCardPointerEnd}
            >
              {!isFlipped ? (
                <>
                  <h2 className={`learning-word-text ${learningWordSizeClass}`.trim()}>{currentWord.word}</h2>
                  {currentWord.phonetic && <p className="phonetic-text">{currentWord.phonetic}</p>}
                  <p className="muted">轻触卡片查看释义与例句</p>
                </>
              ) : (
                <div className="word-back-face">
                  <h3>{currentWord.word}</h3>
                  {currentWord.phonetic && <p className="phonetic-text">{currentWord.phonetic}</p>}
                  {currentWord.meaning && (
                    <div className="word-section">
                      <strong>释义</strong>
                      <p>{currentWord.meaning}</p>
                    </div>
                  )}
                  {currentWord.example && (
                    <div className="word-section muted-bg">
                      <strong>例句</strong>
                      <p>{currentWord.example}</p>
                    </div>
                  )}
                  {currentWord.phrases && (
                    <div className="word-section muted-bg">
                      <strong>短语</strong>
                      <p>{currentWord.phrases}</p>
                    </div>
                  )}
                  {currentWord.synonyms && (
                    <div className="word-section muted-bg">
                      <strong>近义词</strong>
                      <p>{currentWord.synonyms}</p>
                    </div>
                  )}
                  {currentWord.relWords && (
                    <div className="word-section muted-bg">
                      <strong>同根词</strong>
                      <p>{currentWord.relWords}</p>
                    </div>
                  )}
                  {currentProgress && (
                    <div className="word-section muted-bg">
                      <strong>EF系数因子：{currentProgress.easeFactor.toFixed(2)}</strong>
                      <p>相对基准2.50偏移：{(currentProgress.easeFactor - 2.5).toFixed(2)}</p>
                      <p>当前间隔：{currentProgress.intervalDays} 天 · 复习次数：{currentProgress.reviewCount}</p>
                    </div>
                  )}
                </div>
              )}
            </button>

            {aiAvailable && (
              <div className="learning-card-bottom">
                <button
                  type="button"
                  className="small outlined"
                  onClick={openAiEntry}
                  disabled={currentAnswering}
                >
                  <Bot size={14} /> {memoryAidSuggestionWordKey === currentWord.key ? "助记推荐" : "AI"}
                </button>
              </div>
            )}
          </div>

          <div className="panel-card recognition-actions">
            <button type="button" className="again" onClick={() => submitRecognition(STUDY_RATING_AGAIN)} disabled={currentAnswering}>不认识</button>
            <button type="button" className="hard" onClick={() => submitRecognition(STUDY_RATING_HARD)} disabled={currentAnswering}>模糊</button>
            <button
              type="button"
              className="good"
              onClick={() => {
                if (activeBook?.type === BOOK_TYPE_NEW_WORDS) {
                  setShowRemoveDialog(true);
                  return;
                }
                submitRecognition(STUDY_RATING_GOOD);
              }}
              disabled={currentAnswering}
            >
              {activeBook?.type === BOOK_TYPE_NEW_WORDS ? "认识并移出" : "认识"}
            </button>
          </div>
        </>
      )}

      {currentWord && learningMode === "SPELLING" && (
        <SpellingPanel
          word={currentWord}
          algorithmV4Enabled={store.settings.algorithmV4Enabled}
          aiAvailable={aiAvailable}
          aiLoading={learningAiState.isLoading && learningAiState.activeType === "MEMORY_AID"}
          aiAssistText={memoryAidContent}
          aiAssistError={learningAiState.activeType === "MEMORY_AID" ? learningAiState.error : ""}
          onRequestAiAssist={(forceRefresh) => void requestLearningAi("MEMORY_AID", forceRefresh)}
          onResolved={(outcome, attempts, durationMillis) => submitSpellingOutcome(outcome, attempts, durationMillis)}
          onContinueAfterFailure={continueAfterSpellingFailure}
          pendingFailed={pendingFailedWordKey === currentWord.key}
        />
      )}

      <div className="panel-card progress-card">
        <div className="learning-progress-meta">
          <span>学习进度</span>
          <strong>{currentIndex}/{totalCount}</strong>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${totalCount > 0 ? (currentIndex / totalCount) * 100 : 0}%` }} />
        </div>
      </div>

      {showReviewDialog && (
        <Dialog title="复习时间" onClose={() => setShowReviewDialog(false)} showCloseButton={false} overlayTone="dark">
          <p>上次复习：{lastReviewTime ? formatDateTime(lastReviewTime) : "暂无"}</p>
          <p>下次复习：{formatReviewDay(currentProgress?.nextReviewTime ?? 0) || "暂无"}</p>
          <p>提示：{currentReviewDesc}</p>
          <p className="muted">SM-2 调度说明：不认识会在会话内重试，模糊保守推进，认识按记忆因子增长间隔。</p>
          <div className="dialog-actions">
            <button type="button" className="text-action-button primary" onClick={() => setShowReviewDialog(false)}>知道了</button>
          </div>
        </Dialog>
      )}

      {showAiGuide && (
        <Dialog title="AI 功能未配置" onClose={() => setShowAiGuide(false)} showCloseButton={false}>
          <p>请先在我的实验室配置 API Key 解锁智能助记。</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setShowAiGuide(false)}>知道了</button>
          </div>
        </Dialog>
      )}

      {showSwipeGuideLocal && (
        <Dialog title="手势快捷操作" onClose={() => setShowSwipeGuideLocal(false)} showCloseButton={false}>
          <p>左滑超过 30%：标记太简单，30 天后复习。</p>
          <p>右滑超过 30%：快速加入生词本，并切换到下一词。</p>
          <div className="dialog-actions between">
            <button
              type="button"
              className="outlined"
              onClick={() => {
                store.setSettings({ swipeGestureGuideShown: true });
                setShowSwipeGuideLocal(false);
              }}
            >
              不再提示
            </button>
            <button type="button" onClick={() => setShowSwipeGuideLocal(false)}>知道了</button>
          </div>
        </Dialog>
      )}

      {showRemoveDialog && currentWord && (
        <Dialog title="移出生词本" onClose={() => setShowRemoveDialog(false)} showCloseButton={false}>
          <p>确认将该单词从生词本移出吗？</p>
          <div className="dialog-actions between">
            <button type="button" className="outlined" onClick={() => setShowRemoveDialog(false)}>取消</button>
            <button
              type="button"
              onClick={() => {
                store.removeFromNewWords(currentWord.key);
                submitRecognition(STUDY_RATING_GOOD, true);
                setShowRemoveDialog(false);
              }}
            >
              移出
            </button>
          </div>
        </Dialog>
      )}

      {showAiPage && currentWord && (
        <Dialog title="AI 学习助手" onClose={() => setShowAiPage(false)} full>
          <div className="ai-page-head">
            <button type="button" className="outlined" onClick={() => setShowAiPage(false)}>
              返回认词
            </button>
            <div>
              <strong>{currentWord.word}</strong>
              <p className="muted">例句和助记会在本页展示，生成内容仅供学习参考。</p>
            </div>
          </div>

          {memoryAidSuggestionWordKey === currentWord.key && (
            <div className="notice danger">刚才答错了，建议优先生成助记技巧。</div>
          )}

          {!store.aiConfig.enabled || !store.aiConfig.apiKey ? (
            <div className="notice">AI 未启用或未配置，请先前往我的实验室完成配置。</div>
          ) : null}

          <div className="split-columns">
            <div className="panel-card">
              <h4>例句生成</h4>
              {!isFlipped && <p className="muted">请先翻卡查看释义后再生成例句。</p>}
              {learningAiState.isLoading && learningAiState.activeType === "EXAMPLE" && <LoadingInline text="正在生成例句..." />}
              {learningAiState.error && learningAiState.activeType === "EXAMPLE" && <p className="error-text">{learningAiState.error}</p>}
              {exampleContent && (
                <div className="ai-result-card">
                  <div className="ai-result-head">
                    <strong>AI 生成例句</strong>
                    <AIGeneratedBadge />
                  </div>
                  <pre>{exampleContent}</pre>
                </div>
              )}
              <button
                type="button"
                className="outlined"
                disabled={learningAiState.isLoading || !isFlipped}
                onClick={() => void requestLearningAi("EXAMPLE", !!exampleContent)}
              >
                {exampleContent ? "重新生成例句" : "生成例句"}
              </button>
            </div>

            <div className="panel-card">
              <h4>助记技巧</h4>
              {learningAiState.isLoading && learningAiState.activeType === "MEMORY_AID" && <LoadingInline text="正在生成助记..." />}
              {learningAiState.error && learningAiState.activeType === "MEMORY_AID" && <p className="error-text">{learningAiState.error}</p>}
              {memoryAidContent && (
                <div className="ai-result-card">
                  <div className="ai-result-head">
                    <strong>AI 助记技巧</strong>
                    <AIGeneratedBadge />
                  </div>
                  <pre>{memoryAidContent}</pre>
                </div>
              )}
              <button
                type="button"
                className="outlined"
                disabled={learningAiState.isLoading}
                onClick={() => void requestLearningAi("MEMORY_AID", !!memoryAidContent)}
              >
                {memoryAidContent ? "重新生成助记" : "生成助记"}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {snackbar && (
        <div className="snackbar">
          <span>{snackbar.message}</span>
          {snackbar.actionText && (
            <button
              type="button"
              onClick={handleSnackbarAction}
            >
              {snackbar.actionText}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SpellingPanel({
  word,
  algorithmV4Enabled,
  aiAvailable,
  aiLoading,
  aiAssistText,
  aiAssistError,
  onRequestAiAssist,
  onResolved,
  onContinueAfterFailure,
  pendingFailed,
}: {
  word: Word;
  algorithmV4Enabled: boolean;
  aiAvailable: boolean;
  aiLoading: boolean;
  aiAssistText: string;
  aiAssistError: string;
  onRequestAiAssist: (forceRefresh: boolean) => void;
  onResolved: (outcome: number, attempts: number, durationMillis: number) => void;
  onContinueAfterFailure: () => void;
  pendingFailed: boolean;
}) {
  const [input, setInput] = useState("");
  const [copyInput, setCopyInput] = useState("");
  const [attemptCount, setAttemptCount] = useState(0);
  const [status, setStatus] = useState<"idle" | "wrong" | "correct" | "copyRequired">("idle");
  const [showFirstHint, setShowFirstHint] = useState(false);
  const [showLengthHint, setShowLengthHint] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());

  useEffect(() => {
    setInput("");
    setCopyInput("");
    setAttemptCount(0);
    setStatus("idle");
    setShowFirstHint(false);
    setShowLengthHint(false);
    setStartedAt(Date.now());
  }, [word.key]);

  useEffect(() => {
    if (pendingFailed) {
      setStatus("copyRequired");
      setShowFirstHint(false);
      setShowLengthHint(false);
    }
  }, [pendingFailed]);

  const usedHint = showFirstHint || showLengthHint;

  const submit = () => {
    const answer = input.trim();
    if (!answer || status === "copyRequired") return;

    const attempts = attemptCount + 1;
    setAttemptCount(attempts);

    const outcome = evaluateSpelling(
      answer,
      word.word,
      usedHint,
      attempts,
      algorithmV4Enabled,
    );

    if (outcome !== SPELLING_OUTCOME_FAILED) {
      setStatus("correct");
      onResolved(outcome, attempts, Math.max(0, Date.now() - startedAt));
      return;
    }

    setShowFirstHint(false);
    setShowLengthHint(false);
    setStatus("wrong");
    if (attempts >= MAX_SPELL_ATTEMPTS) {
      setStatus("copyRequired");
      onResolved(outcome, attempts, Math.max(0, Date.now() - startedAt));
    }
  };

  const attemptProgress = Math.min(100, (attemptCount / MAX_SPELL_ATTEMPTS) * 100);
  const remainingAttempts = Math.max(0, MAX_SPELL_ATTEMPTS - attemptCount);
  const statusText =
    status === "idle"
      ? "根据释义拼写单词"
      : status === "correct"
        ? "拼写正确，正在进入下一词"
        : status === "wrong"
          ? "拼写有误，可继续尝试"
          : "已达最大尝试次数，需抄写后继续";
  const canShowAiAssistAction = status === "wrong" || status === "copyRequired";
  const copyMatched = copyInput.trim().toLowerCase() === word.word.trim().toLowerCase();

  return (
    <div className="panel-card spelling-panel">
      <div className="spelling-scroll">
        <div className={`spelling-status-card ${status}`}>
          <div className="spelling-head">
            <strong>拼写练习</strong>
            <span>{attemptCount}/{MAX_SPELL_ATTEMPTS} 次</span>
          </div>
          <p className={`spelling-status-text ${status}`}>{statusText}</p>
          <div className="spelling-progress">
            <div className="spelling-progress-fill" style={{ width: `${attemptProgress}%` }} />
          </div>
          <p className="spelling-remain">
            {status === "copyRequired" ? "本词已进入抄写纠错阶段" : `当前剩余尝试次数：${remainingAttempts}`}
          </p>
        </div>

        <div className="spelling-question-card">
          <p className="muted">根据释义拼写英文单词</p>
          {word.phonetic && <p className="phonetic-text spelling-phonetic">{word.phonetic}</p>}
          <p className="spelling-meaning">{word.meaning || "无释义"}</p>
        </div>

        {status === "idle" && (
          <div className="spelling-hint-tools">
            <p className="muted">提示工具（会降低评分）</p>
            <div className="hint-row">
              <button
                type="button"
                className={showFirstHint ? "active" : ""}
                onClick={() => setShowFirstHint((prev) => !prev)}
              >
                首字母
              </button>
              <button
                type="button"
                className={showLengthHint ? "active" : ""}
                onClick={() => setShowLengthHint((prev) => !prev)}
              >
                长度
              </button>
            </div>
            {(showFirstHint || showLengthHint) && (
              <div className="spelling-hint-result">
                {showFirstHint && <p>首字母：{word.word[0] || "-"}</p>}
                {showLengthHint && <p>长度：{word.word.length}</p>}
              </div>
            )}
          </div>
        )}

      </div>

      <div className={`spelling-input-dock ${status}`}>
        {status !== "copyRequired" ? (
          <>
            <input
              className="text-input"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                if (status === "wrong") setStatus("idle");
              }}
              placeholder="请输入单词拼写"
            />
            {input && (
              <div className="spelling-match-indicator">
                <span className="muted">纠错提示：</span>
                <span className="muted">{renderSpellingHint(input, word.word)}</span>
              </div>
            )}
            {status === "wrong" && attemptCount < MAX_SPELL_ATTEMPTS && (
              <p className="error-text">拼写错误，请再试一次（剩余 {MAX_SPELL_ATTEMPTS - attemptCount} 次）</p>
            )}
            <button type="button" disabled={!input.trim()} onClick={submit}>
              {attemptCount > 0 ? "重试" : "提交"}
            </button>
          </>
        ) : (
          <>
            <p className="error-text">正确拼写：{word.word}</p>
            <input
              className="text-input"
              value={copyInput}
              onChange={(event) => setCopyInput(event.target.value)}
              placeholder="请抄写正确拼写后继续"
            />
            <button type="button" disabled={!copyMatched} onClick={onContinueAfterFailure}>
              继续
            </button>
          </>
        )}

        {canShowAiAssistAction && (
          <div className="spelling-ai-section">
            <button
              type="button"
              className="outlined"
              disabled={!aiAvailable || aiLoading}
              onClick={() => onRequestAiAssist(!!aiAssistText)}
            >
              {aiLoading ? "正在生成 AI 助记..." : aiAssistText ? "重新生成 AI 助记" : "AI 助记"}
            </button>
            {!aiAvailable && <p className="muted">AI 未启用或未配置，请前往我的实验室设置。</p>}
            {aiAssistError && <p className="error-text">{aiAssistError}</p>}
            {aiAssistText && (
              <div className="ai-result-card">
                <div className="ai-result-head">
                  <strong>AI 助记</strong>
                  <AIGeneratedBadge />
                </div>
                <pre>{aiAssistText}</pre>
                <p className="muted">内容由 AI 生成，请甄别参考。</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function renderSpellingHint(input: string, target: string): string {
  const chars = input.split("");
  return chars
    .map((char, index) => {
      const expected = target[index];
      return char.toLowerCase() === (expected ?? "").toLowerCase() ? `✓${char}` : `✗${char}`;
    })
    .join(" ");
}

function SearchTab({ activeBook }: { activeBook: ReturnType<typeof getActiveBook> }) {
  const store = useAppStore();
  const androidVisualMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("androidVisual") === "1";
  const [query, setQuery] = useState("");
  const [selectedWordKey, setSelectedWordKey] = useState<string | null>(null);
  const [sentenceLoading, setSentenceLoading] = useState(false);
  const [sentenceError, setSentenceError] = useState("");
  const [sentenceAnalysis, setSentenceAnalysis] = useState<SearchSentenceAnalysis | null>(null);

  const [wordAiState, setWordAiState] = useState({
    loading: false,
    content: "",
    error: "",
    translationLoading: false,
    translationContent: "",
    translationError: "",
  });

  const allWords = useMemo(() => {
    if (!activeBook) return [];
    if (activeBook.type === BOOK_TYPE_NEW_WORDS) {
      return Object.values(store.wordsByKey);
    }
    return getWordListForBook(activeBook, store.wordsByKey, store.bookWordKeys, store.newWords);
  }, [activeBook, store.wordsByKey, store.bookWordKeys, store.newWords]);

  const sentenceMode = query.trim().length > 20;

  useEffect(() => {
    if (!sentenceMode) {
      setSentenceLoading(false);
      setSentenceError("");
      setSentenceAnalysis(null);
      return;
    }

    const timer = window.setTimeout(() => {
      void analyzeSentence(false);
    }, 350);

    return () => window.clearTimeout(timer);
  }, [query, sentenceMode]);

  async function analyzeSentence(forceRefresh: boolean): Promise<void> {
    const normalized = query.trim();
    if (normalized.length <= 20) return;

    const cache = store.getAiCacheByQuery(normalized, "SENTENCE");
    if (!forceRefresh && cache?.aiContent) {
      setSentenceAnalysis(parseSentenceAnalysis(cache.aiContent));
      setSentenceError("");
      return;
    }

    if (!store.aiConfig.enabled || !store.aiConfig.apiKey || !store.aiConfig.apiBaseUrl || !store.aiConfig.modelName) {
      setSentenceError("请先在我的实验室启用并配置 API Key");
      return;
    }

    setSentenceLoading(true);
    setSentenceError("");

    try {
      const content = await generateAiContent(store.aiConfig, "SENTENCE", normalized);
      store.putAiCache({
        key: `SENTENCE:${normalized}`,
        wordKey: null,
        queryContent: normalized,
        type: "SENTENCE",
        aiContent: content,
        modelName: store.aiConfig.modelName,
        createdAt: Date.now(),
      });
      setSentenceAnalysis(parseSentenceAnalysis(content));
    } catch (error) {
      setSentenceError(error instanceof Error ? error.message : "句子解析失败");
      setSentenceAnalysis(null);
    } finally {
      setSentenceLoading(false);
    }
  }

  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword || sentenceMode) return [];

    return allWords
      .filter((word) => {
        return (
          word.word.toLowerCase().includes(keyword) ||
          word.meaning.toLowerCase().includes(keyword)
        );
      })
      .sort((a, b) => a.word.localeCompare(b.word))
      .slice(0, 50);
  }, [allWords, query, sentenceMode]);

  const selectedWord = selectedWordKey ? store.wordsByKey[selectedWordKey] ?? null : null;

  function toggleSearchNewWord(wordKey: string): void {
    const latest = useAppStore.getState();
    if (latest.newWords.includes(wordKey)) {
      latest.removeFromNewWords(wordKey);
    } else {
      latest.addToNewWords(wordKey);
    }
  }

  useEffect(() => {
    if (!selectedWord) {
      setWordAiState({
        loading: false,
        content: "",
        error: "",
        translationLoading: false,
        translationContent: "",
        translationError: "",
      });
      return;
    }

    const cachedMemory = store.getAiCacheByWord(selectedWord.key, "MEMORY_AID");
    const cachedTranslation = store.getAiCacheByWord(selectedWord.key, "WORD_TRANSLATION");

    setWordAiState({
      loading: false,
      content: cachedMemory?.aiContent ?? "",
      error: "",
      translationLoading: false,
      translationContent: cachedTranslation?.aiContent ?? "",
      translationError: "",
    });

    if (!cachedTranslation?.aiContent && store.aiConfig.enabled) {
      void requestWordTranslation(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWord?.key]);

  async function requestWordAi(forceRefresh: boolean): Promise<void> {
    if (!selectedWord) return;

    const cache = store.getAiCacheByWord(selectedWord.key, "MEMORY_AID");
    if (!forceRefresh && cache?.aiContent) {
      setWordAiState((prev) => ({ ...prev, content: cache.aiContent }));
      return;
    }

    if (!store.aiConfig.enabled || !store.aiConfig.apiKey || !store.aiConfig.apiBaseUrl || !store.aiConfig.modelName) {
      setWordAiState((prev) => ({ ...prev, error: "请先在我的实验室启用并配置 API Key" }));
      return;
    }

    setWordAiState((prev) => ({ ...prev, loading: true, error: "" }));

    try {
      const content = await generateAiContent(store.aiConfig, "MEMORY_AID", selectedWord.word);
      store.putAiCache({
        key: `MEMORY_AID:${selectedWord.key}:${selectedWord.word}`,
        wordKey: selectedWord.key,
        queryContent: selectedWord.word,
        type: "MEMORY_AID",
        aiContent: content,
        modelName: store.aiConfig.modelName,
        createdAt: Date.now(),
      });
      setWordAiState((prev) => ({ ...prev, loading: false, content, error: "" }));
    } catch (error) {
      setWordAiState((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error.message : "AI 助记生成失败" }));
    }
  }

  async function requestWordTranslation(forceRefresh: boolean): Promise<void> {
    if (!selectedWord) return;

    const cache = store.getAiCacheByWord(selectedWord.key, "WORD_TRANSLATION");
    if (!forceRefresh && cache?.aiContent) {
      setWordAiState((prev) => ({ ...prev, translationContent: cache.aiContent }));
      return;
    }

    if (!store.aiConfig.enabled || !store.aiConfig.apiKey || !store.aiConfig.apiBaseUrl || !store.aiConfig.modelName) {
      setWordAiState((prev) => ({ ...prev, translationError: "请先在我的实验室启用并配置 API Key" }));
      return;
    }

    setWordAiState((prev) => ({ ...prev, translationLoading: true, translationError: "" }));

    try {
      const content = await generateAiContent(store.aiConfig, "WORD_TRANSLATION", selectedWord.word);
      store.putAiCache({
        key: `WORD_TRANSLATION:${selectedWord.key}:${selectedWord.word}`,
        wordKey: selectedWord.key,
        queryContent: selectedWord.word,
        type: "WORD_TRANSLATION",
        aiContent: content,
        modelName: store.aiConfig.modelName,
        createdAt: Date.now(),
      });
      setWordAiState((prev) => ({ ...prev, translationLoading: false, translationContent: content, translationError: "" }));
    } catch (error) {
      setWordAiState((prev) => ({ ...prev, translationLoading: false, translationError: error instanceof Error ? error.message : "翻译生成失败" }));
    }
  }

  return (
    <div className="page-wrap search-page">
      <div className="panel-card">
        <h3>查词 / 长句解析</h3>
        <div className="search-input-wrap">
          <Search size={20} aria-hidden="true" />
          <input
            className="text-input search-query-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索单词，或粘贴长难句（超过20字自动解析）"
          />
        </div>
      </div>

      {sentenceMode && (
        <div className="panel-card">
          <div className="section-head-inline">
            <strong>句子解析模式</strong>
            {sentenceAnalysis && <AIGeneratedBadge />}
          </div>
          <p className="muted">输入超过 20 个字符后会自动触发 AI 解析，不影响单词检索。</p>
          {sentenceLoading && <LoadingInline text="正在解析长难句..." />}
          {!sentenceLoading && sentenceError && <p className="error-text">{sentenceError}</p>}
          {!sentenceLoading && !sentenceError && sentenceAnalysis && (
            <>
              <div className="word-section muted-bg">
                <strong>句子主干</strong>
                <p>{sentenceAnalysis.mainClause}</p>
              </div>
              <div className="word-section muted-bg">
                <strong>语法成分标注</strong>
                <p>{sentenceAnalysis.grammarBreakdown}</p>
              </div>
              <div className="word-section muted-bg">
                <strong>AI 中文翻译</strong>
                <p>{sentenceAnalysis.chineseTranslation}</p>
              </div>
            </>
          )}
          <div className="inline-actions">
            <button type="button" className="outlined" onClick={() => void analyzeSentence(false)}>重试</button>
            <button type="button" className="outlined" onClick={() => void analyzeSentence(true)}>重新解析</button>
          </div>
          <p className="muted">内容由 AI 生成，请甄别参考。</p>
        </div>
      )}

      {!sentenceMode && query.trim() && results.length === 0 && <div className="panel-card"><p className="muted">没有匹配结果</p></div>}

      {!sentenceMode && results.length > 0 && (
        <div className="list-stack">
          {results.map((item) => {
            const inNewWords = store.newWords.includes(item.key);
            return (
              <button
                type="button"
                key={item.key}
                className="panel-card search-item"
                onClick={() => setSelectedWordKey(item.key)}
              >
                <div>
                  <strong>{item.word}</strong>
                  {item.phonetic && <p className="muted phonetic-text">{item.phonetic}</p>}
                </div>
                <div className="search-item-right">
                  <p className="ellipsis">{item.meaning || "无释义"}</p>
                  <AnimatedStarToggle
                    checked={inNewWords}
                    onToggle={() => toggleSearchNewWord(item.key)}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selectedWord && (
        <Dialog title={selectedWord.word} onClose={() => setSelectedWordKey(null)} variant="sheet">
          <div className={androidVisualMode ? "search-detail-sheet-android" : ""}>
            <div className="search-detail-head">
              <div>
                <h3>{selectedWord.word}</h3>
                {selectedWord.phonetic && <p className="phonetic-text">{selectedWord.phonetic}</p>}
              </div>
            </div>

            <div className="word-section muted-bg">
              <p>{selectedWord.meaning || "无释义"}</p>
            </div>
            {selectedWord.example && <p>{selectedWord.example}</p>}

            <div className={`split-columns ${androidVisualMode ? "search-detail-ai-columns-android" : ""}`.trim()}>
              <div className={`panel-card ${androidVisualMode ? "search-detail-ai-card-android" : ""}`.trim()}>
                <h4>AI 中文翻译</h4>
                {wordAiState.translationLoading && <LoadingInline text="正在生成中文翻译..." />}
                {wordAiState.translationError && <p className="error-text">{wordAiState.translationError}</p>}
                {wordAiState.translationContent && (
                  <div className="ai-result-card">
                    <div className="ai-result-head">
                      <strong>AI 中文翻译</strong>
                      <AIGeneratedBadge />
                    </div>
                    <pre>{wordAiState.translationContent}</pre>
                  </div>
                )}
                <button type="button" className="outlined" onClick={() => void requestWordTranslation(!!wordAiState.translationContent)}>
                  {wordAiState.translationContent ? "重新生成翻译" : "生成中文翻译"}
                </button>
              </div>

              <div className={`panel-card ${androidVisualMode ? "search-detail-ai-card-android" : ""}`.trim()}>
                <h4>AI 助记</h4>
                {wordAiState.loading && <LoadingInline text="正在生成助记..." />}
                {wordAiState.error && <p className="error-text">{wordAiState.error}</p>}
                {wordAiState.content && (
                  <div className="ai-result-card">
                    <div className="ai-result-head">
                      <strong>AI 助记</strong>
                      <AIGeneratedBadge />
                    </div>
                    <pre>{wordAiState.content}</pre>
                  </div>
                )}
                <button type="button" className="outlined" onClick={() => void requestWordAi(!!wordAiState.content)}>
                  {wordAiState.content ? "重新生成助记" : "生成 AI 助记"}
                </button>
              </div>
            </div>

            <div className="search-detail-bottom">
              <button
                type="button"
                className={`search-newword-action ${store.newWords.includes(selectedWord.key) ? "in-newwords" : ""}`}
                onClick={() => toggleSearchNewWord(selectedWord.key)}
              >
                {store.newWords.includes(selectedWord.key) ? "已在生词本" : "加入生词本"}
              </button>
              <AnimatedStarToggle
                checked={store.newWords.includes(selectedWord.key)}
                onToggle={() => toggleSearchNewWord(selectedWord.key)}
              />
            </div>

            <div className="search-detail-bottom-legacy">
              <button
                type="button"
                onClick={() => toggleSearchNewWord(selectedWord.key)}
              >
                {store.newWords.includes(selectedWord.key) ? "移出生词本" : "加入生词本"}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function BookTab({
  activeBook,
  onOpenBuildGuide,
  onOpenTodayPlan,
  onOpenSpelling,
}: {
  activeBook: ReturnType<typeof getActiveBook>;
  onOpenBuildGuide: () => void;
  onOpenTodayPlan: (bookId: number) => void;
  onOpenSpelling: () => void;
}) {
  const store = useAppStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const exportInputRef = useRef<HTMLInputElement | null>(null);

  const [importPreview, setImportPreview] = useState<{ drafts: WordDraft[]; displayName: string } | null>(null);
  const [importBookName, setImportBookName] = useState("");
  const [selectedBookId, setSelectedBookId] = useState<number | null>(null);
  const [earlyReviewBookId, setEarlyReviewBookId] = useState<number | null>(null);
  const [selectedEarlyReviewKeys, setSelectedEarlyReviewKeys] = useState<string[]>([]);
  const [pendingDeleteBookId, setPendingDeleteBookId] = useState<number | null>(null);
  const [showClearNewWordsDialog, setShowClearNewWordsDialog] = useState(false);

  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const bookCards = useMemo(() => {
    return store.books
      .map((book) => {
        const words = getWordListForBook(book, store.wordsByKey, store.bookWordKeys, store.newWords);
        const mastery = calculateMasteryDistribution(book, words, store.progressMap);
        const dueCount = computeDueCountByBook(book, words, store.progressMap);
        const earlyReviewCount = (store.earlyReviewMap[book.id] ?? []).length;

        const remaining = Math.max(0, mastery.total - mastery.learned);
        const daily = Math.max(1, store.settings.newWordsLimit);
        const estimatedFinishDays =
          book.type === BOOK_TYPE_NEW_WORDS
            ? null
            : remaining === 0
              ? 0
              : Math.ceil(remaining / daily);

        return {
          book,
          words,
          mastery,
          dueCount,
          earlyReviewCount,
          estimatedFinishDays,
        };
      })
      .sort((a, b) => {
        if (a.book.type === BOOK_TYPE_NEW_WORDS && b.book.type !== BOOK_TYPE_NEW_WORDS) return -1;
        if (a.book.type !== BOOK_TYPE_NEW_WORDS && b.book.type === BOOK_TYPE_NEW_WORDS) return 1;
        if (a.book.type !== b.book.type) return a.book.type - b.book.type;
        return a.book.id - b.book.id;
      });
  }, [store.books, store.wordsByKey, store.bookWordKeys, store.newWords, store.progressMap, store.earlyReviewMap, store.settings.newWordsLimit]);

  const selectedBook = selectedBookId ? bookCards.find((item) => item.book.id === selectedBookId) ?? null : null;
  const earlyReviewBook = earlyReviewBookId ? bookCards.find((item) => item.book.id === earlyReviewBookId) ?? null : null;
  const earlyReviewCandidates = useMemo(
    () => (earlyReviewBook ? earlyReviewBook.words.filter((word) => !!store.progressMap[word.key]) : []),
    [earlyReviewBook, store.progressMap],
  );
  const pendingDeleteBook = pendingDeleteBookId ? bookCards.find((item) => item.book.id === pendingDeleteBookId)?.book ?? null : null;
  const totalWords = useMemo(
    () => bookCards.reduce((sum, item) => sum + item.book.totalCount, 0),
    [bookCards],
  );

  function openImportPicker(): void {
    fileInputRef.current?.click();
  }

  async function onImportFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const text = await readTextFile(file);
      const drafts = parseWordFile(text);
      if (drafts.length === 0) {
        setToast("未解析到有效词条");
        return;
      }

      setImportPreview({
        drafts,
        displayName: file.name,
      });
      setImportBookName(file.name.replace(/\.[^.]+$/, "") || "导入词书");
    } catch {
      setToast("文件内容为空或无法读取");
    }
  }

  function confirmImportBook(): void {
    if (!importPreview) return;
    const result = store.importBook(importBookName, importPreview.drafts);
    setToast(result.message);
    if (result.ok) {
      setImportPreview(null);
      setImportBookName("");
    }
  }

  function exportBook(bookId: number): void {
    const card = bookCards.find((item) => item.book.id === bookId);
    if (!card) return;

    const lines = [
      "# Kaoyan Word Book Export",
      `# book_name: ${card.book.name}`,
      `# export_time: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}`,
      "# format: word<TAB>phonetic<TAB>meaning<TAB>example",
      ...card.words.map((word) =>
        [word.word, word.phonetic, word.meaning, word.example]
          .map((item) => item.replace(/[\t\r\n]+/g, " ").trim())
          .join("\t"),
      ),
    ];

    downloadTextFile(
      `${card.book.name.replace(/[\\/:*?"<>|\s]+/g, "_")}_${dayjs().format("YYYYMMDD")}.txt`,
      lines.join("\n"),
      "text/plain;charset=utf-8",
    );

    setToast(`导出完成：${card.words.length} 条词条`);
  }

  function confirmDeleteBook(): void {
    if (!pendingDeleteBook) return;
    const result = store.deleteBook(pendingDeleteBook.id);
    setToast(result.message);
    setPendingDeleteBookId(null);
  }

  function openEarlyReview(bookId: number): void {
    setEarlyReviewBookId(bookId);
    const existing = store.earlyReviewMap[bookId] ?? [];
    setSelectedEarlyReviewKeys(existing.filter((key) => !!store.progressMap[key]));
  }

  function confirmEarlyReviewSelection(): void {
    if (!earlyReviewBookId) return;
    store.replaceEarlyReviewWords(earlyReviewBookId, selectedEarlyReviewKeys);
    setToast(`已设置提前复习 ${selectedEarlyReviewKeys.length} 词`);
    setEarlyReviewBookId(null);
  }

  function toggleEarlyReview(wordKey: string): void {
    setSelectedEarlyReviewKeys((prev) => {
      if (prev.includes(wordKey)) {
        return prev.filter((item) => item !== wordKey);
      }
      return [...prev, wordKey];
    });
  }

  return (
    <div className="page-wrap books-page">
      <header className="page-topbar">
        <h2>我的词库</h2>
        <div className="inline-actions">
          <button type="button" className="text-link-button" onClick={onOpenBuildGuide}>教程</button>
          <button type="button" className="text-link-button" onClick={openImportPicker}>导入</button>
        </div>
      </header>

      <div className="panel-card books-summary-card">
        <p className="books-summary-title">当前词书：{activeBook?.name ?? "-"}</p>
        <p className="muted">词书 {store.books.length} 本 · 累计词条 {totalWords}</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.csv,.json,text/plain,text/csv,application/json"
        style={{ display: "none" }}
        onChange={(event) => void onImportFile(event)}
      />
      <input ref={exportInputRef} type="file" style={{ display: "none" }} />

      <div className="list-stack">
        {bookCards.map((item) => {
          const masteryRate = item.mastery.total > 0 ? Math.round((item.mastery.mastered * 100) / item.mastery.total) : 0;
          return (
            <div key={item.book.id} className="panel-card book-item-card">
              <div className="book-item-row">
                <button
                  type="button"
                  className="book-item-main-button"
                  onClick={() => setSelectedBookId(item.book.id)}
                >
                  <div className="book-item-icon">
                    {item.book.type === BOOK_TYPE_NEW_WORDS ? <Star size={24} fill="currentColor" /> : <Search size={24} />}
                  </div>
                  <div className="book-item-main">
                    <h4>{item.book.name}</h4>
                    <p className="muted">
                      {item.book.type === BOOK_TYPE_NEW_WORDS
                        ? `已收录 ${item.mastery.total}`
                        : `已学习 ${item.mastery.learned}/${item.mastery.total}`}
                    </p>
                    <p className="muted">
                      已掌握率 {masteryRate}% · 待复习 {item.dueCount} · 提前复习 {item.earlyReviewCount} · 预计学完 {item.estimatedFinishDays === null ? "-" : item.estimatedFinishDays === 0 ? "今天" : `${item.estimatedFinishDays}天`}
                    </p>
                  </div>
                </button>
                <div className="book-item-actions">
                  {item.book.isActive ? (
                    <>
                      <span className="chip">使用中</span>
                      {item.book.type !== BOOK_TYPE_NEW_WORDS && (
                        <button type="button" className="text-link-button" onClick={() => openEarlyReview(item.book.id)}>提前复习</button>
                      )}
                      <button type="button" className="text-link-button" onClick={onOpenSpelling}>拼写测试</button>
                    </>
                  ) : (
                    <button type="button" className="outlined small" onClick={() => store.switchBook(item.book.id)}>切换</button>
                  )}
                  <button type="button" className="text-link-button" onClick={() => exportBook(item.book.id)}>导出</button>
                  {item.book.type === BOOK_TYPE_NEW_WORDS ? (
                    <button type="button" className="text-link-button" onClick={() => {
                      setShowClearNewWordsDialog(true);
                    }}>清空</button>
                  ) : (
                    <button type="button" className="text-link-button" onClick={() => setPendingDeleteBookId(item.book.id)}>删除</button>
                  )}
                </div>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${item.mastery.total > 0 ? (item.mastery.learned / item.mastery.total) * 100 : 0}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      <button type="button" className="book-floating-import" onClick={openImportPicker} aria-label="导入词书">+</button>

      {importPreview && (
        <Dialog title="预览词书" onClose={() => setImportPreview(null)}>
          <div className="field-row">
            <label>词书名称</label>
            <input className="text-input" value={importBookName} onChange={(event) => setImportBookName(event.target.value)} />
          </div>
          <p>共 {importPreview.drafts.length} 条，预览前 {Math.min(5, importPreview.drafts.length)} 条：</p>
          <div className="preview-list">
            {importPreview.drafts.slice(0, 5).map((draft) => (
              <p key={`${draft.word}-${draft.meaning}`}>{draft.word} {draft.phonetic} {draft.meaning}</p>
            ))}
          </div>
          <div className="dialog-actions between">
            <button type="button" className="outlined" onClick={() => setImportPreview(null)}>取消</button>
            <button type="button" onClick={confirmImportBook}>确认导入</button>
          </div>
        </Dialog>
      )}

      {pendingDeleteBook && (
        <Dialog title="删除词书" onClose={() => setPendingDeleteBookId(null)} showCloseButton={false}>
          <p>确认删除 {pendingDeleteBook.name} 吗？此操作不可恢复。</p>
          <div className="dialog-actions between">
            <button type="button" className="outlined" onClick={() => setPendingDeleteBookId(null)}>取消</button>
            <button type="button" onClick={confirmDeleteBook}>删除</button>
          </div>
        </Dialog>
      )}

      {showClearNewWordsDialog && (
        <Dialog
          title="清空生词本"
          onClose={() => setShowClearNewWordsDialog(false)}
          showCloseButton={false}
          variant="confirm"
          overlayTone="dark"
        >
          <p>确认清空生词本内容吗？</p>
          <div className="dialog-actions between">
            <button type="button" className="text-action-button" onClick={() => setShowClearNewWordsDialog(false)}>取消</button>
            <button
              type="button"
              className="text-action-button primary"
              onClick={() => {
                store.clearNewWords();
                setShowClearNewWordsDialog(false);
                setToast("已清空生词本");
              }}
            >
              清空
            </button>
          </div>
        </Dialog>
      )}

      {selectedBook && (
        <Dialog title={selectedBook.book.name} onClose={() => setSelectedBookId(null)} variant="sheet" showCloseButton={false}>
          <h3>{selectedBook.book.name}</h3>
          <p>共 {selectedBook.mastery.total} 词</p>
          <p className="muted">
            预计学完：{selectedBook.estimatedFinishDays === null ? "-" : selectedBook.estimatedFinishDays === 0 ? "今天" : `${selectedBook.estimatedFinishDays} 天`}
          </p>

          <div className="stat-grid three">
            <div>
              <small>已学习</small>
              <strong>{selectedBook.mastery.learned}</strong>
            </div>
            <div>
              <small>已掌握</small>
              <strong>{selectedBook.mastery.mastered}</strong>
            </div>
            <div>
              <small>待复习</small>
              <strong>{selectedBook.dueCount}</strong>
            </div>
          </div>

          {selectedBook.book.type !== BOOK_TYPE_NEW_WORDS && (
            <p className="muted">提前复习队列：{selectedBook.earlyReviewCount} 词</p>
          )}

          {selectedBook.book.type !== BOOK_TYPE_NEW_WORDS && store.settings.plannedNewWordsEnabled && (
            <button type="button" className="text-link-button" onClick={() => {
              setSelectedBookId(null);
              onOpenTodayPlan(selectedBook.book.id);
            }}>今日新词（自主选择）</button>
          )}
          {selectedBook.book.type !== BOOK_TYPE_NEW_WORDS && (
            <button type="button" className="text-link-button" onClick={() => {
              setSelectedBookId(null);
              openEarlyReview(selectedBook.book.id);
            }}>提前复习（批量选择）</button>
          )}
          <button type="button" className="text-link-button" onClick={() => exportBook(selectedBook.book.id)}>导出词书</button>

          {selectedBook.mastery.total > 0 ? (
            <>
              <MasteryDonutChart mastery={selectedBook.mastery} height={220} />
              <MasteryLegend />
              <p className="muted">已掌握 {selectedBook.mastery.mastered}/{selectedBook.mastery.total}</p>
            </>
          ) : (
            <p className="muted">暂无词书数据</p>
          )}
        </Dialog>
      )}

      {earlyReviewBook && (
        <Dialog
          title={`${earlyReviewBook.book.name} · 提前复习`}
          onClose={() => setEarlyReviewBookId(null)}
          variant="sheet"
          showCloseButton={false}
        >
          <h3>{earlyReviewBook.book.name} · 提前复习</h3>
          <p className="muted">批量选择已学习词条，加入本轮提前复习（不影响每日新学词数设置）。</p>
          <p>已选择 {selectedEarlyReviewKeys.length} 词</p>
          <div className="inline-actions">
            <button type="button" className="text-link-button" onClick={() => setSelectedEarlyReviewKeys(earlyReviewCandidates.map((word) => word.key))}>全选</button>
            <button type="button" className="text-link-button" onClick={() => setSelectedEarlyReviewKeys([])}>清空</button>
            <button type="button" className="text-link-button" onClick={confirmEarlyReviewSelection}>确认</button>
          </div>

          <div className="list-stack max-half">
            {earlyReviewCandidates
              .map((word) => {
                const progress = store.progressMap[word.key] ?? null;
                const selected = selectedEarlyReviewKeys.includes(word.key);
                return (
                  <button
                    type="button"
                    className={`panel-card early-review-item ${selected ? "selected" : ""}`}
                    key={word.key}
                    onClick={() => toggleEarlyReview(word.key)}
                  >
                    <input type="checkbox" checked={selected} readOnly aria-label={`选择 ${word.word}`} />
                    <div className="early-review-item-content">
                      <strong>{word.word}</strong>
                      {word.phonetic && <p className="muted phonetic-text">{word.phonetic}</p>}
                      <p className="muted">{word.meaning || "无释义"}</p>
                      <p className="muted">{computeProgressStatusLabel(progress)} · 下次复习：{formatReviewDay(progress?.nextReviewTime ?? 0)}</p>
                    </div>
                  </button>
                );
              })}
          </div>
        </Dialog>
      )}

      {toast && <div className="snackbar"><span>{toast}</span></div>}
    </div>
  );
}

function ProfileTab({
  onOpenStats,
  onOpenAiLab,
}: {
  onOpenStats: () => void;
  onOpenAiLab: () => void;
}) {
  const store = useAppStore();
  const [newWordsInput, setNewWordsInput] = useState(String(store.settings.newWordsLimit));
  const [pendingRestoreContent, setPendingRestoreContent] = useState<string | null>(null);

  const stats = useMemo(() => {
    const today = dayjs();
    const weekStart = today.subtract(6, "day").startOf("day");

    const weekDates = Array.from({ length: 7 }, (_, index) => weekStart.add(index, "day").format("YYYY-MM-DD"));

    const weekStats = weekDates.map((date) => store.dailyStatsMap[date]).filter(Boolean) as DailyStats[];
    const todayStats = store.dailyStatsMap[today.format("YYYY-MM-DD")];

    const weekStudyCount = weekStats.reduce(
      (sum, item) => sum + item.newWordsCount + item.reviewWordsCount + item.spellPracticeCount,
      0,
    );
    const weekSpellCount = weekStats.reduce((sum, item) => sum + item.spellPracticeCount, 0);

    const studyDays = Object.keys(store.dailyStatsMap)
      .filter((date) => {
        const item = store.dailyStatsMap[date];
        return item && item.newWordsCount + item.reviewWordsCount + item.spellPracticeCount > 0;
      })
      .map((date) => dayjs(date).format("YYYY-MM-DD"));

    let streakDays = 0;
    let cursor = today.startOf("day");
    while (studyDays.includes(cursor.format("YYYY-MM-DD"))) {
      streakDays += 1;
      cursor = cursor.subtract(1, "day");
    }

    const lineData = weekDates.map((date) => {
      const value = store.dailyStatsMap[date];
      return {
        date,
        newCount: value?.newWordsCount ?? 0,
        reviewCount: value?.reviewWordsCount ?? 0,
      };
    });

    const heatmapEnd = today.endOf("week");
    const heatmapStart = today.subtract(11, "week").startOf("week").add(1, "day");
    const heatmapMaxCount = Math.max(
      1,
      ...Object.values(store.dailyStatsMap).map((item) => item.newWordsCount + item.reviewWordsCount + item.spellPracticeCount),
    );

    const heatmapCells: Array<{ date: string; count: number; level: number; inRange: boolean }> = [];
    let cursorDate = heatmapStart;
    while (!cursorDate.isAfter(heatmapEnd, "day")) {
      const dateKey = cursorDate.format("YYYY-MM-DD");
      const inRange = !cursorDate.isAfter(today, "day");
      const value = inRange ? store.dailyStatsMap[dateKey] : undefined;
      const count = value ? value.newWordsCount + value.reviewWordsCount + value.spellPracticeCount : 0;
      const ratio = count / heatmapMaxCount;
      const level =
        count <= 0
          ? 0
          : ratio <= 0.25
            ? 1
            : ratio <= 0.5
              ? 2
              : ratio <= 0.75
                ? 3
                : 4;

      heatmapCells.push({
        date: dateKey,
        count,
        level,
        inRange,
      });
      cursorDate = cursorDate.add(1, "day");
    }

    return {
      streakDays,
      weekStudyCount,
      todayStudyCount:
        (todayStats?.newWordsCount ?? 0) +
        (todayStats?.reviewWordsCount ?? 0) +
        (todayStats?.spellPracticeCount ?? 0),
      weekSpellCount,
      todaySpellCount: todayStats?.spellPracticeCount ?? 0,
      lineData,
      heatmapCells,
    };
  }, [store.dailyStatsMap]);

  const aiSummary = useMemo(() => {
    const hasApiKey = !!store.aiConfig.apiKey.trim();
    if (!hasApiKey) return "未配置 API Key";
    if (!store.aiConfig.enabled) return "已配置未启用";

    const provider = inferProviderName(store.aiConfig.apiBaseUrl);
    if (provider === "自定义") return "已启用";
    return `${provider} 已启用`;
  }, [store.aiConfig]);

  function saveSettingsFromInput(): void {
    const value = Number(newWordsInput);
    if (!Number.isFinite(value)) return;
    const clamped = Math.max(1, Math.min(500, Math.round(value)));
    store.setSettings({ newWordsLimit: clamped });
    setNewWordsInput(String(clamped));
  }

  function exportBackup(): void {
    const text = store.exportBackup();
    downloadTextFile(`kaoyan_words_backup_${dayjs().format("YYYYMMDD")}.json`, text, "application/json");
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await readTextFile(file);
    setPendingRestoreContent(text);
  }

  function confirmRestoreBackup(): void {
    if (!pendingRestoreContent) return;
    const result = store.importBackup(pendingRestoreContent);
    setPendingRestoreContent(null);
    alert(result.message);
  }

  return (
    <div className="page-wrap profile-page">
      <h2 className="page-title">我的</h2>
      <div className="panel-card">
        <h3>学习统计</h3>
        <div className="stat-grid three profile-stat-grid">
          <div>
            <small>连续打卡</small>
            <strong>{stats.streakDays}天</strong>
          </div>
          <div>
            <small>近7天学习</small>
            <strong>{stats.weekStudyCount}次</strong>
          </div>
          <div>
            <small>今日学习</small>
            <strong>{stats.todayStudyCount}次</strong>
          </div>
        </div>
        <div className="stat-grid two profile-stat-grid">
          <div>
            <small>近7天拼写</small>
            <strong>{stats.weekSpellCount}次</strong>
          </div>
          <div>
            <small>今日拼写</small>
            <strong>{stats.todaySpellCount}次</strong>
          </div>
        </div>
        <h4>过去一周趋势</h4>
        <MemoryLineChart data={stats.lineData} showLegend={false} height={180} />
        <h4>日历热力图</h4>
        {stats.heatmapCells.length === 0 ? (
          <p className="muted">暂无学习记录</p>
        ) : (
          <>
            <HeatmapGrid cells={stats.heatmapCells} />
            <HeatmapLegend />
          </>
        )}
        <div className="inline-actions right">
          <button type="button" className="outlined" onClick={onOpenStats}>查看学习数据</button>
        </div>
      </div>

      <div className="panel-card">
        <h3>数据管理</h3>
        <p className="muted">备份可导出文件，恢复将覆盖当前数据。</p>
        <div className="inline-actions">
          <button type="button" className="outlined" onClick={exportBackup}><Download size={14} /> 数据备份</button>
          <label className="button outlined file-button">
            <FileUp size={14} /> 数据恢复
            <input type="file" accept="application/json,.json" onChange={(event) => void importBackup(event)} />
          </label>
        </div>
      </div>

      <div className="panel-card">
        <h3>学习设置</h3>
        <div className="field-row">
          <label>每日新学词数</label>
          <div className="field-inline">
            <input
              className="text-input"
              value={newWordsInput}
              onChange={(event) => setNewWordsInput(event.target.value.replace(/\D/g, "").slice(0, 3))}
            />
            <button type="button" className="outlined" onClick={saveSettingsFromInput}>保存</button>
          </div>
        </div>
        <p className="muted">待复习单词会自动加入学习队列，不计入每日新学词数。</p>

        <div className="field-row">
          <label>字号</label>
          <div className="chip-row">
            {[0.9, 1.0, 1.1].map((value) => (
              <button
                type="button"
                key={value}
                className={store.settings.fontScale === value ? "active" : ""}
                onClick={() => store.setSettings({ fontScale: value })}
              >
                {value === 0.9 ? "小" : value === 1 ? "标准" : "大"}
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <label>深色模式</label>
          <div className="chip-row">
            {[
              { value: 0, label: "跟随系统" },
              { value: 1, label: "浅色" },
              { value: 2, label: "深色" },
            ].map((item) => (
              <button
                type="button"
                key={item.value}
                className={store.settings.darkMode === item.value ? "active" : ""}
                onClick={() => store.setSettings({ darkMode: item.value as 0 | 1 | 2 })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <label>规划单词</label>
          <div className="chip-row">
            <button
              type="button"
              className={!store.settings.plannedNewWordsEnabled ? "active" : ""}
              onClick={() => store.setSettings({ plannedNewWordsEnabled: false })}
            >关闭</button>
            <button
              type="button"
              className={store.settings.plannedNewWordsEnabled ? "active" : ""}
              onClick={() => store.setSettings({ plannedNewWordsEnabled: true })}
            >开启</button>
          </div>
        </div>
        <p className="muted">开启后将停止自动推送新词，仅按今日新词自主选择中的规划进行学习。</p>
      </div>

      <div className="panel-card">
        <h3>实验室</h3>
        <p className="muted">AI：{aiSummary}</p>
        <p className="muted">包含 AI 实验室、发音实验室、算法实验室。</p>
        <button type="button" className="outlined" onClick={onOpenAiLab}>进入实验室</button>
      </div>

      <div className="panel-card">
        <h3>关于软件</h3>
        <p><strong>敏捷英语</strong></p>
        <p className="muted">版本 1.2 网页版</p>
        <p className="muted">完全离线运行，无广告干扰。</p>
      </div>

      {pendingRestoreContent && (
        <Dialog title="恢复数据" onClose={() => setPendingRestoreContent(null)} showCloseButton={false}>
          <p>恢复会覆盖当前数据，建议先备份。确认继续？</p>
          <div className="dialog-actions between">
            <button type="button" className="outlined" onClick={() => setPendingRestoreContent(null)}>取消</button>
            <button type="button" onClick={confirmRestoreBackup}>继续</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function AILabPage({ onBack }: { onBack: () => void }) {
  const store = useAppStore();
  const androidVisualMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("androidVisual") === "1";
  const [workingConfig, setWorkingConfig] = useState(store.aiConfig);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showCostHintDialog, setShowCostHintDialog] = useState(false);
  const [showPrivacyDialog, setShowPrivacyDialog] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    setWorkingConfig(store.aiConfig);
  }, [store.aiConfig]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function onTestConnection(): Promise<void> {
    setIsTesting(true);
    try {
      await testAiConnection(workingConfig);
      setToast("连接成功");
    } catch (error) {
      setToast(`连接失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setIsTesting(false);
    }
  }

  function onSaveConfig(): void {
    setIsSaving(true);
    store.setAiConfig(workingConfig);
    setTimeout(() => {
      setIsSaving(false);
      setToast("AI 配置已保存");
    }, 300);
  }

  const presetButtons = androidVisualMode
    ? providerPresets.filter((preset) => ["OpenAI", "DeepSeek", "智谱AI"].includes(preset.name))
    : providerPresets;

  return (
    <div className={`page-wrap full-page ${androidVisualMode ? "ai-lab-android" : ""}`.trim()}>
      <header className="top-header">
        <button type="button" className="icon-button" onClick={onBack} aria-label="返回">
          <ArrowLeft size={16} />
          {!androidVisualMode && " 返回"}
        </button>
        <h3>实验室</h3>
      </header>

      <div className={`panel-card ${androidVisualMode ? "android-lab-card" : ""}`.trim()}>
        <div className="switch-row">
          <div>
            <strong>启用 AI 增强</strong>
            <p className="muted">关闭后学习页和查词页的 AI 入口会隐藏</p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={workingConfig.enabled}
              onChange={(event) => setWorkingConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span />
          </label>
        </div>
      </div>

      <div className={`panel-card ${androidVisualMode ? "android-lab-card" : ""}`.trim()}>
        <h4>服务商预设</h4>
        <div className={`chip-row wrap ${androidVisualMode ? "android-lab-chip-row" : ""}`.trim()}>
          {presetButtons.map((preset) => (
            <button
              type="button"
              key={preset.name}
              className={inferProviderName(workingConfig.apiBaseUrl) === preset.name ? "active" : ""}
              onClick={() => setWorkingConfig((prev) => ({ ...prev, apiBaseUrl: preset.baseUrl }))}
            >
              {preset.name}
            </button>
          ))}
          {!androidVisualMode && (
            <button type="button" className={inferProviderName(workingConfig.apiBaseUrl) === "自定义" ? "active" : ""}>自定义</button>
          )}
        </div>
        {androidVisualMode ? (
          <label className="android-lab-field">
            <span>Base URL</span>
            <input
              className="text-input"
              value={workingConfig.apiBaseUrl}
              onChange={(event) => setWorkingConfig((prev) => ({ ...prev, apiBaseUrl: event.target.value }))}
            />
          </label>
        ) : (
          <div className="field-row">
            <label>Base URL</label>
            <input
              className="text-input"
              value={workingConfig.apiBaseUrl}
              onChange={(event) => setWorkingConfig((prev) => ({ ...prev, apiBaseUrl: event.target.value }))}
            />
          </div>
        )}
      </div>

      <div className={`panel-card ${androidVisualMode ? "android-lab-card" : ""}`.trim()}>
        <h4>模型与密钥</h4>
        {androidVisualMode ? (
          <>
            <label className="android-lab-field">
              <span>模型名称</span>
              <input
                className="text-input"
                value={workingConfig.modelName}
                onChange={(event) => setWorkingConfig((prev) => ({ ...prev, modelName: event.target.value }))}
                placeholder="如 glm-4-flash / gpt-3.5-turbo"
              />
            </label>
            <label className="android-lab-field">
              <span>API Key</span>
              <div className="android-lab-key-row">
                <input
                  className="text-input"
                  type={showApiKey ? "text" : "password"}
                  value={workingConfig.apiKey}
                  onChange={(event) => setWorkingConfig((prev) => ({ ...prev, apiKey: event.target.value }))}
                />
                <button
                  type="button"
                  className="android-lab-eye-button"
                  onClick={() => setShowApiKey((prev) => !prev)}
                  aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {showApiKey ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
            </label>
          </>
        ) : (
          <>
            <div className="field-row">
              <label>模型名称</label>
              <input
                className="text-input"
                value={workingConfig.modelName}
                onChange={(event) => setWorkingConfig((prev) => ({ ...prev, modelName: event.target.value }))}
                placeholder="如 glm-4-flash / gpt-3.5-turbo"
              />
            </div>
            <div className="field-row">
              <label>API Key</label>
              <div className="field-inline">
                <input
                  className="text-input"
                  type={showApiKey ? "text" : "password"}
                  value={workingConfig.apiKey}
                  onChange={(event) => setWorkingConfig((prev) => ({ ...prev, apiKey: event.target.value }))}
                />
                <button type="button" className="outlined" onClick={() => setShowApiKey((prev) => !prev)}>
                  {showApiKey ? "隐藏" : "显示"}
                </button>
              </div>
            </div>
          </>
        )}
        <div className={`inline-actions ${androidVisualMode ? "android-lab-actions" : ""}`.trim()}>
          <button type="button" className="outlined" disabled={isSaving || isTesting} onClick={() => void onTestConnection()}>
            {isTesting ? "测试中..." : "测试连接"}
          </button>
          <button type="button" disabled={isSaving || isTesting} onClick={onSaveConfig}>
            {isSaving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </div>

      {androidVisualMode && (
        <div className="panel-card ai-lab-android-extra">
          <div className="inline-actions">
            <button type="button" className="outlined" onClick={() => setShowCostHintDialog(true)}>查看成本提示</button>
            <button type="button" className="outlined" onClick={() => setShowPrivacyDialog(true)}>查看隐私说明</button>
          </div>
        </div>
      )}

      {!androidVisualMode && (
        <div className="panel-card">
          <h4>使用说明</h4>
          <p className="muted">1. AI 请求消耗你自己的服务商额度，请注意成本。</p>
          <p className="muted">2. API Key 仅保存在本机加密存储，不经过开发者服务器。</p>
          <p className="muted">3. Root 设备存在额外密钥泄露风险，请谨慎使用。</p>
          <div className="inline-actions">
            <button type="button" className="outlined" onClick={() => setShowCostHintDialog(true)}>查看成本提示</button>
            <button type="button" className="outlined" onClick={() => setShowPrivacyDialog(true)}>查看隐私说明</button>
          </div>
          <p className="muted">AI 生成内容仅供学习参考，请结合教材自行甄别。</p>
        </div>
      )}

      {!androidVisualMode && (
        <div className="panel-card">
          <h4>发音实验室</h4>
          <div className="switch-row">
            <div>
              <strong>启用发音</strong>
              <p className="muted">关闭后学习页和查词详情中的发音按钮会隐藏</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={store.settings.pronunciationEnabled}
                onChange={(event) => store.setSettings({ pronunciationEnabled: event.target.checked })}
              />
              <span />
            </label>
          </div>

          <div className="field-row">
            <label>发音来源</label>
            <div className="chip-row">
              <button
                type="button"
                className={store.settings.pronunciationSource === 0 ? "active" : ""}
                onClick={() => store.setSettings({ pronunciationSource: 0 })}
                disabled={!store.settings.pronunciationEnabled}
              >
                Free Dictionary
              </button>
              <button
                type="button"
                className={store.settings.pronunciationSource === 1 ? "active" : ""}
                onClick={() => store.setSettings({ pronunciationSource: 1 })}
                disabled={!store.settings.pronunciationEnabled}
              >
                Youdao
              </button>
            </div>
          </div>

          <div className="switch-row">
            <div>
              <strong>认词自动发音</strong>
              <p className="muted">认词模式每次切到新单词时自动播放发音</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={store.settings.recognitionAutoPronounceEnabled}
                onChange={(event) => store.setSettings({ recognitionAutoPronounceEnabled: event.target.checked })}
                disabled={!store.settings.pronunciationEnabled}
              />
              <span />
            </label>
          </div>
        </div>
      )}

      {!androidVisualMode && (
        <div className="panel-card">
          <h4>算法实验室</h4>
          <div className="switch-row">
            <div>
              <strong>算法版本</strong>
              <p className="muted">{store.settings.algorithmV4Enabled ? "当前版本：V4 验证" : "当前版本：V3 稳定"}</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={store.settings.algorithmV4Enabled}
                onChange={(event) => store.setSettings({ algorithmV4Enabled: event.target.checked })}
              />
              <span />
            </label>
          </div>

          <div className="switch-row">
            <div>
              <strong>ML 自适应学习</strong>
              <p className="muted">{store.settings.mlAdaptiveEnabled ? "已开启：按个人遗忘风险动态微调复习间隔" : "已关闭：仅使用基础调度策略"}</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={store.settings.mlAdaptiveEnabled}
                onChange={(event) => store.setSettings({ mlAdaptiveEnabled: event.target.checked })}
              />
              <span />
            </label>
          </div>

          <p className="muted">当前训练样本：{store.trainingSamples.length}</p>

          <div className="switch-row">
            <div>
              <strong>新词打乱记忆</strong>
              <p className="muted">{store.settings.newWordsShuffleEnabled ? "已开启：新词会按随机顺序穿插学习" : "已关闭：新词按原始顺序加入学习队列"}</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={store.settings.newWordsShuffleEnabled}
                onChange={(event) => store.setSettings({ newWordsShuffleEnabled: event.target.checked })}
              />
              <span />
            </label>
          </div>

          <h5>算法说明书</h5>
          <p className="muted">1. 时间单位：V3 与 V4 均以天为记忆间隔单位，刷新时间点为次日 04:00。</p>
          <p className="muted">2. 认词评分：不认识 AGAIN，模糊 HARD，认识 GOOD。</p>
          <p className="muted">3. V3 核心：满足间隔≥21天、复习次数≥2、Ease≥2.3 判定已掌握。</p>
          <p className="muted">4. V4 核心：间隔贴近艾宾浩斯阶梯，短时复习触发衰减保护。</p>
        </div>
      )}

      {toast && <div className="snackbar"><span>{toast}</span></div>}

      {showCostHintDialog && (
        <Dialog title="AI 成本提示" onClose={() => setShowCostHintDialog(false)} showCloseButton={false}>
          <p>AI 请求消耗你自备服务商的额度。建议优先使用缓存内容，避免频繁点击重新生成。</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setShowCostHintDialog(false)}>知道了</button>
          </div>
        </Dialog>
      )}

      {showPrivacyDialog && (
        <Dialog title="隐私与风险说明" onClose={() => setShowPrivacyDialog(false)} showCloseButton={false}>
          <p>API Key 仅用于向你配置的服务商发起请求，密钥保存在浏览器本地存储中，不会上传至开发者服务器。Root 设备仍存在额外泄露风险。</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setShowPrivacyDialog(false)}>知道了</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function StatsPage({ onBack }: { onBack: () => void }) {
  type ForecastRow = ReturnType<typeof calculateNext7DaysPressure>[number] & { dateLabel: string };
  const store = useAppStore();
  const [range, setRange] = useState<"WEEK" | "MONTH">("WEEK");
  const [calendarMode, setCalendarMode] = useState<"HISTORY" | "FUTURE">("HISTORY");
  const [selectedForecastDate, setSelectedForecastDate] = useState<string>("");
  const [forecastWords, setForecastWords] = useState<Array<{ word: string; meaning: string }>>([]);
  const [forecastRows, setForecastRows] = useState<ForecastRow[]>([]);
  const [forecastLoadLabel, setForecastLoadLabel] = useState("预测来源：实时计算 · 耗时 0ms");
  const forecastCacheRef = useRef<{
    signature: string;
    rows: ForecastRow[];
  } | null>(null);

  const activeBook = getActiveBook(store.books, store.activeBookId);

  const sourceWords = useMemo(() => {
    if (!activeBook) return [];
    return getWordListForBook(activeBook, store.wordsByKey, store.bookWordKeys, store.newWords);
  }, [activeBook, store.wordsByKey, store.bookWordKeys, store.newWords]);

  const lineData = useMemo(() => {
    const days = range === "WEEK" ? 7 : 30;
    const startDate = dayjs().subtract(days - 1, "day");
    return Array.from({ length: days }, (_, index) => {
      const date = startDate.add(index, "day").format("YYYY-MM-DD");
      const dayStats = store.dailyStatsMap[date];
      return {
        date,
        newCount: dayStats?.newWordsCount ?? 0,
        reviewCount: dayStats?.reviewWordsCount ?? 0,
      };
    });
  }, [range, store.dailyStatsMap]);

  const mastery = useMemo(() => {
    if (!activeBook) return { unlearned: 0, learning: 0, mastered: 0, total: 0 };
    return calculateMasteryDistribution(activeBook, sourceWords, store.progressMap);
  }, [activeBook, sourceWords, store.progressMap]);

  const heatmapCells = useMemo(() => {
    const end = dayjs();
    const start = end.subtract(11, "week").startOf("week").add(1, "day");
    const days = end.endOf("week");
    const maxCount = Math.max(
      1,
      ...Object.values(store.dailyStatsMap).map((item) => item.newWordsCount + item.reviewWordsCount + item.spellPracticeCount),
    );

    const cells: Array<{ date: string; count: number; level: number; inRange: boolean }> = [];
    let cursor = start;
    while (!cursor.isAfter(days, "day")) {
      const key = cursor.format("YYYY-MM-DD");
      const inRange = !cursor.isAfter(end, "day");
      const item = inRange ? store.dailyStatsMap[key] : undefined;
      const count = item ? item.newWordsCount + item.reviewWordsCount + item.spellPracticeCount : 0;
      const ratio = count / maxCount;
      const level =
        count <= 0
          ? 0
          : ratio <= 0.25
            ? 1
            : ratio <= 0.5
              ? 2
              : ratio <= 0.75
                ? 3
                : 4;

      cells.push({
        date: key,
        count,
        level,
        inRange,
      });

      cursor = cursor.add(1, "day");
    }

    return cells;
  }, [store.dailyStatsMap]);

  const rangeStats = useMemo(() => {
    const days = range === "WEEK" ? 7 : 30;
    const startDate = dayjs().subtract(days - 1, "day");
    const keys = Array.from({ length: days }, (_, index) => startDate.add(index, "day").format("YYYY-MM-DD"));
    return keys.reduce(
      (acc, key) => {
        const value = store.dailyStatsMap[key];
        if (!value) return acc;
        return {
          gestureEasyCount: acc.gestureEasyCount + value.gestureEasyCount,
          gestureNotebookCount: acc.gestureNotebookCount + value.gestureNotebookCount,
        };
      },
      { gestureEasyCount: 0, gestureNotebookCount: 0 },
    );
  }, [range, store.dailyStatsMap]);

  const todayRecognition = useMemo(() => {
    const today = store.dailyStatsMap[dayjs().format("YYYY-MM-DD")];
    return {
      fuzzy: today?.fuzzyWordsCount ?? 0,
      recognized: today?.recognizedWordsCount ?? 0,
    };
  }, [store.dailyStatsMap]);

  useEffect(() => {
    const startedAt = performance.now();
    const reviewTimes = Object.values(store.progressMap)
      .filter((progress) => progress.status !== PROGRESS_STATUS_MASTERED && progress.nextReviewTime > 0)
      .map((progress) => progress.nextReviewTime)
      .sort((a, b) => a - b);

    const dailyLimit = Math.max(0, store.settings.newWordsLimit);
    const learningDate = currentLearningDate();
    const todayLearned = store.dailyStatsMap[learningDate]?.newWordsCount ?? 0;
    const todayRemaining = Math.max(0, dailyLimit - todayLearned);

    const signature = `${dailyLimit}|${todayRemaining}|${reviewTimes.join(",")}`;
    const cached = forecastCacheRef.current;

    let sourceLabel = "实时计算";
    let rows: ForecastRow[];

    if (cached && cached.signature === signature) {
      sourceLabel = "缓存命中";
      rows = cached.rows;
    } else {
      rows = calculateNext7DaysPressure(reviewTimes, Date.now(), dailyLimit, todayRemaining).map((item) => ({
        ...item,
        dateLabel: dayjs(item.date).format("YYYY-MM-DD"),
      }));
      forecastCacheRef.current = {
        signature,
        rows,
      };
    }

    const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
    setForecastRows(rows);
    setForecastLoadLabel(`预测来源：${sourceLabel} · 耗时 ${elapsed}ms`);
  }, [store.progressMap, store.settings.newWordsLimit, store.dailyStatsMap]);
  const forecast = forecastRows;

  useEffect(() => {
    if (forecast.length === 0) {
      setSelectedForecastDate("");
      setForecastWords([]);
      return;
    }

    const fallback = forecast.find((item) => dayjs(item.date).isSame(dayjs(), "day"))?.dateLabel ?? forecast[0].dateLabel;

    setSelectedForecastDate((prev) => {
      if (prev && forecast.some((item) => item.dateLabel === prev)) return prev;
      return fallback;
    });
  }, [forecast]);

  useEffect(() => {
    if (!selectedForecastDate) return;
    const selectedDate = dayjs(selectedForecastDate);
    const preview = Object.entries(store.progressMap)
      .filter(([_, progress]) => {
        if (progress.status === PROGRESS_STATUS_MASTERED || progress.nextReviewTime <= 0) return false;
        return dayjs(progress.nextReviewTime).isSame(selectedDate, "day");
      })
      .slice(0, 5)
      .map(([wordKey]) => {
        const word = store.wordsByKey[wordKey];
        return {
          word: word?.word ?? wordKey,
          meaning: word?.meaning || "无释义",
        };
      });

    setForecastWords(preview);
  }, [selectedForecastDate, store.progressMap, store.wordsByKey]);

  const mlConfidence = useMemo(() => {
    const sampleCount = store.trainingSamples.length;
    if (sampleCount < 50) {
      return (sampleCount / 50) * 0.3;
    }
    if (sampleCount < 200) {
      return 0.3 + ((sampleCount - 50) / 150) * 0.5;
    }
    return Math.min(1, 0.8 + (sampleCount - 200) / 1000);
  }, [store.trainingSamples.length]);

  const mlHeatmap = useMemo(() => {
    if (store.trainingSamples.length === 0) {
      return Array.from({ length: 7 * 24 }, (_, index) => ({
        dayOfWeek: Math.floor(index / 24),
        hour: index % 24,
        efficiency: Math.max(0.05, Math.min(0.99, store.mlModel.userBaseRetention)),
      }));
    }

    const matrix: Array<Array<{ total: number; remembered: number }>> = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ total: 0, remembered: 0 })),
    );

    store.trainingSamples.slice(0, 500).forEach((sample) => {
      const day = Math.max(0, Math.min(6, Math.round((sample.features[2] ?? 0) * 6)));
      const hour = Math.max(0, Math.min(23, Math.round((sample.features[1] ?? 0) * 23)));
      matrix[day][hour].total += 1;
      if (sample.outcome === 0) {
        matrix[day][hour].remembered += 1;
      }
    });

    return Array.from({ length: 7 * 24 }, (_, index) => {
      const day = Math.floor(index / 24);
      const hour = index % 24;
      const cell = matrix[day][hour];
      const efficiency = cell.total > 0 ? cell.remembered / cell.total : store.mlModel.userBaseRetention;
      return { dayOfWeek: day, hour, efficiency };
    });
  }, [store.trainingSamples, store.mlModel.userBaseRetention]);

  const selectedForecast = forecast.find((item) => item.dateLabel === selectedForecastDate);

  function pullForwardReviews(): void {
    if (!selectedForecastDate) return;
    const targetDate = dayjs(selectedForecastDate);
    if (!targetDate.isAfter(dayjs(), "day")) return;

    const dueWords = Object.entries(store.progressMap)
      .filter(([_, progress]) => {
        if (progress.status === PROGRESS_STATUS_MASTERED || progress.nextReviewTime <= 0) return false;
        return dayjs(progress.nextReviewTime).isSame(targetDate, "day");
      })
      .slice(0, 5);

    dueWords.forEach(([wordKey, progress]) => {
      store.setProgress(wordKey, { ...progress, nextReviewTime: Date.now() });
    });

    alert(dueWords.length > 0 ? `已提前消化 ${dueWords.length} 个复习任务` : "没有可前移的复习任务");
  }

  const dayLabels = {
    LOW: "低压",
    MEDIUM: "中压",
    HIGH: "高压",
  } as const;

  return (
    <div className="page-wrap full-page">
      <header className="top-header">
        <button type="button" className="icon-button" onClick={onBack}><ArrowLeft size={16} /> 返回</button>
        <h3>学习数据</h3>
      </header>

      <div className="panel-card">
        <h3>学习日历</h3>
        <div className="chip-row">
          <button type="button" className={calendarMode === "HISTORY" ? "active" : ""} onClick={() => setCalendarMode("HISTORY")}>历史模式</button>
          <button type="button" className={calendarMode === "FUTURE" ? "active" : ""} onClick={() => setCalendarMode("FUTURE")}>未来模式</button>
        </div>

        <p className="muted">手势统计：左滑太简单 {rangeStats.gestureEasyCount} · 右滑生词本 {rangeStats.gestureNotebookCount}</p>
        <p className="muted">今日认词：模糊 {todayRecognition.fuzzy} · 认识 {todayRecognition.recognized}</p>

        {calendarMode === "HISTORY" ? (
          <>
            <p className="muted">过去 12 周学习热力图</p>
            {heatmapCells.length === 0 ? <p className="muted">暂无学习记录</p> : <HeatmapGrid cells={heatmapCells} />}
            <HeatmapLegend />
          </>
        ) : (
          <>
            <p className="muted">未来 7 天复习压力</p>
            <p className="muted">{forecastLoadLabel}</p>
            {forecast.length === 0 ? (
              <p className="muted">暂无预测数据</p>
            ) : (
              <>
                <div className="forecast-chart">
                  {forecast.map((day) => {
                    const maxTotal = Math.max(1, ...forecast.map((item) => item.totalCount));
                    const height = Math.max(12, (day.totalCount / maxTotal) * 120);
                    const selected = day.dateLabel === selectedForecastDate;
                    return (
                      <button
                        type="button"
                        key={day.dateLabel}
                        className={`forecast-bar ${selected ? "selected" : ""}`}
                        onClick={() => setSelectedForecastDate(day.dateLabel)}
                        title={`${day.dateLabel} ${dayLabels[day.pressureLevel]} 总计${day.totalCount}`}
                      >
                        <span className="forecast-value">{day.totalCount}</span>
                        <span
                          className={`forecast-column ${day.pressureLevel.toLowerCase()}`}
                          style={{ height }}
                        />
                        <span className="forecast-date">{chartDateLabel(day.dateLabel)}</span>
                        <span className="forecast-level">{dayLabels[day.pressureLevel]}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="legend-row">
                  <span><Flame size={12} /> 低压&lt;50</span>
                  <span><CircleHelp size={12} /> 中压50-100</span>
                  <span><CalendarClock size={12} /> 高压&gt;100</span>
                </div>
                {selectedForecast && (
                  <>
                    <h4>任务详情：{dayjs(selectedForecast.date).format("MM月DD日")}</h4>
                    <p className="muted">复习 {selectedForecast.reviewCount} · 新词 {selectedForecast.newWordQuota} · 总计 {selectedForecast.totalCount}</p>
                    <p className="muted">压力等级：{dayLabels[selectedForecast.pressureLevel]}</p>
                    {selectedForecast.pressureLevel === "HIGH" && (
                      <p className="error-text">高压预警：建议提前消化或分散复习压力。</p>
                    )}
                    {forecastWords.length === 0 ? (
                      <p className="muted">当日暂无可预览任务</p>
                    ) : (
                      <ul className="simple-list">
                        {forecastWords.map((item) => (
                          <li key={`${item.word}-${item.meaning}`}>{item.word} {item.meaning}</li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      className="outlined"
                      onClick={pullForwardReviews}
                      disabled={!dayjs(selectedForecast.date).isAfter(dayjs(), "day") || selectedForecast.reviewCount <= 0}
                    >
                      提前消化 5 个
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>

      <div className="panel-card">
        <div className="chip-row">
          <button type="button" className={range === "WEEK" ? "active" : ""} onClick={() => setRange("WEEK")}>近7天</button>
          <button type="button" className={range === "MONTH" ? "active" : ""} onClick={() => setRange("MONTH")}>近30天</button>
        </div>
      </div>

      <div className="panel-card">
        <h3>记忆曲线</h3>
        <p className="muted">{range === "WEEK" ? "近7天" : "近30天"}</p>
        <MemoryLineChart data={lineData} showLegend={false} height={220} />
      </div>

      <div className="panel-card">
        <h3>掌握度分布</h3>
        <p className="muted">当前词书统计</p>
        <div className="stat-grid three">
          <div><small>未学</small><strong>{mastery.unlearned}</strong></div>
          <div><small>学习中</small><strong>{mastery.learning}</strong></div>
          <div><small>已掌握</small><strong>{mastery.mastered}</strong></div>
        </div>
        {mastery.total <= 0 ? (
          <p className="muted">暂无词书数据</p>
        ) : (
          <>
            <MasteryDonutChart mastery={mastery} height={220} />
            <MasteryLegend />
            <p className="muted">共 {mastery.total} 词</p>
          </>
        )}
      </div>

      {store.settings.mlAdaptiveEnabled && (
        <>
          <MemoryStabilityCard
            stabilityIndex={store.mlModel.userBaseRetention}
            confidence={mlConfidence}
            optimalHourStart={9}
            optimalHourEnd={11}
            sampleCount={store.trainingSamples.length}
          />
          <MemoryHeatmapCard data={mlHeatmap} />
        </>
      )}
    </div>
  );
}

function BuildGuidePage({ onBack }: { onBack: () => void }) {
  return (
    <div className="page-wrap full-page">
      <header className="top-header">
        <button type="button" className="icon-button" onClick={onBack}><ArrowLeft size={16} /> 返回</button>
        <h3>词书构建教程</h3>
      </header>

      <div className="panel-card">
        <h4>1. 文件格式</h4>
        <p className="muted">支持 txt csv 文本文件，推荐 UTF-8 编码。</p>
        <p className="muted">每行一条词条，推荐用 Tab 分隔：</p>
        <pre>word&lt;TAB&gt;phonetic&lt;TAB&gt;meaning&lt;TAB&gt;example</pre>
        <p className="muted">也支持逗号、竖线、分号等分隔符。</p>
      </div>

      <div className="panel-card">
        <h4>2. 最小可用内容</h4>
        <p className="muted">最少只写单词：abandon</p>
        <p className="muted">推荐至少写到 单词 + 释义：</p>
        <pre>abandon&lt;TAB&gt;vt. 放弃；抛弃</pre>
        <p className="muted">带音标与例句会有更完整的学习体验。</p>
      </div>

      <div className="panel-card">
        <h4>3. 示例模板</h4>
        <pre>{`abandon\t[əˈbændən]\tvt. 放弃；抛弃\tHe abandoned the plan.
allocate\t[ˈæləkeɪt]\tvt. 分配\tThe team allocated resources fairly.
in terms of\t\t在……方面\tIn terms of speed, this is better.`}</pre>
      </div>

      <div className="panel-card">
        <h4>4. 导入前检查</h4>
        <p className="muted">词书名称是否明确。</p>
        <p className="muted">是否存在空行和重复词条。</p>
        <p className="muted">释义是否简洁一致，避免过长段落。</p>
        <p className="muted">导入后可先用导出词书做回读校验。</p>
      </div>

      <div className="panel-card">
        <h4>5. 推荐流程</h4>
        <p className="muted">先用 50-100 条做小规模试导入。</p>
        <p className="muted">确认展示、拼写模式、搜索结果正常。</p>
        <p className="muted">再批量扩展到完整词书。</p>
        <p className="muted">定期导出做版本备份。</p>
      </div>
    </div>
  );
}

function TodayPlanPage({
  initialBookId,
  onBack,
}: {
  initialBookId: number | null;
  onBack: () => void;
}) {
  const store = useAppStore();
  const [selectedBookId, setSelectedBookId] = useState<number | null>(initialBookId ?? null);
  const [query, setQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [toast, setToast] = useState("");

  const books = useMemo(() => {
    return store.books.filter((book) => book.type !== BOOK_TYPE_NEW_WORDS).sort((a, b) => a.id - b.id);
  }, [store.books]);

  useEffect(() => {
    if (!selectedBookId && books.length > 0) {
      setSelectedBookId(initialBookId && books.some((book) => book.id === initialBookId) ? initialBookId : books[0].id);
    }
  }, [books, selectedBookId, initialBookId]);

  useEffect(() => {
    if (!selectedBookId) {
      setSelectedKeys([]);
      return;
    }

    const learningDate = currentLearningDate();
    if (store.todayPlan.learningDate === learningDate && store.todayPlan.bookId === selectedBookId) {
      setSelectedKeys(store.todayPlan.wordKeys);
    } else {
      setSelectedKeys([]);
    }
  }, [selectedBookId, store.todayPlan]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const candidates = useMemo(() => {
    if (!selectedBookId) return [];
    const book = store.books.find((item) => item.id === selectedBookId);
    if (!book) return [];

    const words = getWordListForBook(book, store.wordsByKey, store.bookWordKeys, store.newWords);
    const unlearned = words.filter((word) => !store.progressMap[word.key]);

    const keyword = query.trim().toLowerCase();
    if (!keyword) return unlearned;

    return unlearned.filter((word) => {
      return (
        word.word.toLowerCase().includes(keyword) ||
        word.meaning.toLowerCase().includes(keyword)
      );
    });
  }, [selectedBookId, store.books, store.wordsByKey, store.bookWordKeys, store.newWords, store.progressMap, query]);

  const dailyLimit = store.settings.newWordsLimit;

  function toggleWord(wordKey: string): void {
    setSelectedKeys((prev) => {
      if (prev.includes(wordKey)) return prev.filter((item) => item !== wordKey);
      return [...prev, wordKey];
    });
  }

  function randomSelect(): void {
    const pool = [...candidates];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const index = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[index]] = [pool[index], pool[i]];
    }
    setSelectedKeys(pool.slice(0, Math.min(dailyLimit, pool.length)).map((item) => item.key));
  }

  function savePlanAndSwitchBook(): void {
    if (!selectedBookId) return;

    if (selectedKeys.length === 0) {
      store.clearTodayPlan();
      setToast("已清空今日新词计划");
    } else {
      store.saveTodayPlan(selectedBookId, selectedKeys);
      setToast(`已设置 ${currentLearningDate()} 今日新词 ${selectedKeys.length} 个`);
    }

    store.switchBook(selectedBookId);
    onBack();
  }

  return (
    <div className="page-wrap full-page">
      <header className="top-header">
        <button type="button" className="icon-button" onClick={onBack}><ArrowLeft size={16} /> 返回</button>
        <h3>今日新词选择</h3>
      </header>

      <div className="panel-card">
        <div className="chip-row wrap">
          {books.map((book) => (
            <button
              type="button"
              key={book.id}
              className={selectedBookId === book.id ? "active" : ""}
              onClick={() => setSelectedBookId(book.id)}
            >
              {book.name}{store.activeBookId === book.id ? "（当前）" : ""}
            </button>
          ))}
        </div>

        <p className="muted">已选 {selectedKeys.length} 词 · 每日新学上限 {dailyLimit}</p>

        <input
          className="text-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索词条"
        />

        <div className="inline-actions">
          <button type="button" className="outlined" onClick={randomSelect}>随机选取</button>
          <button type="button" className="outlined" onClick={() => setSelectedKeys([])}>清空选择</button>
          <button type="button" className="text-link-button strong" onClick={savePlanAndSwitchBook}>确认使用</button>
        </div>
      </div>

      <div className="list-stack">
        {candidates.length === 0 && <div className="panel-card"><p className="muted">当前词书暂无可选新词，可能已全部学过。</p></div>}
        {candidates.map((word) => {
          const selected = selectedKeys.includes(word.key);
          return (
            <button
              type="button"
              key={word.key}
              className={`panel-card selectable-item ${selected ? "selected" : ""}`}
              onClick={() => toggleWord(word.key)}
            >
              <input type="checkbox" checked={selected} readOnly aria-label={`选择 ${word.word}`} />
              <div className="selectable-item-content">
                <strong>{word.word}</strong>
                {word.phonetic && <p className="muted phonetic-text">{word.phonetic}</p>}
                <p className="muted">{word.meaning || "无释义"}</p>
              </div>
            </button>
          );
        })}
      </div>

      {toast && <div className="snackbar"><span>{toast}</span></div>}
    </div>
  );
}

function Dialog({
  title,
  onClose,
  children,
  full = false,
  showCloseButton = true,
  variant = "default",
  overlayTone = "default",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  full?: boolean;
  showCloseButton?: boolean;
  variant?: "default" | "confirm" | "sheet";
  overlayTone?: "default" | "dark";
}) {
  const hideSheetCloseButton =
    variant === "sheet" &&
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("android-visual-mode");

  return (
    <div
      className={`dialog-backdrop ${variant} ${overlayTone}`}
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={`dialog-card ${full ? "full" : ""} ${variant}`}>
        {variant === "sheet" ? (
          <div className="dialog-head sheet">
            <span className="sheet-grip" aria-hidden="true" />
            {showCloseButton && !hideSheetCloseButton && (
              <button type="button" className="icon-button" onClick={onClose}>关闭</button>
            )}
          </div>
        ) : (
          <div className={`dialog-head ${showCloseButton ? "" : "no-close"} ${variant}`}>
            <h3>{title}</h3>
            {showCloseButton && (
              <button type="button" className="icon-button" onClick={onClose}>关闭</button>
            )}
          </div>
        )}
        <div className={`dialog-content ${variant}`}>{children}</div>
      </div>
    </div>
  );
}

export default App;
