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
  tryParseJsonObject,
} from "./http";

export interface AnthropicOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string | null;
  headers?: Record<string, string>;
  fetchImpl: FetchLike;
  timeoutMs: number;
  supportsTools: boolean;
}

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function mergeMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content.push(...message.content);
    } else {
      out.push({ role: message.role, content: [...message.content] });
    }
  }
  return out;
}

function buildAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            content: message.content,
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      if (blocks.length > 0) converted.push({ role: "assistant", content: blocks });
      continue;
    }
    converted.push({ role: "user", content: [{ type: "text", text: message.content }] });
  }
  const system = systemParts.filter(Boolean).join("\n\n");
  return { system: system || undefined, messages: mergeMessages(converted) };
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = "anthropic" as const;
  readonly supportsTools: boolean;
  private readonly baseUrl: string;

  constructor(private readonly options: AnthropicOptions) {
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
      throw new ProviderError(this.id, `${this.id}: missing Anthropic API key`);
    }
    return {
      "content-type": "application/json",
      "x-api-key": this.options.apiKey,
      "anthropic-version": "2023-06-01",
      ...(this.options.headers ?? {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await requestJson<{ data?: Array<{ id: string; display_name?: string }> }>(
      this.options.fetchImpl,
      this.id,
      `${this.baseUrl}/v1/models?limit=100`,
      {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    return (data.data ?? []).map((m) => ({
      providerId: this.id,
      id: m.id,
      label: m.display_name ?? m.id,
      supportsTools: this.supportsTools,
      supportsEmbeddings: false,
    }));
  }

  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const { system, messages } = buildAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      messages,
      stream: true,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools && request.tools.length > 0 && this.supportsTools) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const response = await requestStream(
      this.options.fetchImpl,
      this.id,
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
    let usage: Usage = { tokensIn: 0, tokensOut: 0 };
    let finishReason = "stop";

    for await (const evt of parseSse(response)) {
      let json: any;
      try {
        json = JSON.parse(evt.data);
      } catch {
        continue;
      }
      switch (json.type) {
        case "message_start":
          usage.tokensIn = Number(json.message?.usage?.input_tokens ?? 0);
          break;
        case "content_block_start": {
          const block = json.content_block ?? {};
          if (block.type === "tool_use") {
            blocks.set(Number(json.index), {
              type: "tool_use",
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
              json: "",
            });
          } else if (block.type === "text" && block.text) {
            yield { type: "text", text: String(block.text) };
          }
          break;
        }
        case "content_block_delta": {
          const delta = json.delta ?? {};
          if (delta.type === "text_delta" && delta.text) {
            yield { type: "text", text: String(delta.text) };
          } else if (delta.type === "input_json_delta" && delta.partial_json) {
            const block = blocks.get(Number(json.index));
            if (block) block.json += String(delta.partial_json);
          }
          break;
        }
        case "content_block_stop": {
          const block = blocks.get(Number(json.index));
          if (block && block.type === "tool_use" && block.name) {
            yield {
              type: "tool_call",
              call: {
                id: block.id || `toolu_${randomUUID()}`,
                name: block.name,
                arguments: tryParseJsonObject(block.json),
              },
            };
          }
          break;
        }
        case "message_delta":
          if (json.usage?.output_tokens !== undefined) {
            usage.tokensOut = Number(json.usage.output_tokens);
          }
          if (json.delta?.stop_reason) finishReason = String(json.delta.stop_reason);
          break;
        case "message_stop":
          break;
        case "error":
          throw new ProviderError(
            this.id,
            `${this.id}: ${json.error?.message ?? "stream error"}`,
          );
        default:
          break;
      }
    }

    if (usage.tokensIn > 0 || usage.tokensOut > 0) yield { type: "usage", usage };
    yield { type: "done", finishReason };
  }
}
