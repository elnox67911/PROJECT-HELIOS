import { createHash } from "node:crypto";
import { z } from "zod";
import type { HeliosConfig } from "../config";
import type { Logger } from "../logger";
import type { Store } from "../db/store";
import type {
  MemoryLayer,
  MemoryRecord,
  MemorySearchResult,
  RunStatus,
  TaskStatus,
} from "../types";
import { cosineSimilarity, type Embedder } from "./embedding";

export interface MemoryModel {
  complete(input: { system: string; user: string }): Promise<string | null>;
}

export interface RunDigest {
  runId: string;
  projectId: string;
  objective: string;
  mode: string;
  status: RunStatus;
  tasks: Array<{ title: string; status: TaskStatus; result?: string | null; error?: string | null }>;
  changedFiles: string[];
  verification: { ran: boolean; passed: boolean; commands: string[] };
  errors: string[];
}

export interface WriteMemoryInput {
  projectId: string;
  layer: MemoryLayer;
  kind: string;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  key?: string | null;
  source?: MemoryRecord["source"];
}

export interface MemoryManagerOptions {
  store: Store;
  config: HeliosConfig;
  logger: Logger;
  embedder?: Embedder | null;
  model?: MemoryModel | null;
}

const WRITABLE_LAYERS: MemoryLayer[] = ["episodic", "semantic", "procedural", "project"];

