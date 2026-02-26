import type { AIContentType, SearchSentenceAnalysis } from "../types";

const cleanLines = (raw: string): string[] =>
  raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, "").replace(/^\d+[).]\s*/, ""))
    .filter(Boolean);

const normalizeExample = (content: string): string => {
  if (content.includes("【例句1】") && content.includes("【翻译1】")) {
    return content;
  }

  const lines = cleanLines(content);
  const english = lines.filter((line) => /[A-Za-z]/.test(line));
  const chinese = lines.filter((line) => /[\u4e00-\u9fff]/.test(line));

  const e1 = english[0] ?? "未提取到标准例句，请重试";
  const c1 = chinese[0] ?? "未提取到标准翻译，请重试";
  const e2 = english[1] ?? "未提取到第二条例句，请重试";
  const c2 = chinese[1] ?? "未提取到第二条翻译，请重试";

  return `【例句1】\n${e1}\n【翻译1】\n${c1}\n【例句2】\n${e2}\n【翻译2】\n${c2}`;
};

const normalizeMemoryAid = (content: string): string => {
  if (content.includes("【词根词缀】") && content.includes("【联想记忆】")) {
    return content;
  }
  const lines = cleanLines(content);
  const root = lines[0] ?? "未提取到词根词缀信息，请重试";
  const association = lines[1] ?? "未提取到联想记忆信息，请重试";
  const tip = lines[2] ?? "未提取到复习提示，请重试";
  return `【词根词缀】\n${root}\n【联想记忆】\n${association}\n【复习提示】\n${tip}`;
};

export const extractLikelyTranslation = (content: string): string => {
  const lines = cleanLines(content);
  const reversed = [...lines].reverse();
  return reversed.find((line) => /[\u4e00-\u9fff]/.test(line)) ?? "";
};

export const parseSentenceAnalysis = (rawContent: string): SearchSentenceAnalysis => {
  const normalized = rawContent.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return {
      mainClause: "未识别到句子主干，请重试",
      grammarBreakdown: "未识别到语法成分，请重试",
      chineseTranslation: "未识别到中文翻译，请重试",
    };
  }

  const sectionPattern =
    /^(?:#{1,3}\s*)?[【\[]?(句子主干|主干|语法成分标注|语法成分|语法拆解|语法分析|中文翻译|翻译)[】\]]?\s*[:：]?\s*$/gim;

  const headingMatches = Array.from(normalized.matchAll(sectionPattern));
  if (headingMatches.length > 0) {
    let mainClause = "";
    let grammarBreakdown = "";
    let chineseTranslation = "";

    headingMatches.forEach((match, index) => {
      const label = match[1] ?? "";
      const start = (match.index ?? 0) + match[0].length;
      const end =
        index < headingMatches.length - 1
          ? headingMatches[index + 1].index ?? normalized.length
          : normalized.length;
      const sectionContent = normalized
        .slice(start, end)
        .trim()
        .replace(/^[-•*]\s*/, "")
        .trim();

      if (label.includes("主干") && !mainClause) {
        mainClause = sectionContent;
      } else if (label.includes("翻译") && !chineseTranslation) {
        chineseTranslation = sectionContent;
      } else if (!grammarBreakdown) {
        grammarBreakdown = sectionContent;
      }
    });

    return {
      mainClause: mainClause || "未识别到句子主干，请重试",
      grammarBreakdown: grammarBreakdown || normalized,
      chineseTranslation:
        chineseTranslation || extractLikelyTranslation(normalized) || "未识别到中文翻译，请重试",
    };
  }

  const blocks = normalized
    .split(/\n\s*\n/g)
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    mainClause: blocks[0] || "未识别到句子主干，请重试",
    grammarBreakdown:
      blocks.length >= 3 ? blocks.slice(1, blocks.length - 1).join("\n\n") : blocks[1] || normalized,
    chineseTranslation:
      extractLikelyTranslation(normalized) || blocks[blocks.length - 1] || "未识别到中文翻译，请重试",
  };
};

const normalizeSentence = (content: string): string => {
  if (
    content.includes("## 句子主干") &&
    content.includes("## 语法成分标注") &&
    content.includes("## 中文翻译")
  ) {
    return content;
  }

  const parsed = parseSentenceAnalysis(content);
  return `## 句子主干\n${parsed.mainClause}\n## 语法成分标注\n${parsed.grammarBreakdown}\n## 中文翻译\n${parsed.chineseTranslation}`;
};

const normalizeWordTranslation = (content: string): string => {
  if (content.includes("【中文翻译】") && content.includes("【词性】")) {
    return content;
  }

  const lines = cleanLines(content);
  const translation = lines.find((line) => /[\u4e00-\u9fff]/.test(line)) || lines[0] || "未提取到中文翻译，请重试";
  const pos =
    lines.find((line) => /\bn\.|\bv\.|adj\.|adv\.|prep\.|pron\.|词性/i.test(line)) ||
    "未标注";

  return `【中文翻译】\n${translation}\n【词性】\n${pos}`;
};

export const normalizeAiContent = (type: AIContentType, raw: string): string => {
  const content = raw.trim();
  if (!content) return "";

  switch (type) {
    case "EXAMPLE":
      return normalizeExample(content);
    case "MEMORY_AID":
      return normalizeMemoryAid(content);
    case "SENTENCE":
      return normalizeSentence(content);
    case "WORD_TRANSLATION":
      return normalizeWordTranslation(content);
    default:
      return content;
  }
};
