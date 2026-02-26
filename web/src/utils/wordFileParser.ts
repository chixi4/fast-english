import type { WordDraft } from "../types";

const primarySeparators = [",", "\t", "|", ";"];
const fallbackSeparators = [" - ", " — ", ":", "："];
const packedEntryStartRegex = /(?:^|\s)[A-Za-z][A-Za-z0-9 .'\-/()&]{0,63}\s*,/g;

const emptyDraft = (word = ""): WordDraft => ({
  word,
  phonetic: "",
  meaning: "",
  example: "",
  phrases: "",
  synonyms: "",
  relWords: "",
});

const normalizeField = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return trimmed.slice(1, -1).replace(/""/g, '"').trim();
  }
  return trimmed;
};

const splitRespectingQuotes = (line: string, separator: string, limit: number): string[] => {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === separator && !inQuotes && fields.length < limit - 1) {
      fields.push(current);
      current = "";
      continue;
    }

    current += ch;
  }
  fields.push(current);
  return fields;
};

const splitBySeparators = (line: string, separators: string[]): string[] => {
  const separator = separators.find((item) => line.includes(item));
  if (!separator) return [line];

  if (separator.length === 1) {
    return splitRespectingQuotes(line, separator, 6);
  }
  return line.split(separator, 6);
};

const containsPrimarySeparator = (line: string): boolean => primarySeparators.some((sep) => line.includes(sep));

const isLikelyPackedWord = (token: string): boolean => {
  if (!token || token.length > 64) return false;
  let hasLetter = false;
  for (const ch of token) {
    if (ch.charCodeAt(0) >= 128) return false;
    const allowed =
      /[A-Za-z0-9]/.test(ch) ||
      ch === " " ||
      ch === "'" ||
      ch === "-" ||
      ch === "." ||
      ch === "/" ||
      ch === "(" ||
      ch === ")" ||
      ch === "&";
    if (!allowed) return false;
    if (/[A-Za-z]/.test(ch)) hasLetter = true;
  }
  return hasLetter;
};