const extractionSchema = z.object({
  memories: z.array(
    z.object({
      layer: z.enum(["semantic", "project", "procedural"]),
      kind: z.string().min(1).max(60),
      key: z.string().max(120).nullish(),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(8000),
      tags: z.array(z.string()).max(12).default([]),
      importance: z.number().min(0).max(1).default(0.6),
    }),
  ),
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function parseJsonBlock(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export class MemoryManager {
  private config: HeliosConfig;

  constructor(private readonly options: MemoryManagerOptions) {
    this.config = options.config;
  }

  updateConfig(config: HeliosConfig): void {
    this.config = config;
  }

  private fingerprint(input: {
    layer: MemoryLayer;
    kind: string;
    key?: string | null;
    title: string;
    content: string;
  }): string {
    const payload = [
      input.layer,
      input.kind,
      input.key ?? "",
      normalizeText(input.title).toLowerCase(),
      normalizeText(input.content).toLowerCase(),
    ].join("|");
    return createHash("sha256").update(payload).digest("hex").slice(0, 32);
  }

  async write(input: WriteMemoryInput): Promise<MemoryRecord> {
    if (!WRITABLE_LAYERS.includes(input.layer)) {
      throw new Error(`Layer "${input.layer}" is not persisted; only ${WRITABLE_LAYERS.join(", ")} are stored.`);
    }
    const title = normalizeText(input.title).slice(0, 200);
    const content = input.content.trim().slice(0, 8000);
    if (!title || !content) throw new Error("Memory title and content are required.");
    const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 12);
    const importance = clamp(input.importance ?? 0.5, 0, 1);
    const confidence = clamp(input.confidence ?? 0.7, 0, 1);
    const key = input.key?.trim() || null;
    const fingerprint = this.fingerprint({ layer: input.layer, kind: input.kind, key, title, content });

    const existing = this.options.store.findMemoryByFingerprint(input.projectId, fingerprint);
    if (existing) {
      const mergedTags = [...new Set([...existing.tags, ...tags])];
      const updated = this.options.store.updateMemory(existing.id, {
        tags: mergedTags,
        importance: Math.max(existing.importance, importance),
      });
      this.options.store.touchMemories([existing.id]);
      if (!this.options.store.getVectorForMemory(existing.id)) {
        await this.embedRecord(existing.id, title, content);
      }
      return updated ?? existing;
    }

    const record = this.options.store.insertMemory({
      projectId: input.projectId,
      layer: input.layer,
      kind: input.kind,
      key,
      title,
      content,
      tags,
      importance,
      confidence,
      source: input.source ?? { type: "system" },
      fingerprint,
    });

    if (key && (input.layer === "semantic" || input.layer === "project")) {
      const others = this.options.store
        .listMemoriesByKey(input.projectId, input.layer, key)
        .filter((m) => m.id !== record.id);
      for (const other of others) {
        this.options.store.updateMemory(other.id, {
          status: "superseded",
          supersededBy: record.id,
        });
        this.options.logger.info("memory superseded by newer fact", {
          oldId: other.id,
          newId: record.id,
          key,
        });
      }
    }

    await this.embedRecord(record.id, title, content);
    this.options.store.trimMemories(input.projectId, this.config.memory.maxRecords);
    return record;
  }

  private async embedRecord(id: string, title: string, content: string): Promise<void> {
    if (!this.options.embedder) return;
    try {
      const result = await this.options.embedder.embed([`${title}\n${content}`]);
      const vector = result?.vectors[0];
      if (result && vector && vector.length > 0) {
        this.options.store.saveVector(id, result.model, vector);
      }
    } catch (error) {
      this.options.logger.debug("failed to embed memory", { id, error: String(error) });
    }
  }

  async search(input: {
    projectId: string;
    query: string;
    layers?: MemoryLayer[];
    limit?: number;
  }): Promise<MemorySearchResult[]> {
    const limit = clamp(input.limit ?? this.config.memory.retrievalLimit, 1, 50);
    const query = input.query.trim();
    const layers = input.layers?.length ? input.layers : undefined;
    const now = Date.now();

    if (!query) {
      return this.options.store
        .listMemories({ projectId: input.projectId, layer: layers?.[0], limit })
        .map((memory) => ({
          ...memory,
          score: memory.importance,
          signals: { vector: null, keyword: null, importance: memory.importance, recency: 1 },
        }));
    }

    interface Candidate {
      memory: MemoryRecord;
      keyword: number | null;
      vector: number | null;
    }
    const candidates = new Map<string, Candidate>();

    const keywordHits = this.options.store.keywordSearchMemories(input.projectId, query, {
      layers,
      limit: 60,
    });
    keywordHits.forEach((hit, index) => {
      candidates.set(hit.memory.id, {
        memory: hit.memory,
        keyword: 1 - index / Math.max(keywordHits.length, 1),
        vector: null,
      });
    });

    if (this.options.embedder) {
      try {
        const embedded = await this.options.embedder.embed([query]);
        const queryVector = embedded?.vectors[0];
        if (queryVector) {
          const stored = this.options.store.getVectors(input.projectId, layers);
          for (const item of stored) {
            const similarity = cosineSimilarity(queryVector, item.vector);
            if (similarity <= 0.05) continue;
            let candidate = candidates.get(item.memoryId);
            if (!candidate) {
              const memory = this.options.store.getMemory(item.memoryId);
              if (!memory || memory.status !== "active" || memory.projectId !== input.projectId) continue;
              candidate = { memory, keyword: null, vector: null };
            }
            candidate.vector = Math.max(candidate.vector ?? 0, similarity);
            candidates.set(item.memoryId, candidate);
          }
        }
      } catch (error) {
        this.options.logger.debug("vector search failed", { error: String(error) });
      }
    }

    const vectorWeight = this.config.memory.vectorWeight;
    const keywordWeight = this.config.memory.keywordWeight;
    const scored: MemorySearchResult[] = [];
    for (const candidate of candidates.values()) {
      const memory = candidate.memory;
      if (memory.status !== "active") continue;
      if (layers && !layers.includes(memory.layer)) continue;
      const ageDays = Math.max(0, (now - Date.parse(memory.updatedAt)) / 86_400_000);
      const recency = Math.exp(-ageDays / 45);
      const present = (candidate.vector != null ? vectorWeight : 0) + (candidate.keyword != null ? keywordWeight : 0) + 0.2;
      const score =
        ((candidate.vector ?? 0) * vectorWeight +
          (candidate.keyword ?? 0) * keywordWeight +
          0.1 * memory.importance +
          0.1 * recency) /
        present;
      if (score < 0.12) continue;
      scored.push({
        ...memory,
        score,
        signals: {
          vector: candidate.vector,
          keyword: candidate.keyword,
          importance: memory.importance,
          recency,
        },
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit);
    this.options.store.touchMemories(results.map((r) => r.id));
    return results;
  }

  list(input: {
    projectId: string;
    layer?: MemoryLayer;
    status?: MemoryRecord["status"];
    limit?: number;
    offset?: number;
  }): MemoryRecord[] {
    return this.options.store.listMemories(input);
  }

  get(id: string): MemoryRecord | null {
    return this.options.store.getMemory(id);
  }

  async update(
    id: string,
    patch: Partial<Pick<MemoryRecord, "title" | "content" | "tags" | "importance" | "key">>,
  ): Promise<MemoryRecord | null> {
    const before = this.options.store.getMemory(id);
    if (!before) return null;
    const updated = this.options.store.updateMemory(id, patch);
    if (updated && patch.content !== undefined) {
      await this.embedRecord(id, updated.title, updated.content);
    }
    return updated;
  }

  delete(id: string): void {
    this.options.store.deleteMemory(id);
  }

  async consolidate(projectId: string): Promise<{ superseded: number; archived: number; trimmed: number }> {
    const all = this.options.store.listMemories({ projectId, limit: this.config.memory.maxRecords });
    const groups = new Map<string, MemoryRecord[]>();
    for (const memory of all) {
      if (!memory.key) continue;
      const groupKey = `${memory.layer}|${memory.key}`;
      const group = groups.get(groupKey) ?? [];
      group.push(memory);
      groups.set(groupKey, group);
    }
    let superseded = 0;
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      const sorted = [...group].sort(
        (a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt),
      );
      const keeper = sorted[0]!;
      const mergedTags = new Set(keeper.tags);
      for (const loser of sorted.slice(1)) {
        for (const tag of loser.tags) mergedTags.add(tag);
        this.options.store.updateMemory(loser.id, { status: "superseded", supersededBy: keeper.id });
        superseded++;
      }
      this.options.store.updateMemory(keeper.id, { tags: [...mergedTags] });
    }
    const cutoff = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const archived = this.options.store.archiveStale(projectId, cutoff, 0.25);
    const trimmed = this.options.store.trimMemories(projectId, this.config.memory.maxRecords);
    return { superseded, archived, trimmed };
  }

  async extractFromRun(digest: RunDigest): Promise<MemoryRecord[]> {
    if (!this.config.memory.extraction) return [];
    const created: MemoryRecord[] = [];
    const source = { type: "run" as const, runId: digest.runId };
    const completed = digest.tasks.filter((t) => t.status === "completed");
    const failed = digest.tasks.filter((t) => t.status === "failed");
    const verificationLine = digest.verification.ran
      ? `${digest.verification.passed ? "PASSED" : "FAILED"} (${digest.verification.commands.join("; ")})`
      : "UNVERIFIED";
    const summaryLines = [
      `Objective: ${digest.objective}`,
      `Outcome: ${digest.status} (${digest.mode} mode)`,
      `Tasks: ${completed.length} completed, ${failed.length} failed of ${digest.tasks.length}`,
      ...completed.slice(0, 8).map((t) => `- ${t.title}`),
      digest.changedFiles.length ? `Changed files: ${digest.changedFiles.slice(0, 20).join(", ")}` : "Changed files: none",
      `Verification: ${verificationLine}`,
      ...(digest.errors.length ? [`Errors: ${digest.errors.slice(0, 5).join(" | ")}`] : []),
    ];

    created.push(
      await this.write({
        projectId: digest.projectId,
        layer: "episodic",
        kind: "run_summary",
        title: `Run: ${truncate(digest.objective, 120)}`,
        content: summaryLines.join("\n"),
        tags: [digest.mode, digest.status],
        importance: digest.status === "completed" ? 0.55 : 0.45,
        confidence: 0.9,
        source,
      }),
    );

    if (digest.status === "completed" && digest.verification.passed && digest.tasks.length > 0) {
      const steps = completed.map((t, i) => `${i + 1}. ${t.title}`);
      created.push(
        await this.write({
          projectId: digest.projectId,
          layer: "procedural",
          kind: "verified_workflow",
          title: `Verified workflow: ${truncate(digest.objective, 110)}`,
          content: [
            `Objective: ${digest.objective}`,
            `Steps:`,
            ...steps,
            `Verification: ${digest.verification.commands.join("; ")}`,
          ].join("\n"),
          tags: ["verified", digest.mode],
          importance: 0.65,
          confidence: 0.75,
          source,
        }),
      );
    }

    if (this.options.model && digest.tasks.length > 0) {
      try {
        const extracted = await this.extractWithModel(digest);
        for (const item of extracted) {
          created.push(
            await this.write({
              projectId: digest.projectId,
              layer: item.layer,
              kind: item.kind,
              key: item.key ?? null,
              title: item.title,
              content: item.content,
              tags: item.tags,
              importance: item.importance,
              confidence: 0.65,
              source,
            }),
          );
        }
      } catch (error) {
        this.options.logger.debug("model memory extraction failed", { error: String(error) });
      }
    }

    return created;
  }

  private async extractWithModel(
    digest: RunDigest,
  ): Promise<Array<z.infer<typeof extractionSchema>["memories"][number]>> {
    const system = [
      "You extract durable, reusable project knowledge from a completed coding session.",
      "Only record facts that are directly supported by the session digest. Never invent facts.",
      "Prefer architecture, conventions, commands, validated workflows, and project-specific constraints.",
      "Do not record transient details, timestamps, or task-status chatter.",
      'Respond with strict JSON only: {"memories":[{layer,kind,key,title,content,tags,importance}]}',
      "layer must be one of: semantic, project, procedural. importance is 0..1.",
      "Use a stable key for facts that may be updated later (e.g. 'build.command', 'architecture.storage').",
    ].join(" ");
    const user = JSON.stringify(
      {
        objective: digest.objective,
        mode: digest.mode,
        status: digest.status,
        tasks: digest.tasks.slice(0, 20),
        changedFiles: digest.changedFiles.slice(0, 40),
        verification: digest.verification,
        errors: digest.errors.slice(0, 10),
      },
      null,
      2,
    );
    const response = await this.options.model!.complete({ system, user });
    if (!response) return [];
    const parsed = parseJsonBlock(response);
    if (!parsed) return [];
    const validated = extractionSchema.safeParse(parsed);
    if (!validated.success) return [];
    return validated.data.memories
      .filter((m) => m.importance >= 0.45)
      .slice(0, 5)
      .map((m) => ({ ...m, key: m.key ?? null }));
  }
}
