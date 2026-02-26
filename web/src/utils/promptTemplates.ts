import type { AIContentType } from "../types";

export const systemInstruction = (type: AIContentType): string => {
  switch (type) {
    case "EXAMPLE":
      return "你是考研英语助教。必须严格按用户给定模板输出，不得添加额外说明、寒暄或总结。";
    case "MEMORY_AID":
      return "你是英语单词记忆教练。必须严格按模板输出，内容简短、可直接复习，不得输出多余段落。";
    case "SENTENCE":
      return "你是英语长难句解析助手。必须严格输出句子主干、语法成分标注、中文翻译三段，不得增加其他标题。";
    case "WORD_TRANSLATION":
      return "你是考研英语词义助手。必须严格输出中文翻译、词性两段，不得添加额外说明。";
    default:
      return "你是英语学习助手。";
  }
};

const buildExamplePrompt = (word: string): string => `请围绕单词 ${word} 生成 2 个考研阅读风格英文例句，严格按以下格式输出：
【例句1】
<英文例句>
【翻译1】
<中文翻译>
【例句2】
<英文例句>
【翻译2】
<中文翻译>

规则：
1. 英文例句控制在 12-24 个词。
2. 中文翻译准确、自然。
3. 只输出上述模板，不要添加解释。`;

const buildMemoryAidPrompt = (word: string): string => `请为单词 ${word} 生成助记内容，严格按以下格式输出：
【词根词缀】
<一句话词根词缀拆解>
【联想记忆】
<一句话谐音或场景联想>
【复习提示】
<一句话记忆抓手>

规则：
1. 每段 1 句话，总字数不超过 120 字。
2. 只输出上述模板，不要添加解释。`;

const buildSentencePrompt = (sentence: string): string => `请解析下面英语长难句：
${sentence}
请严格按以下格式输出，不要添加额外说明：
## 句子主干
（一句话概括主谓宾核心结构）
## 语法成分标注
（按短语或从句分点解释其语法功能）
## 中文翻译
（给出自然、通顺的中文翻译）
不得输出其他标题、前言或总结。`;

const buildWordTranslationPrompt = (word: string): string => `请为单词 ${word} 给出常见中文释义，严格按以下格式输出：
【中文翻译】
<给出 1-3 个常见义项，使用；分隔>
【词性】
<常见词性缩写，如 n. v. adj. adv.；不确定时写未标注>

规则：
1. 只输出上述模板，不要添加解释。
2. 中文翻译尽量简洁，适合背词场景。`;

export const buildPrompt = (type: AIContentType, query: string): string => {
  switch (type) {
    case "EXAMPLE":
      return buildExamplePrompt(query);
    case "MEMORY_AID":
      return buildMemoryAidPrompt(query);
    case "SENTENCE":
      return buildSentencePrompt(query);
    case "WORD_TRANSLATION":
      return buildWordTranslationPrompt(query);
    default:
      return query;
  }
};
