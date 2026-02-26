export const BOOK_TYPE_PRESET = 0;
export const BOOK_TYPE_IMPORTED = 1;
export const BOOK_TYPE_NEW_WORDS = 2;

export type BookType =
  | typeof BOOK_TYPE_PRESET
  | typeof BOOK_TYPE_IMPORTED
  | typeof BOOK_TYPE_NEW_WORDS;

export interface Book {
  id: number;
  name: string;
  type: BookType;
  totalCount: number;
  isActive: boolean;
}

export interface Word {
  id: number;
  key: string;
  word: string;
  phonetic: string;
  meaning: string;
  example: string;
  phrases: string;
  synonyms: string;
  relWords: string;
}

export interface WordDraft {
  word: string;
  phonetic: string;
  meaning: string;
  example: string;
  phrases: string;
  synonyms: string;
  relWords: string;
}

export interface WordbookTranslationRaw {
  pos?: string;
  tran_cn?: string;
}

export interface WordbookPhraseRaw {
  p_content?: string;
  p_cn?: string;
}

export interface WordbookSentenceRaw {
  s_content?: string;
  s_cn?: string;
}

export interface WordbookSynonymWordRaw {
  word?: string;
}

export interface WordbookSynonymGroupRaw {
  pos?: string;
  tran?: string;
  Hwds?: WordbookSynonymWordRaw[];
}

export interface WordbookRelWordRaw {
  hwd?: string;
  tran?: string;
}

export interface WordbookRelWordGroupRaw {
  Pos?: string;
  Hwds?: WordbookRelWordRaw[];
}

export interface WordbookEntryRaw {
  word: string;
  ukphone?: string;
  usphone?: string;
  ukspeech?: string;
  usspeech?: string;
  translations?: WordbookTranslationRaw[];
  phrases?: WordbookPhraseRaw[];
  sentences?: WordbookSentenceRaw[];
  synonyms?: WordbookSynonymGroupRaw[];
  relWords?: WordbookRelWordGroupRaw[];
}

export interface WordbookPayloadRaw {
  code?: number;
  msg?: string;
  data?: WordbookEntryRaw[];
}

export const PROGRESS_STATUS_NEW = 0;
export const PROGRESS_STATUS_LEARNING = 1;
export const PROGRESS_STATUS_MASTERED = 2;

export type ProgressStatus =
  | typeof PROGRESS_STATUS_NEW
  | typeof PROGRESS_STATUS_LEARNING
  | typeof PROGRESS_STATUS_MASTERED;

export interface Progress {
  wordKey: string;
  status: ProgressStatus;
  repetitions: number;
  intervalDays: number;
  nextReviewTime: number;
  easeFactor: number;
  reviewCount: number;
  spellCorrectCount: number;
  spellWrongCount: number;
  markedEasyCount: number;
  lastEasyTime: number;
  consecutiveCorrect: number;
  avgResponseTimeMs: number;
  lastReviewTime: number;
}

export const STUDY_RATING_AGAIN = 0;
export const STUDY_RATING_HARD = 3;
export const STUDY_RATING_GOOD = 5;

export type StudyRating =
  | typeof STUDY_RATING_AGAIN
  | typeof STUDY_RATING_HARD
  | typeof STUDY_RATING_GOOD;

export const SPELLING_OUTCOME_FAILED = 0;
export const SPELLING_OUTCOME_RETRY_SUCCESS = 3;
export const SPELLING_OUTCOME_HINTED = 4;
export const SPELLING_OUTCOME_PERFECT = 5;

export type SpellingOutcome =
  | typeof SPELLING_OUTCOME_FAILED
  | typeof SPELLING_OUTCOME_RETRY_SUCCESS
  | typeof SPELLING_OUTCOME_HINTED
  | typeof SPELLING_OUTCOME_PERFECT;

export const PRONUNCIATION_SOURCE_FREE_DICTIONARY = 0;
export const PRONUNCIATION_SOURCE_YOUDAO = 1;

export type PronunciationSource =
  | typeof PRONUNCIATION_SOURCE_FREE_DICTIONARY
  | typeof PRONUNCIATION_SOURCE_YOUDAO;

export interface UserSettings {
  newWordsLimit: number;
  fontScale: number;
  darkMode: 0 | 1 | 2;
  reviewPressureReliefEnabled: boolean;
  reviewPressureDailyCap: number;
  swipeGestureGuideShown: boolean;
  algorithmV4Enabled: boolean;
  pronunciationEnabled: boolean;
  pronunciationSource: PronunciationSource;
  recognitionAutoPronounceEnabled: boolean;
  newWordsShuffleEnabled: boolean;
  mlAdaptiveEnabled: boolean;
  plannedNewWordsEnabled: boolean;
}

export interface TodayNewWordsPlan {
  learningDate: string;
  bookId: number | null;
  wordKeys: string[];
}

export interface StudyLog {
  date: string;
  count: number;
  updateTime: number;
}

export interface DailyStats {
  date: string;
  newWordsCount: number;
  reviewWordsCount: number;
  spellPracticeCount: number;
  durationMillis: number;
  gestureEasyCount: number;
  gestureNotebookCount: number;
  fuzzyWordsCount: number;
  recognizedWordsCount: number;
}

export interface AICacheEntry {
  key: string;
  wordKey: string | null;
  queryContent: string;
  type: AIContentType;
  aiContent: string;
  modelName: string;
  createdAt: number;
}

export type AIContentType = "EXAMPLE" | "MEMORY_AID" | "SENTENCE" | "WORD_TRANSLATION";

export interface AIConfig {
  enabled: boolean;
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
}

export interface AIProviderPreset {
  name: string;
  baseUrl: string;
}

export interface SearchSentenceAnalysis {
  mainClause: string;
  grammarBreakdown: string;
  chineseTranslation: string;
}

export interface HeatmapCell {
  date: string;
  count: number;
  level: number;
  inRange: boolean;
}

export type CalendarMode = "HISTORY" | "FUTURE";
export type StatsRange = "WEEK" | "MONTH";

export type PressureLevel = "LOW" | "MEDIUM" | "HIGH";

export interface DayForecast {
  date: number;
  reviewCount: number;
  newWordQuota: number;
  totalCount: number;
  pressureLevel: PressureLevel;
}

export interface LineChartEntry {
  date: string;
  newCount: number;
  reviewCount: number;
}

export interface MasteryDistribution {
  unlearned: number;
  learning: number;
  mastered: number;
  total: number;
}

export interface LearningAiState {
  isEnabled: boolean;
  isConfigured: boolean;
  isLoading: boolean;
  activeType: AIContentType | null;
  content: string;
  error: string | null;
}

export interface ForecastWordPreview {
  word: string;
  meaning: string;
}

export interface TrainingSample {
  id: number;
  wordKey: string;
  features: number[];
  outcome: number;
  timestamp: number;
  predictionError: number;
}

export interface MlModelSnapshot {
  sampleCount: number;
  userBaseRetention: number;
  avgResponseTime: number;
  stdResponseTime: number;
}

export interface PresetWordbookMeta {
  fileName: string;
  bookName: string;
}
