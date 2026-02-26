import type { AIConfig, AIContentType } from "../types";
import { normalizeAiContent } from "../utils/aiContentFormatter";
import { buildPrompt, systemInstruction } from "../utils/promptTemplates";

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

const normalizeBaseUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const mapErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    if (/401/.test(error.message)) return "API Key 无效或已过期";
    if (/402/.test(error.message)) return "账户额度不足";
    if (/403/.test(error.message)) return "请求被拒绝，请检查服务商权限设置";
    if (/404/.test(error.message)) return "接口地址或模型不存在，请检查 Base URL 与模型名";
    if (/429/.test(error.message)) return "请求过于频繁或额度受限，请稍后重试";
    if (/5\d\d/.test(error.message)) return "AI 服务暂时不可用，请稍后重试";
    if (/timeout|network/i.test(error.message)) return "网络超时，请稍后重试";
    if (/Failed to fetch/i.test(error.message)) return "连接失败，请检查 Base URL 与网络";
    return error.message;
  }
  return "请求失败，请稍后重试";
};

const requestChat = async (
  config: AIConfig,
  messages: ChatMessage[],
  temperature: number | null = null,
): Promise<string> => {
  const baseUrl = normalizeBaseUrl(config.apiBaseUrl);
  const endpoint = `${baseUrl}chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: config.modelName.trim(),
      messages,
      temperature: temperature ?? undefined,
      stream: false,
    }),
  });

  if (!response.ok) {
    const maybeJson = (await response.text()) || "";
    throw new Error(`${response.status} ${maybeJson}`);
  }

  const data = (await response.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) {
    throw new Error(data.error?.message || "AI 返回内容为空");
  }
  return content;
};

const shouldRetry = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (/429/.test(error.message)) return true;
  if (/5\d\d/.test(error.message)) return true;
  return /timeout|network|Failed to fetch/i.test(error.message);
};

const requestWithRetry = async (
  config: AIConfig,
  messages: ChatMessage[],
  temperature: number | null = null,
): Promise<string> => {
  const maxAttempts = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await requestChat(config, messages, temperature);
    } catch (error) {
      lastError = error;
      const hasNext = attempt < maxAttempts - 1;
      if (!hasNext || !shouldRetry(error)) {
        break;
      }
    }
  }

  throw lastError;
};

const validateConfig = (config: AIConfig, requireEnabled: boolean): string | null => {
  if (requireEnabled && !config.enabled) return "AI 未启用";
  if (!config.apiBaseUrl.trim()) return "请填写 Base URL";
  if (!config.modelName.trim()) return "请填写模型名称";
  if (!config.apiKey.trim()) return "请填写 API Key";
  return null;
};

export const inferProviderName = (baseUrl: string): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized === normalizeBaseUrl("https://api.openai.com/v1/")) return "OpenAI";
  if (normalized === normalizeBaseUrl("https://api.deepseek.com/v1/")) return "DeepSeek";
  if (normalized === normalizeBaseUrl("https://open.bigmodel.cn/api/paas/v4/")) return "智谱AI";
  return "自定义";
};

export const providerPresets = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1/" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/" },
  { name: "智谱AI", baseUrl: "https://open.bigmodel.cn/api/paas/v4/" },
];

export const generateAiContent = async (
  config: AIConfig,
  type: AIContentType,
  queryContent: string,
): Promise<string> => {
  const reason = validateConfig(config, true);
  if (reason) throw new Error(reason);

  try {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemInstruction(type),
      },
      {
        role: "user",
        content: buildPrompt(type, queryContent.trim()),
      },
    ];
    const rawContent = await requestWithRetry(config, messages, 0);
    return normalizeAiContent(type, rawContent);
  } catch (error) {
    throw new Error(mapErrorMessage(error));
  }
};

export const testAiConnection = async (config: AIConfig): Promise<string> => {
  const reason = validateConfig(config, false);
  if (reason) throw new Error(reason);

  try {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "请回复连接成功，不需要额外说明。",
      },
    ];
    return await requestWithRetry(config, messages, null);
  } catch (error) {
    throw new Error(mapErrorMessage(error));
  }
};
