import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatStreamEvent,
  ModelInfo,
  Usage,
} from "../types";
import {
  type FetchLike,
  ProviderError,
  normalizeBaseUrl,
  parseSse,
  requestJson,
  requestStream,
} from "./http";

export interface GeminiOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string | null;
  headers?: Record<string, string>;
  fetchImpl: FetchLike;
  timeoutMs: number;
  supportsTools: boolean;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "title",
]);

/** Gemini rejects several JSON Schema keywords, so reduce to its accepted subset. */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      if (key === "properties" && value && typeof value === "object") {
        out.properties = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeGeminiSchema(v)]),
        );
      }
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeGeminiSchema(v)]),
      );
    } else if (key === "items") {
      out.items = sanitizeGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: GeminiContent[];
} {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  const append = (role: "user" | "model", parts: GeminiPart[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      append("user", [
        {
          functionResponse: {
            name: message.toolName ?? "tool",
            response: { content: message.content },
          },
        },
      ]);
      continue;
    }
    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
      }
      if (parts.length > 0) append("model", parts);
      continue;
    }
    append("user", [{ text: message.content }]);
  }
  const system = systemParts.filter(Boolean).join("\n\n");
  return {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
  };
}

export class GeminiProvider implements ChatProvider {
  readonly kind = "gemini" as const;
  readonly supportsTools: boolean;
  private readonly baseUrl: string;

  constructor(private readonly options: GeminiOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.supportsTools = options.supportsTools;
  }

  get id(): string {
    return this.options.id;
  }
  get label(): string {
    return this.options.label;
  }

  private headers(): Record<string, string> {
    if (!this.options.apiKey) {
      throw new ProviderError(this.id, `${this.id}: missing Google Gemini API key`);
    }
    return {
      "content-type": "application/json",
      "x-goog-api-key": this.options.apiKey,
      ...(this.options.headers ?? {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await requestJson<{
      models?: Array<{
        name: string;
        displayName?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    }>(this.options.fetchImpl, this.id, `${this.baseUrl}/models?pageSize=1000`, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") ?? true)
      .map((m) => ({
        providerId: this.id,
        id: m.name.replace(/^models\//, ""),
        label: m.displayName ?? m.name,
        contextWindow: m.inputTokenLimit,
        supportsTools: this.supportsTools,
        supportsEmbeddings: m.supportedGenerationMethods?.includes("embedContent") ?? false,
      }));
  }

  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const { systemInstruction, contents } = toGeminiContents(request.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    if (request.tools && request.tools.length > 0 && this.supportsTools) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeGeminiSchema(t.parameters),
          })),
        },
      ];
    }

    const model = encodeURIComponent(request.model);
    const response = await requestStream(
      this.options.fetchImpl,
      this.id,
      `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    let usage: Usage = { tokensIn: 0, tokensOut: 0 };
    let finishReason = "stop";

    for await (const evt of parseSse(response)) {
      let json: any;
      try {
        json = JSON.parse(evt.data);
      } catch {
        continue;
      }
      if (json.error) {
        throw new ProviderError(this.id, `${this.id}: ${json.error.message ?? "stream error"}`);
      }
      if (json.promptFeedback?.blockReason) {
        throw new ProviderError(
          this.id,
          `${this.id}: prompt blocked (${json.promptFeedback.blockReason})`,
        );
      }
      const candidate = json.candidates?.[0];
      for (const part of (candidate?.content?.parts ?? []) as GeminiPart[]) {
        if (typeof part.text === "string" && part.text.length > 0 && !part.thought) {
          yield { type: "text", text: part.text };
        }
        if (part.functionCall) {
          yield {
            type: "tool_call",
            call: {
              id: `gemini_${randomUUID()}`,
              name: part.functionCall.name,
              arguments: part.functionCall.args ?? {},
            },
          };
        }
      }
      if (candidate?.finishReason) finishReason = String(candidate.finishReason);
      if (json.usageMetadata) {
        usage = {
          tokensIn: Number(json.usageMetadata.promptTokenCount ?? 0),
          tokensOut: Number(json.usageMetadata.candidatesTokenCount ?? 0),
        };
      }
    }

    if (usage.tokensIn > 0 || usage.tokensOut > 0) yield { type: "usage", usage };
    yield { type: "done", finishReason };
  }

  async embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]> {
    if (!model) throw new ProviderError(this.id, `${this.id}: an embedding model is required`);
    const data = await requestJson<{ embeddings: Array<{ values: number[] }> }>(
      this.options.fetchImpl,
      this.id,
      `${this.baseUrl}/models/${encodeURIComponent(model)}:batchEmbedContents`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])
          : AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    return data.embeddings.map((e) => e.values);
  }

  defaultEmbeddingModel(): string | null {
    return "text-embedding-004";
  }
}
