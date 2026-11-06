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
  parseNdjson,
  requestJson,
  requestStream,
} from "./http";

export interface OllamaOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  fetchImpl: FetchLike;
  timeoutMs: number;
  supportsTools: boolean;
}

function toOllamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        ...(m.toolName ? { tool_name: m.toolName } : {}),
      };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          function: { name: c.name, arguments: c.arguments ?? {} },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export class OllamaProvider implements ChatProvider {
  readonly kind = "ollama" as const;
  readonly supportsTools: boolean;
  private readonly baseUrl: string;

  constructor(private readonly options: OllamaOptions) {
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
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.options.headers ?? {}),
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    return headers;
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await requestJson<{
      models?: Array<{ name: string; details?: { parameter_size?: string } }>;
    }>(this.options.fetchImpl, this.id, `${this.baseUrl}/api/tags`, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    return (data.models ?? []).map((m) => ({
      providerId: this.id,
      id: m.name,
      label: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
      supportsTools: this.supportsTools,
      supportsEmbeddings: true,
    }));
  }

  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOllamaMessages(request.messages),
      stream: true,
    };
    const options: Record<string, unknown> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;
    if (Object.keys(options).length > 0) body.options = options;
    if (request.tools && request.tools.length > 0 && this.supportsTools) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const response = await requestStream(
      this.options.fetchImpl,
      this.id,
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    let usage: Usage = { tokensIn: 0, tokensOut: 0 };
    let finishReason = "stop";
    for await (const line of parseNdjson(response)) {
      let json: any;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      if (json.error) throw new ProviderError(this.id, `${this.id}: ${json.error}`);
      const message = json.message ?? {};
      if (message.content) {
        yield { type: "text", text: String(message.content) };
      }
      for (const call of (message.tool_calls ?? []) as Array<{
        function?: { name?: string; arguments?: Record<string, unknown> };
      }>) {
        if (!call.function?.name) continue;
        yield {
          type: "tool_call",
          call: {
            id: `ollama_${randomUUID()}`,
            name: call.function.name,
            arguments: call.function.arguments ?? {},
          },
        };
      }
      if (json.done) {
        usage = {
          tokensIn: Number(json.prompt_eval_count ?? 0),
          tokensOut: Number(json.eval_count ?? 0),
        };
        finishReason = String(json.done_reason ?? "stop");
      }
    }
    if (usage.tokensIn > 0 || usage.tokensOut > 0) yield { type: "usage", usage };
    yield { type: "done", finishReason };
  }

  async embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]> {
    if (!model) throw new ProviderError(this.id, `${this.id}: an embedding model is required`);
    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input: texts }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])
        : AbortSignal.timeout(this.options.timeoutMs),
    };
    try {
      const data = await requestJson<{ embeddings: number[][] }>(
        this.options.fetchImpl,
        this.id,
        `${this.baseUrl}/api/embed`,
        init,
      );
      return data.embeddings;
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) {
        const vectors: number[][] = [];
        for (const text of texts) {
          const legacy = await requestJson<{ embedding: number[] }>(
            this.options.fetchImpl,
            this.id,
            `${this.baseUrl}/api/embeddings`,
            {
              method: "POST",
              headers: this.headers(),
              body: JSON.stringify({ model, prompt: text }),
              signal: init.signal,
            },
          );
          vectors.push(legacy.embedding);
        }
        return vectors;
      }
      throw error;
    }
  }

  defaultEmbeddingModel(): string | null {
    return "nomic-embed-text";
  }
}
