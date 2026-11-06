import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HeliosPaths {
  home: string;
  dbPath: string;
  configPath: string;
  secretsPath: string;
  secretKeyPath: string;
  checkpointsDir: string;
  logsDir: string;
}

export function resolveHeliosPaths(overrideHome?: string): HeliosPaths {
  const home = resolve(overrideHome ?? process.env.HELIOS_HOME ?? join(homedir(), ".helios"));
  return {
    home,
    dbPath: join(home, "helios.db"),
    configPath: join(home, "config.json"),
    secretsPath: join(home, "secrets.json"),
    secretKeyPath: join(home, "secret.key"),
    checkpointsDir: join(home, "checkpoints"),
    logsDir: join(home, "logs"),
  };
}

export function ensureHeliosDirs(paths: HeliosPaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.checkpointsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
}
