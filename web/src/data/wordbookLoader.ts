import {
  BOOK_TYPE_NEW_WORDS,
  BOOK_TYPE_PRESET,
} from "../types";
import type { Book, PresetWordbookMeta, Word, WordbookEntryRaw, WordbookPayloadRaw } from "../types";

export interface WordbookPronunciation {
  ukSpeech: string;
  usSpeech: string;
}

export interface BuiltinWordbookData {
  books: Book[];
  wordsByKey: Record<string, Word>;
  bookWordKeys: Record<number, string[]>;
  pronunciationIndex: Record<string, WordbookPronunciation>;
  failedBookIds: number[];
  loadWarnings: string[];
}

const builtinSources: Array<PresetWordbookMeta & { bookId: number }> = [
  {
    fileName: "wordbook_full_from_e2c.json",
    bookName: "完整词库",
    bookId: 1,
  },
  {
    fileName: "wordbook_full.json",
    bookName: "完整词库（精选）",
    bookId: 2,
  },
];

const normalizeWordKey = (rawWord: string): string => rawWord.trim().toLowerCase();
const WORDBOOK_REQUEST_TIMEOUT_MS = 45_000;
const WORDBOOK_REQUEST_RETRY = 1;

const buildMeaning = (entry: WordbookEntryRaw, phrases: string, synonyms: string, relWords: string): string => {
  const translations = (entry.translations ?? [])
    .map((item) => {
      const text = (item.tran_cn ?? "").trim();
      if (!text) return "";
      const pos = (item.pos ?? "").trim();
      return pos ? `${pos}. ${text}` : text;
    })
    .filter(Boolean);

  if (translations.length > 0) return translations.join("；");
  if (phrases) return phrases;
  if (synonyms) return synonyms;
  return relWords;
};

const buildPhrases = (entry: WordbookEntryRaw): string =>
  (entry.phrases ?? [])
    .map((item) => {
      const content = (item.p_content ?? "").trim();
      const cn = (item.p_cn ?? "").trim();
      if (!content) return "";
      return cn ? `${content}（${cn}）` : content;
    })
    .filter(Boolean)
    .slice(0, 3)
    .join("；");

const buildSynonyms = (entry: WordbookEntryRaw): string =>
  (entry.synonyms ?? [])
    .map((group) => {
      const words = (group.Hwds ?? [])
        .map((wordItem) => (wordItem.word ?? "").trim())
        .filter(Boolean);
      if (words.length === 0) return "";

      const pos = (group.pos ?? "").trim();
      const tran = (group.tran ?? "").trim();
      const wordsText = words.join(", ");

      if (!pos && !tran) return wordsText;
      if (!pos) return `${wordsText}（${tran}）`;
      if (!tran) return `${pos}: ${wordsText}`;
      return `${pos}: ${wordsText}（${tran}）`;
    })
    .filter(Boolean)
    .slice(0, 3)
    .join("；");

const buildRelWords = (entry: WordbookEntryRaw): string =>
  (entry.relWords ?? [])
    .map((group) => {
      const words = (group.Hwds ?? [])
        .map((item) => {
          const word = (item.hwd ?? "").trim();
          const tran = (item.tran ?? "").trim();
          if (!word) return "";
          return tran ? `${word}（${tran}）` : word;
        })
        .filter(Boolean);

      if (words.length === 0) return "";

      const pos = (group.Pos ?? "").trim();
      if (!pos) return words.join(", ");
      return `${pos}: ${words.join(", ")}`;
    })
    .filter(Boolean)
    .slice(0, 3)
    .join("；");

const buildExample = (entry: WordbookEntryRaw): string => {
  const sentence = (entry.sentences ?? [])[0];
  if (!sentence) return "";
  const en = (sentence.s_content ?? "").trim();
  const cn = (sentence.s_cn ?? "").trim();
  if (!en && !cn) return "";
  if (!en) return cn;
  if (!cn) return en;
  return `${en}\n${cn}`;
};

const parseWordEntry = (entry: WordbookEntryRaw): Omit<Word, "id"> | null => {
  const rawWord = (entry.word ?? "").trim();
  if (!rawWord) return null;

  const key = normalizeWordKey(rawWord);
  const phoneticRaw = ((entry.ukphone ?? "").trim() || (entry.usphone ?? "").trim()).trim();
  const phonetic = phoneticRaw ? `[${phoneticRaw}]` : "";
  const phrases = buildPhrases(entry);
  const synonyms = buildSynonyms(entry);
  const relWords = buildRelWords(entry);
  const meaning = buildMeaning(entry, phrases, synonyms, relWords);
  const example = buildExample(entry);

  return {
    key,
    word: rawWord,
    phonetic,
    meaning,
    example,
    phrases,
    synonyms,
    relWords,
  };
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

const toErrorMessage = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "下载超时";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "未知错误";
};

const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
};

