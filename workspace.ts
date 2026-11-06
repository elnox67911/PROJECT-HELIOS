import type { FastifyInstance } from "fastify";
import type { AgentMode, HeliosApp, Session } from "@helios/core";
import {
  HttpError,
  listProjectDirectory,
  optionalNumber,
  optionalString,
  projectFromPath,
  projectOrThrow,
  projectTree,
  readProjectFile,
  requireObject,
  requiredString,
  writeProjectFile,
} from "../http";

const MODES: AgentMode[] = ["ask", "plan", "code", "autonomous", "debug", "review", "research"];

function modeOrDefault(value: unknown): AgentMode {
  return typeof value === "string" && MODES.includes(value as AgentMode)
    ? (value as AgentMode)
    : "code";
}

export async function registerWorkspaceRoutes(
  server: FastifyInstance,
  app: HeliosApp,
): Promise<void> {
  server.get("/api/projects", async () => ({
    projects: app.store.listProjects().map((project) => ({
      ...project,
      profile: app.store.getProfile(project.id),
      activeRuns: app.store.listRuns({ projectId: project.id, status: "running", limit: 10 }).length,
    })),
  }));

  server.post("/api/projects", async (request, reply) => {
    const body = requireObject(request.body);
    const rootPath = requiredString(body, "path", 4_000).trim();
    const name = optionalString(body, "name", 200);
    const project = projectFromPath(app, rootPath, name);
    let indexed = false;
    let indexError: string | null = null;
    try {
      await app.indexer.ensureIndexed(project, { force: true });
      indexed = true;
    } catch (error) {
      indexError = (error as Error).message;
    }
    reply.code(201);
    return { project, profile: app.store.getProfile(project.id), indexed, indexError };
  });

  server.get("/api/projects/:id", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    return {
      project,
      profile: app.store.getProfile(project.id),
      sessions: app.store.listSessions(project.id).length,
      runs: app.store.listRuns({ projectId: project.id, limit: 20 }),
      memoryCount: app.store.countMemories(project.id),
    };
  });

  server.delete("/api/projects/:id", async (request) => {
    const { id } = request.params as { id: string };
    projectOrThrow(app, id);
    app.store.deleteProject(id);
    return { ok: true, deleted: id };
  });

  server.post("/api/projects/:id/reindex", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    const stats = await app.indexer.refresh(project);
    return { ok: true, stats };
  });

  server.get("/api/projects/:id/files", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    const query = request.query as { path?: string };
    return listProjectDirectory(app, project, query.path ?? ".");
  });

  server.get("/api/projects/:id/file", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    const query = request.query as { path?: string };
    if (!query.path) throw new HttpError(400, "Query parameter \"path\" is required.");
    const file = readProjectFile(app, project, query.path);
    return { path: file.path, content: file.content, size: file.size, truncated: file.truncated };
  });

  server.put("/api/projects/:id/file", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    const body = requireObject(request.body);
    const path = requiredString(body, "path", 2_000);
    if (typeof body.content !== "string") throw new HttpError(400, "Field \"content\" is required.");
    const result = writeProjectFile(app, project, path, body.content);
    return { ok: true, ...result };
  });

  server.get("/api/projects/:id/tree", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    const query = request.query as { path?: string; depth?: string };
    const depth = Math.min(6, Math.max(1, Number(query.depth ?? 2) || 2));
    return {
      path: query.path ?? "",
      entries: projectTree(app, project, query.path ?? "", depth),
    };
  });

  server.get("/api/projects/:id/symbols", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    const query = request.query as { q?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 30)));
    if (!query.q) return { symbols: [] };
    return { symbols: app.indexer.symbolSearch(project.id, query.q, limit) };
  });

  server.get("/api/projects/:id/sessions", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    return { sessions: app.store.listSessions(project.id) };
  });

  server.post("/api/projects/:id/sessions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    const body = requireObject(request.body);
    const name = optionalString(body, "name", 200) ?? "Untitled session";
    const mode = modeOrDefault(body.mode);
    let providerId = optionalString(body, "providerId", 120) ?? null;
    let model = optionalString(body, "model", 200) ?? null;
    if (!providerId && !model) {
      try {
        const target = app.registry.resolveRunTarget({ mode });
        providerId = target.providerId;
        model = target.model;
      } catch {
        // A session can exist before any provider is configured.
      }
    }
    const session = app.store.createSession({ projectId: project.id, name, mode, providerId, model });
    reply.code(201);
    return { session };
  });

  server.get("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    const session = app.store.getSession(id);
    if (!session) throw new HttpError(404, `Session ${id} not found.`);
    return {
      session,
      messages: app.store.listMessages(id, 500),
      runs: app.store.listRuns({ projectId: session.projectId, limit: 50 }).filter(
        (run) => run.sessionId === id,
      ),
    };
  });

  server.get("/api/sessions/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    if (!app.store.getSession(id)) throw new HttpError(404, `Session ${id} not found.`);
    const query = request.query as { limit?: string };
    const limit = Math.min(1_000, Math.max(1, Number(query.limit ?? 200)));
    return { messages: app.store.listMessages(id, limit) };
  });

  server.patch("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    const session = app.store.getSession(id);
    if (!session) throw new HttpError(404, `Session ${id} not found.`);
    const body = requireObject(request.body);
    const patch: Partial<Pick<Session, "name" | "mode" | "providerId" | "model">> = {};
    const name = optionalString(body, "name", 200);
    if (name !== undefined) patch.name = name;
    if (body.mode !== undefined) patch.mode = modeOrDefault(body.mode);
    const providerId = optionalString(body, "providerId", 120);
    if (providerId !== undefined) patch.providerId = providerId;
    const model = optionalString(body, "model", 200);
    if (model !== undefined) patch.model = model;
    app.store.updateSession(id, patch);
    return { session: app.store.getSession(id) };
  });
}
