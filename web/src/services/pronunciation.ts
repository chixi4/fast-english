import {
  PRONUNCIATION_SOURCE_FREE_DICTIONARY,
  PRONUNCIATION_SOURCE_YOUDAO,
} from "../types";
import type { PronunciationSource } from "../types";
import type { WordbookPronunciation } from "../data/wordbookLoader";

interface FreeDictionaryEntry {
  phonetics?: Array<{
    audio?: string;
  }>;
}

const buildYoudaoAudioUrl = (word: string): string => {
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
};

const resolveAudioUrl = (rawAudio: string): string => {
  if (rawAudio.startsWith("//")) {
    return `https:${rawAudio}`;
  }
  return rawAudio;
};

const mapErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return "发音查询失败";
  if (/404/.test(error.message)) return "Free Dictionary 未收录该单词发音";
  if (/timeout|network/i.test(error.message)) return "发音查询超时，请重试";
  if (/Failed to fetch/i.test(error.message)) return "发音服务连接失败";
  return error.message;
};

const lookupFromFreeDictionary = async (word: string): Promise<string> => {
  const endpoint = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }

  const entries = (await response.json()) as FreeDictionaryEntry[];
  const audio = entries
    .flatMap((entry) => entry.phonetics ?? [])
    .map((item) => (item.audio ?? "").trim())
    .find(Boolean);

  if (!audio) {
    throw new Error("not_found");
  }

  return resolveAudioUrl(audio);
};

export const getPronunciationAudioUrl = async (
  word: string,
  preferredSource: PronunciationSource,
  pronunciationIndex: Record<string, WordbookPronunciation>,
): Promise<string> => {
  const normalizedWord = word.trim().toLowerCase();
  if (!normalizedWord) {
    throw new Error("单词不能为空");
  }

  const builtInAudio = pronunciationIndex[normalizedWord];
  const builtIn = (builtInAudio?.usSpeech || builtInAudio?.ukSpeech || "").trim();
  if (builtIn) {
    return resolveAudioUrl(builtIn);
  }

  if (preferredSource === PRONUNCIATION_SOURCE_YOUDAO) {
    return buildYoudaoAudioUrl(normalizedWord);
  }

  try {
    return await lookupFromFreeDictionary(normalizedWord);
  } catch (error) {
    if (preferredSource === PRONUNCIATION_SOURCE_FREE_DICTIONARY) {
      return buildYoudaoAudioUrl(normalizedWord);
    }
    throw new Error(mapErrorMessage(error));
  }
};