const splitLogicalLines = (text: string): string[] => {
  if (!text.trim()) return [];
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '"') {
      if (inQuotes && i + 1 < text.length && text[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }

    if (ch === "\r") {
      const isCrlf = i + 1 < text.length && text[i + 1] === "\n";
      if (!inQuotes) {
        lines.push(current);
        current = "";
      } else {
        current += "\n";
      }
      if (isCrlf) i += 1;
      continue;
    }

    if (ch === "\n") {
      if (!inQuotes) {
        lines.push(current);
        current = "";
      } else {
        current += "\n";
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    lines.push(current);
  }
  return lines;
};

const shouldAppendToPrevious = (currentLine: string, previousLine: string): boolean => {
  if (currentLine.startsWith("#")) return false;
  if (!containsPrimarySeparator(previousLine)) return false;
  if (containsPrimarySeparator(currentLine)) return false;
  return !isLikelyPackedWord(currentLine);
};

const mergeMeaningContinuationLines = (lines: string[]): string[] => {
  if (!lines.length) return lines;
  const merged: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (merged.length > 0 && shouldAppendToPrevious(line, merged[merged.length - 1])) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n${line}`;
    } else {
      merged.push(line);
    }
  }

  return merged;
};

const parseLine = (rawLine: string): WordDraft | null => {
  const cleanedLine = rawLine.trim().replace(/^\uFEFF/, "");
  if (!cleanedLine || cleanedLine.startsWith("#")) return null;

  const primary = splitBySeparators(cleanedLine, primarySeparators);
  const parts = primary.length > 1 ? primary : splitBySeparators(cleanedLine, fallbackSeparators);
  const normalized = parts.map(normalizeField).filter((item) => item);
  if (!normalized.length) return null;

  if (normalized.length === 1) {
    return emptyDraft(normalized[0]);
  }

  if (normalized.length === 2) {
    return { ...emptyDraft(normalized[0]), meaning: normalized[1] };
  }

  if (normalized.length === 3) {
    return {
      ...emptyDraft(normalized[0]),
      phonetic: normalized[1],
      meaning: normalized[2],
    };
  }

  return {
    ...emptyDraft(normalized[0]),
    phonetic: normalized[1] ?? "",
    meaning: normalized[2] ?? "",
    example: normalized.slice(3).join(" "),
  };
};

const parseLines = (lines: string[]): WordDraft[] => lines.map(parseLine).filter(Boolean) as WordDraft[];

const looksLikePackedWordMeaningText = (text: string): boolean => {
  if (!text.includes(",")) return false;
  const sample = text.slice(0, 80_000);
  const entryCount = (sample.match(packedEntryStartRegex) ?? []).length;
  const lineCount = Math.max(1, (sample.match(/\n/g) ?? []).length);
  return entryCount >= 3 && entryCount >= lineCount * 2;
};

const skipWhitespace = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
};

const isWordStartAt = (source: string, start: number): boolean => {
  if (start >= source.length) return false;
  const commaIndex = source.indexOf(",", start);
  if (commaIndex <= start) return false;
  const candidate = source.slice(start, commaIndex).trim();
  return isLikelyPackedWord(candidate);
};

const readQuotedMeaning = (source: string, startQuoteIndex: number): [string, number] => {
  let index = startQuoteIndex + 1;
  let content = "";

  while (index < source.length) {
    const ch = source[index];
    if (ch === '"') {
      if (index + 1 < source.length && source[index + 1] === '"') {
        content += '"';
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    content += ch;
    index += 1;
  }

  return [content, skipWhitespace(source, index)];
};

const readPackedMeaning = (source: string, start: number): [string, number] => {
  let index = skipWhitespace(source, start);
  if (index >= source.length) return ["", index];

  if (source[index] === '"') {
    return readQuotedMeaning(source, index);
  }

  let content = "";
  while (index < source.length) {
    const ch = source[index];
    if (/\s/.test(ch)) {
      const nextStart = skipWhitespace(source, index);
      if (isWordStartAt(source, nextStart)) {
        return [content.trimEnd(), nextStart];
      }
      if (nextStart > index) {
        content += " ";
        index = nextStart;
        continue;
      }
    }
    content += ch;
    index += 1;
  }

  return [content.trimEnd(), index];
};

const parsePackedWordMeaningText = (text: string): WordDraft[] => {
  const source = text
    .split(/\r?\n/g)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join(" ")
    .trim();

  if (!source) return [];

  const drafts: WordDraft[] = [];
  let index = 0;

  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (index >= source.length) break;

    const commaIndex = source.indexOf(",", index);
    if (commaIndex < 0) break;

    const word = source.slice(index, commaIndex).trim();
    if (!isLikelyPackedWord(word)) {
      index = commaIndex + 1;
      continue;
    }

    const [meaning, nextIndex] = readPackedMeaning(source, commaIndex + 1);
    if (meaning.trim()) {
      drafts.push({ ...emptyDraft(word), meaning: meaning.trim() });
    }
    index = nextIndex;
  }

  return drafts;
};

const pickField = (entry: Record<string, unknown>, names: string[]): string => {
  for (const name of names) {
    const value = entry[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const toDraftFromJson = (entry: Record<string, unknown>): WordDraft | null => {
  const word = pickField(entry, ["word", "headWord", "text", "name", "title"]);
  if (!word) return null;

  const phonetic = pickField(entry, ["phonetic", "pronunciation", "ukphone", "usphone"]);
  const meaning = pickField(entry, ["meaning", "translation", "definition", "cn", "explain"]);
  const example = pickField(entry, ["example", "sentence", "sample"]);
  const phrases = pickField(entry, ["phrases", "phrase"]);
  const synonyms = pickField(entry, ["synonyms", "synonym"]);
  const relWords = pickField(entry, ["relWords", "related", "family"]);

  return {
    word,
    phonetic,
    meaning,
    example,
    phrases,
    synonyms,
    relWords,
  };
};

const collectJsonEntries = (node: unknown, output: Record<string, unknown>[]): void => {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectJsonEntries(item, output));
    return;
  }
  if (typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  if (typeof obj.word === "string" && obj.word.trim()) {
    output.push(obj);
    return;
  }

  Object.values(obj).forEach((value) => {
    if (Array.isArray(value) || (value && typeof value === "object")) {
      collectJsonEntries(value, output);
    }
  });
};

const parseAdaptiveJson = (text: string): WordDraft[] => {
  const trimmed = text.trimStart();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return [];
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const entries: Record<string, unknown>[] = [];
    collectJsonEntries(parsed, entries);
    const dedup = new Map<string, WordDraft>();

    entries.forEach((entry) => {
      const draft = toDraftFromJson(entry);
      if (!draft) return;
      const key = draft.word.trim().toLowerCase();
      if (!key || dedup.has(key)) return;
      dedup.set(key, draft);
    });

    return Array.from(dedup.values());
  } catch {
    return [];
  }
};

export const parseWordFile = (text: string): WordDraft[] => {
  const normalizedText = text.replace(/^\uFEFF/, "");
  const adaptiveJson = parseAdaptiveJson(normalizedText);
  if (adaptiveJson.length > 0) {
    return adaptiveJson;
  }

  const logicalLines = mergeMeaningContinuationLines(splitLogicalLines(normalizedText));
  const lineBased = parseLines(logicalLines);

  const packed = looksLikePackedWordMeaningText(normalizedText)
    ? parsePackedWordMeaningText(normalizedText)
    : [];

  if (packed.length > 0 && packed.length >= lineBased.length * 2) {
    return packed;
  }

  return lineBased;
};
