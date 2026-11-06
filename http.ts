import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HeliosApp, Project } from "@helios/core";
import { isSensitivePath, resolveInsideRoot } from "@helios/core";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function projectOrThrow(app: HeliosApp, id: string): Project {
  const project = app.store.getProject(id);
  if (!project) throw new HttpError(404, `Project ${id} not found.`);
  return project;
}

export function runOrThrow(app: HeliosApp, id: string) {
  const run = app.store.getRun(id);
  if (!run) throw new HttpError(404, `Run ${id} not found.`);
  return run;
}

export function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 20_000,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `Field "${field}" is required.`);
  }
  if (value.length > maxLength) {
    throw new HttpError(400, `Field "${field}" exceeds ${maxLength} characters.`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 20_000,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `Field "${field}" must be a string.`);
  if (value.length > maxLength) {
    throw new HttpError(400, `Field "${field}" exceeds ${maxLength} characters.`);
  }
  return value;
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `Field "${field}" must be a boolean.`);
  return value;
}

export function optionalNumber(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `Field "${field}" must be between ${min} and ${max}.`);
  }
  return parsed;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".expo",
]);

export interface ProjectPath {
  absolute: string;
  relative: string;
}

export function resolveProjectPath(app: HeliosApp, project: Project, input: string): ProjectPath {
  const resolution = resolveInsideRoot(project.rootPath, input || ".");
  if (!resolution.ok) throw new HttpError(400, resolution.reason ?? "Invalid path.");
  const relative =
    resolution.absolute === project.rootPath
      ? ""
      : resolution.absolute.slice(project.rootPath.length + 1).split("\\").join("/");
  return { absolute: resolution.absolute, relative };
}

export interface FileContent {
  path: string;
  absolute: string;
  content: string;
  size: number;
  truncated: boolean;
}

export function readProjectFile(app: HeliosApp, project: Project, input: string): FileContent {
  const resolved = resolveProjectPath(app, project, input);
  if (!resolved.relative) throw new HttpError(400, "A file path is required.");
  if (isSensitivePath(resolved.relative)) {
    throw new HttpError(403, "Refusing to expose a sensitive file (credentials or key material).");
  }
  if (!existsSync(resolved.absolute)) throw new HttpError(404, `File ${resolved.relative} not found.`);
  const stat = statSync(resolved.absolute);
  if (!stat.isFile()) throw new HttpError(400, `${resolved.relative} is not a file.`);
  const limit = app.config.limits.maxFileBytes;
  const buffer = readFileSync(resolved.absolute);
  const truncated = buffer.length > limit;
  const slice = truncated ? buffer.subarray(0, limit) : buffer;
  if (slice.includes(0)) throw new HttpError(415, "Binary files cannot be displayed in the editor.");
  return {
    path: resolved.relative,
    absolute: resolved.absolute,
    content: slice.toString("utf8"),
    size: buffer.length,
    truncated,
  };
}

export function writeProjectFile(
  app: HeliosApp,
  project: Project,
  input: string,
  content: string,
): { path: string; size: number } {
  if (!input) throw new HttpError(400, "A file path is required.");
  const resolved = resolveProjectPath(app, project, input);
  if (!resolved.relative) throw new HttpError(400, "A file path is required.");
  if (isSensitivePath(resolved.relative)) {
    throw new HttpError(403, "Refusing to write a sensitive file through the editor API.");
  }
  if (content.length > 2_000_000) throw new HttpError(400, "File content exceeds 2 MB.");
  mkdirSync(dirname(resolved.absolute), { recursive: true });
  writeFileSync(resolved.absolute, content, "utf8");
  return { path: resolved.relative, size: Buffer.byteLength(content, "utf8") };
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: TreeEntry[];
}

export function listProjectDirectory(
  app: HeliosApp,
  project: Project,
  input: string,
): { path: string; entries: TreeEntry[] } {
  const resolved = resolveProjectPath(app, project, input || ".");
  if (!existsSync(resolved.absolute)) throw new HttpError(404, "Directory not found.");
  if (!statSync(resolved.absolute).isDirectory()) throw new HttpError(400, "Path is not a directory.");
  const entries = readdirSync(resolved.absolute, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name))
    .map((entry) => {
      const path = resolved.relative ? `${resolved.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return { name: entry.name, path, type: "directory" as const };
      let size = 0;
      try {
        size = statSync(join(resolved.absolute, entry.name)).size;
      } catch {
        // unreadable entries are listed without size
      }
      return { name: entry.name, path, type: "file" as const, size };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  return { path: resolved.relative, entries };
}

export function projectTree(
  app: HeliosApp,
  project: Project,
  input: string,
  depth: number,
): TreeEntry[] {
  const resolved = resolveProjectPath(app, project, input || ".");
  const walk = (absolute: string, relative: string, remaining: number): TreeEntry[] => {
    if (remaining <= 0) return [];
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(
        (entry) =>
          !entry.name.startsWith(".") &&
          !SKIP_DIRS.has(entry.name) &&
          entry.name !== ".DS_Store",
      )
      .slice(0, 400)
      .map((entry) => {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            path,
            type: "directory" as const,
            children: walk(join(absolute, entry.name), path, remaining - 1),
          };
        }
        let size = 0;
        try {
          size = statSync(join(absolute, entry.name)).size;
        } catch {
          // ignore
        }
        return { name: entry.name, path, type: "file" as const, size };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  };
  return walk(resolved.absolute, resolved.relative, Math.max(1, Math.min(depth, 6)));
}

export function projectFromPath(app: HeliosApp, rootPath: string, name?: string) {
  const absolute = resolve(rootPath);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new HttpError(400, `Project path does not exist or is not a directory: ${absolute}`);
  }
  return app.store.upsertProject(absolute, name?.trim() || basename(absolute));
}

export function eventStreamPayload(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
