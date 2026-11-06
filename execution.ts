import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { GitCheckpointService, type AgentMode, type HeliosApp } from "@helios/core";
import {
  HttpError,
  optionalBoolean,
  optionalNumber,
  optionalString,
  projectOrThrow,
  requireObject,
  requiredString,
  runOrThrow,
} from "../http";

const execFileAsync = promisify(execFile);
const MODES: AgentMode[] = ["ask", "plan", "code", "autonomous", "debug", "review", "research"];

function modeOrThrow(value: unknown): AgentMode {
  if (typeof value !== "string" || !MODES.includes(value as AgentMode)) {
    throw new HttpError(400, `Field "mode" must be one of: ${MODES.join(", ")}.`);
  }
  return value as AgentMode;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return e.stdout ?? e.stderr ?? e.message ?? "";
  }
}

export async function registerExecutionRoutes(
  server: FastifyInstance,
  app: HeliosApp,
): Promise<void> {
  server.get("/api/runs", async (request) => {
    const query = request.query as { projectId?: string; status?: string; limit?: string };
    return {
      runs: app.store.listRuns({
        projectId: query.projectId,
        status: query.status as never,
        limit: Math.min(200, Math.max(1, Number(query.limit ?? 50))),
      }),
    };
  });

  server.post("/api/runs", async (request, reply) => {
    const body = requireObject(request.body);
    const projectId = requiredString(body, "projectId", 120);
    projectOrThrow(app, projectId);
    const objective = requiredString(body, "objective", 20_000);
    const mode = modeOrThrow(body.mode ?? "code");
    const sessionId = optionalString(body, "sessionId", 120);
    const providerId = optionalString(body, "providerId", 120);
    const model = optionalString(body, "model", 200);
    const autoApprove = optionalBoolean(body, "autoApprove") ?? false;
    try {
      const handle = await app.runtime.start({
        projectId,
        objective,
        mode,
        sessionId,
        providerId,
        model,
        autoApprove,
      });
      reply.code(202);
      return { run: handle.run };
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  server.post("/api/chat", async (request, reply) => {
    const body = requireObject(request.body);
    const projectId = requiredString(body, "projectId", 120);
    projectOrThrow(app, projectId);
    const objective =
      optionalString(body, "message", 20_000) ?? requiredString(body, "objective", 20_000);
    const mode = modeOrThrow(body.mode ?? "code");
    const sessionId = optionalString(body, "sessionId", 120);
    const providerId = optionalString(body, "providerId", 120);
    const model = optionalString(body, "model", 200);
    try {
      const handle = await app.runtime.start({
        projectId,
        objective,
        mode,
        sessionId,
        providerId,
        model,
      });
      reply.code(202);
      return { run: handle.run };
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  server.get("/api/runs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const run = runOrThrow(app, id);
    return {
      run,
      tasks: app.store.listTasks(id),
      toolCalls: app.store.listToolCalls(id),
      approvals: app.store.listApprovals({ runId: id, limit: 200 }),
      checkpoints: app.store.listCheckpoints(run.projectId, 100).filter((c) => c.runId === id),
      events: app.store.listEvents(id, 0, 500),
      active: app.runtime.isActive(id),
    };
  });

  server.post("/api/runs/:id/pause", async (request) => {
    const { id } = request.params as { id: string };
    runOrThrow(app, id);
    const live = app.runtime.pause(id);
    return { ok: true, live, run: app.store.getRun(id) };
  });

  server.post("/api/runs/:id/resume", async (request) => {
    const { id } = request.params as { id: string };
    runOrThrow(app, id);
    try {
      const handle = await app.runtime.resume(id);
      return { ok: true, run: handle.run };
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  server.post("/api/runs/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    runOrThrow(app, id);
    const live = app.runtime.cancel(id);
    return { ok: true, live, run: app.store.getRun(id) };
  });

  server.get("/api/runs/:id/events", async (request) => {
    const { id } = request.params as { id: string };
    runOrThrow(app, id);
    const query = request.query as { after?: string; limit?: string };
    const after = Number(query.after ?? 0);
    const limit = Math.min(2_000, Math.max(1, Number(query.limit ?? 500)));
    return {
      events: app.store.listEvents(id, Number.isFinite(after) ? after : 0, limit),
    };
  });

  server.get("/api/runs/:id/diff", async (request) => {
    const { id } = request.params as { id: string };
    const run = runOrThrow(app, id);
    const project = projectOrThrow(app, run.projectId);
    const checkpoint = app.store
      .listCheckpoints(project.id, 100)
      .find((entry) => entry.runId === run.id);
    if (checkpoint) {
      try {
        const service = new GitCheckpointService({
          store: app.store,
          project,
          paths: app.paths,
          logger: app.logger,
        });
        const diff = await service.diffFrom(checkpoint.id);
        return { diff, checkpoint: checkpoint.id, source: "checkpoint" };
      } catch (error) {
        return {
          diff: "",
          checkpoint: checkpoint.id,
          source: "checkpoint",
          error: (error as Error).message,
        };
      }
    }
    const [diff, status] = await Promise.all([
      git(project.rootPath, ["diff", "--no-color", "HEAD"]),
      git(project.rootPath, ["status", "--porcelain", "--untracked-files=all"]),
    ]);
    return { diff, files: status, source: "working-tree" };
  });

  server.get("/api/projects/:id/git", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    const [status, stat, diff] = await Promise.all([
      git(project.rootPath, ["status", "--porcelain", "--untracked-files=all"]),
      git(project.rootPath, ["diff", "--stat", "HEAD"]),
      git(project.rootPath, ["diff", "--no-color", "HEAD"]),
    ]);
    return { status, stat, diff };
  });

  server.get("/api/approvals", async (request) => {
    const query = request.query as { runId?: string; status?: string; limit?: string };
    return {
      approvals: app.store.listApprovals({
        runId: query.runId,
        status: query.status as never,
        limit: Math.min(200, Math.max(1, Number(query.limit ?? 100))),
      }),
    };
  });

  server.post("/api/approvals/:id/decision", async (request) => {
    const { id } = request.params as { id: string };
    const body = requireObject(request.body);
    const decision = body.decision;
    if (decision !== "approved" && decision !== "rejected") {
      throw new HttpError(400, 'Field "decision" must be "approved" or "rejected".');
    }
    const decidedBy = optionalString(body, "decidedBy", 200) ?? "operator";
    const note = optionalString(body, "note", 4_000) ?? null;
    const existing = app.store.getApproval(id);
    if (!existing) throw new HttpError(404, `Approval ${id} not found.`);
    if (existing.status !== "pending") {
      throw new HttpError(409, `Approval ${id} was already ${existing.status}.`);
    }
    const approval = app.store.decideApproval(id, decision, decidedBy, note);
    return { approval };
  });

  server.get("/api/projects/:id/checkpoints", async (request) => {
    const { id } = request.params as { id: string };
    const project = projectOrThrow(app, id);
    return { checkpoints: app.store.listCheckpoints(project.id, 100) };
  });

  server.post("/api/checkpoints/:id/rollback", async (request) => {
    const { id } = request.params as { id: string };
    const checkpoint = app.store.getCheckpoint(id);
    if (!checkpoint) throw new HttpError(404, `Checkpoint ${id} not found.`);
    const project = app.store.getProject(checkpoint.projectId);
    if (!project) throw new HttpError(404, `Project ${checkpoint.projectId} not found.`);
    const body = requireObject(request.body ?? {});
    const confirm = optionalBoolean(body, "confirm") ?? false;
    if (!confirm) {
      throw new HttpError(
        400,
        "Rollback rewrites working-tree files. Retry with { \"confirm\": true } to proceed.",
      );
    }
    const service = new GitCheckpointService({
      store: app.store,
      project,
      paths: app.paths,
      logger: app.logger,
    });
    const result = await service.rollback(id);
    return result;
  });
}
