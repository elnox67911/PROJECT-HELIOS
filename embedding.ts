import type { HeliosConfig } from "../config";
import type { Logger } from "../logger";
import type { ProviderRegistry } from "../providers/registry";

export const LOCAL_EMBEDDING_MODEL = "local-hash-v1";
const DIMENSIONS = 384;

function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic signed-hashing embedder used when no embedding provider is
 * available. It is lexical in nature — not a substitute for a trained model —
 * but it provides stable vector retrieval fully offline.
 */
export function hashEmbed(text: string): number[] {
  const vector = new Float64Array(DIMENSIONS);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const add = (token: string, weight: number) => {
    const hash = fnv1a(token);
    const index = hash % DIMENSIONS;
    const sign = (hash >>> 15) & 1 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * weight;
  };
  for (const token of tokens) add(token, 1);
  for (let i = 0; i < tokens.length - 1; i++) add(`${tokens[i]}_${tokens[i + 1]}`, 0.5);
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i]! * vector[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(DIMENSIONS);
  for (let i = 0; i < vector.length; i++) out[i] = Number((vector[i]! / norm).toFixed(6));
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface EmbedResult {
  model: string;
  vectors: number[][];
}

export interface Embedder {
  embed(texts: string[]): Promise<EmbedResult | null>;
}

export class EmbeddingService implements Embedder {
  private config: HeliosConfig;

  constructor(
    private readonly registry: ProviderRegistry | null,
    config: HeliosConfig,
    private readonly logger: Logger,
  ) {
    this.config = config;
  }

  updateConfig(config: HeliosConfig): void {
    this.config = config;
  }

  async embed(texts: string[]): Promise<EmbedResult | null> {
    if (texts.length === 0) return null;
    if (this.config.memory.embeddings === "off") return null;
    if (this.registry) {
      try {
        const result = await this.registry.embed(texts);
        if (result) {
          return { model: result.model, vectors: result.vectors };
        }
      } catch (error) {
        this.logger.debug("provider embeddings failed", { error: String(error) });
      }
    }
    if (this.config.memory.embeddings === "provider") return null;
    return { model: LOCAL_EMBEDDING_MODEL, vectors: texts.map(hashEmbed) };
  }
}
