import type { FastifyInstance } from "fastify";
import type { HeliosApp, MemoryLayer, MemoryRecord, ProcedureStatus } from "@helios/core";
import {
  HttpError,
  optionalNumber,
  optionalString,
  projectOrThrow,
  requireObject,
  requiredString,
} from "../http";

const LAYERS: MemoryLayer[] = ["episodic", "semantic", "procedural", "project"];
const STATUSES: ProcedureStatus[] = ["proposed", "trusted", "retired"];

function memoryLayer(value: unknown): MemoryLayer {
  if (typeof value === "string" && LAYERS.includes(value as MemoryLayer)) {
    return value as MemoryLayer;
  }
  throw new HttpError(400, `Field "layer" must be one of: ${LAYERS.join(", ")}.`);
}

export async function registerKnowledgeRoutes(
  server: FastifyInstance,
  app: HeliosApp,
): Promise<void> {
  server.get("/api/projects/:id/memories", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    const query = request.query as {
      layer?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
    return {
      memories: app.memory.list({
        projectId: id,
        layer: query.layer && LAYERS.includes(query.layer as MemoryLayer)
          ? (query.layer as MemoryLayer)
          : undefined,
        status: query.status as MemoryRecord["status"] | undefined,
        limit: Math.min(500, Math.max(1, Number(query.limit ?? 200))),
        offset: Math.max(0, Number(query.offset ?? 0)),
      }),
      count: app.store.countMemories(id),
    };
  });

  server.post("/api/projects/:id/memories/search", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    const body = requireObject(request.body);
    const query = requiredString(body, "query", 4_000);
    const layers = Array.isArray(body.layers)
      ? body.layers.filter((layer): layer is MemoryLayer => LAYERS.includes(layer as MemoryLayer))
      : undefined;
    const limit = optionalNumber(body, "limit", 1, 50) ?? app.config.memory.retrievalLimit;
    const results = await app.memory.search({ projectId: id, query, layers, limit });
    return { results };
  });

  server.post("/api/projects/:id/memories", async (request, reply) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    const body = requireObject(request.body);
    const layer = memoryLayer(body.layer);
    const kind = requiredString(body, "kind", 60);
    const title = requiredString(body, "title", 200);
    const content = requiredString(body, "content", 8_000);
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12)
      : [];
    const importance = optionalNumber(body, "importance", 0, 1) ?? 0.6;
    const key = optionalString(body, "key", 120) ?? null;
    const memory = await app.memory.write({
      projectId: id,
      layer,
      kind,
      title,
      content,
      tags,
      importance,
      key,
      source: { type: "user" },
    });
    reply.code(201);
    return { memory };
  });

  server.post("/api/projects/:id/memories/consolidate", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    return { result: await app.memory.consolidate(id) };
  });

  server.patch("/api/memories/:id", async (request) => {
    const { id } = request.params as { id: string };
    if (!app.memory.get(id)) throw new HttpError(404, `Memory ${id} not found.`);
    const body = requireObject(request.body);
    const patch: Partial<Pick<MemoryRecord, "title" | "content" | "tags" | "importance" | "key">> = {};
    const title = optionalString(body, "title", 200);
    if (title !== undefined) patch.title = title;
    const content = optionalString(body, "content", 8_000);
    if (content !== undefined) patch.content = content;
    if (Array.isArray(body.tags)) {
      patch.tags = body.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12);
    }
    const importance = optionalNumber(body, "importance", 0, 1);
    if (importance !== undefined) patch.importance = importance;
    if (body.key === null) patch.key = null;
    else {
      const key = optionalString(body, "key", 120);
      if (key !== undefined) patch.key = key;
    }
    const memory = await app.memory.update(id, patch);
    return { memory };
  });

  server.delete("/api/memories/:id", async (request) => {
    const { id } = request.params as { id: string };
    if (!app.memory.get(id)) throw new HttpError(404, `Memory ${id} not found.`);
    app.memory.delete(id);
    return { ok: true, deleted: id };
  });

  server.get("/api/projects/:id/decisions", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    return { decisions: app.store.listDecisions(id, 100) };
  });

  server.post("/api/projects/:id/decisions", async (request, reply) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    const body = requireObject(request.body);
    const decision = app.store.createDecision({
      projectId: id,
      title: requiredString(body, "title", 200),
      rationale: requiredString(body, "rationale", 8_000),
      alternatives: optionalString(body, "alternatives", 4_000) ?? null,
      consequences: optionalString(body, "consequences", 4_000) ?? null,
      status: body.status === "accepted" || body.status === "superseded" ? body.status : "proposed",
    });
    reply.code(201);
    return { decision };
  });

  server.get("/api/projects/:id/procedures", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    const query = request.query as { status?: string };
    const status =
      query.status && STATUSES.includes(query.status as ProcedureStatus)
        ? (query.status as ProcedureStatus)
        : undefined;
    return { procedures: app.store.listProcedures(id, status) };
  });

  server.post("/api/projects/:id/procedures", async (request, reply) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    const body = requireObject(request.body);
    const steps = Array.isArray(body.steps)
      ? body.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0)
      : [];
    if (steps.length === 0) throw new HttpError(400, 'Field "steps" must contain at least one step.');
    const procedure = app.store.createProcedure({
      projectId: id,
      name: requiredString(body, "name", 200),
      description: optionalString(body, "description", 4_000) ?? "",
      steps,
      status: "proposed",
      sourceRunId: null,
    });
    reply.code(201);
    return { procedure };
  });

  server.post("/api/procedures/:id/promote", async (request) => {
    const { id } = request.params as { id: string };
    const body = requireObject(request.body);
    const approvedBy = requiredString(body, "approvedBy", 200);
    try {
      const procedure = app.improvement.promoteProcedure(id, approvedBy);
      return { procedure };
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  server.post("/api/procedures/:id/retire", async (request) => {
    const { id } = request.params as { id: string };
    try {
      return { procedure: app.improvement.retireProcedure(id) };
    } catch (error) {
      throw new HttpError(404, (error as Error).message);
    }
  });

  server.get("/api/projects/:id/insights", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    const query = request.query as { limit?: string };
    return {
      insights: app.store.listInsights(id, Math.min(200, Math.max(1, Number(query.limit ?? 50)))),
    };
  });

  server.post("/api/projects/:id/insights/analyze", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    return { created: app.improvement.analyze(id), insights: app.store.listInsights(id, 50) };
  });

  server.get("/api/insights", async (request) => {
    const query = request.query as { projectId?: string; limit?: string };
    return {
      insights: app.store.listInsights(
        query.projectId ?? null,
        Math.min(200, Math.max(1, Number(query.limit ?? 50))),
      ),
    };
  });

  server.get("/api/projects/:id/metrics", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    return { metrics: app.metrics.summary({ projectId: id }) };
  });

  server.get("/api/metrics", async (request) => {
    const query = request.query as { projectId?: string };
    return { metrics: app.metrics.summary({ projectId: query.projectId }) };
  });

  server.get("/api/activity", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
    const events = app.store.listRecentEvents(limit);
    const runs = new Map<string, { objective: string; status: string }>();
    for (const event of events) {
      if (!event.runId || runs.has(event.runId)) continue;
      const run = app.store.getRun(event.runId);
      if (!run) continue;
      runs.set(run.id, { objective: run.objective, status: run.status });
    }
    return {
      events: events.map((event) => ({
        ...event,
        run: event.runId
          ? { objective: runs.get(event.runId)?.objective ?? "", status: runs.get(event.runId)?.status ?? "" }
          : null,
      })),
    };
  });
}