const readPayloadOnce = async (fileName: string): Promise<WordbookPayloadRaw> => {
  const response = await fetchWithTimeout(`/${fileName}`, WORDBOOK_REQUEST_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`词库文件读取失败：${fileName}`);
  }
  return (await response.json()) as WordbookPayloadRaw;
};

const readPayload = async (fileName: string): Promise<WordbookPayloadRaw> => {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= WORDBOOK_REQUEST_RETRY; attempt += 1) {
    try {
      return await readPayloadOnce(fileName);
    } catch (error) {
      lastError = error;
      if (attempt < WORDBOOK_REQUEST_RETRY) {
        await delay(350 * (attempt + 1));
      }
    }
  }

  throw new Error(`词库文件读取失败：${fileName}，${toErrorMessage(lastError)}`);
};

export const loadBuiltinWordbooks = async (): Promise<BuiltinWordbookData> => {
  const wordsByKey: Record<string, Word> = {};
  const bookWordKeys: Record<number, string[]> = {};
  const pronunciationIndex: Record<string, WordbookPronunciation> = {};
  const failedBookIds: number[] = [];
  const loadWarnings: string[] = [];

  let nextWordId = 1;
  const books: Book[] = [];
  let loadedPresetCount = 0;

  const payloadResults = await Promise.allSettled(
    builtinSources.map((source) => readPayload(source.fileName)),
  );

  for (let sourceIndex = 0; sourceIndex < builtinSources.length; sourceIndex += 1) {
    const source = builtinSources[sourceIndex];
    const payloadResult = payloadResults[sourceIndex];
    if (payloadResult.status === "rejected") {
      failedBookIds.push(source.bookId);
      loadWarnings.push(`${source.bookName}加载失败：${toErrorMessage(payloadResult.reason)}`);
      bookWordKeys[source.bookId] = [];
      books.push({
        id: source.bookId,
        name: source.bookName,
        type: BOOK_TYPE_PRESET,
        totalCount: 0,
        isActive: sourceIndex === 0,
      });
      continue;
    }

    loadedPresetCount += 1;
    const entries = payloadResult.value.data ?? [];

    const draftKeys: string[] = [];
    const seenInBook = new Set<string>();

    entries.forEach((rawEntry) => {
      const parsed = parseWordEntry(rawEntry);
      if (!parsed) return;
      if (seenInBook.has(parsed.key)) return;

      seenInBook.add(parsed.key);
      draftKeys.push(parsed.key);

      if (!wordsByKey[parsed.key]) {
        wordsByKey[parsed.key] = {
          id: nextWordId,
          key: parsed.key,
          word: parsed.word,
          phonetic: parsed.phonetic,
          meaning: parsed.meaning,
          example: parsed.example,
          phrases: parsed.phrases,
          synonyms: parsed.synonyms,
          relWords: parsed.relWords,
        };
        nextWordId += 1;
      } else {
        const existing = wordsByKey[parsed.key];
        if (!existing.phonetic && parsed.phonetic) existing.phonetic = parsed.phonetic;
        if (!existing.meaning && parsed.meaning) existing.meaning = parsed.meaning;
        if (!existing.example && parsed.example) existing.example = parsed.example;
        if (!existing.phrases && parsed.phrases) existing.phrases = parsed.phrases;
        if (!existing.synonyms && parsed.synonyms) existing.synonyms = parsed.synonyms;
        if (!existing.relWords && parsed.relWords) existing.relWords = parsed.relWords;
      }

      const ukSpeech = (rawEntry.ukspeech ?? "").trim();
      const usSpeech = (rawEntry.usspeech ?? "").trim();
      const existingPron = pronunciationIndex[parsed.key];
      if (!existingPron) {
        pronunciationIndex[parsed.key] = { ukSpeech, usSpeech };
      } else {
        pronunciationIndex[parsed.key] = {
          ukSpeech: existingPron.ukSpeech || ukSpeech,
          usSpeech: existingPron.usSpeech || usSpeech,
        };
      }
    });

    bookWordKeys[source.bookId] = draftKeys;

    books.push({
      id: source.bookId,
      name: source.bookName,
      type: BOOK_TYPE_PRESET,
      totalCount: draftKeys.length,
      isActive: sourceIndex === 0,
    });
  }

  const newWordsBookId = 3;
  books.push({
    id: newWordsBookId,
    name: "生词本",
    type: BOOK_TYPE_NEW_WORDS,
    totalCount: 0,
    isActive: false,
  });
  bookWordKeys[newWordsBookId] = [];

  if (loadedPresetCount === 0) {
    throw new Error("词库初始化失败，请检查网络后刷新重试");
  }

  if (loadWarnings.length > 0) {
    console.warn("[wordbookLoader] 部分词库加载失败", loadWarnings);
  }

  return {
    books,
    wordsByKey,
    bookWordKeys,
    pronunciationIndex,
    failedBookIds,
    loadWarnings,
  };
};

export const BUILTIN_BOOK_IDS = {
  full: 1,
  curated: 2,
  newWords: 3,
};
