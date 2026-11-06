import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { HeliosPaths } from "./paths";

interface SecretEntry {
  iv: string;
  tag: string;
  data: string;
}

interface SecretFile {
  version: 1;
  entries: Record<string, SecretEntry>;
}

/**
 * Encrypted credential storage. Keys are AES-256-GCM encrypted at rest with a
 * local key file (0600) or a scrypt-derived key from HELIOS_SECRET.
 */
export class SecretStore {
  private cache: SecretFile | null = null;
  private key: Buffer | null = null;

  constructor(private readonly paths: HeliosPaths) {}

  private loadKey(): Buffer {
    if (this.key) return this.key;
    const envSecret = process.env.HELIOS_SECRET;
    if (envSecret && envSecret.length > 0) {
      this.key = scryptSync(envSecret, "helios-secret-store-v1", 32);
      return this.key;
    }
    const path = this.paths.secretKeyPath;
    if (existsSync(path)) {
      this.key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
      if (this.key.length !== 32) {
        throw new Error(`Invalid Project Helios secret key length in ${path}`);
      }
      return this.key;
    }
    const generated = randomBytes(32);
    writeFileSync(path, generated.toString("base64"), { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
    this.key = generated;
    return generated;
  }

  private load(): SecretFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.paths.secretsPath)) {
      this.cache = { version: 1, entries: {} };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.paths.secretsPath, "utf8")) as SecretFile;
      this.cache = parsed && parsed.version === 1 ? parsed : { version: 1, entries: {} };
    } catch {
      this.cache = { version: 1, entries: {} };
    }
    return this.cache;
  }

  private persist(file: SecretFile): void {
    const tmp = `${this.paths.secretsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.paths.secretsPath);
    try {
      chmodSync(this.paths.secretsPath, 0o600);
    } catch {
      // best-effort
    }
    this.cache = file;
  }

  get(providerId: string): string | null {
    const entry = this.load().entries[providerId];
    if (!entry) return null;
    try {
      const key = this.loadKey();
      const iv = Buffer.from(entry.iv, "base64");
      const tag = Buffer.from(entry.tag, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(Buffer.from(entry.data, "base64")),
        decipher.final(),
      ]);
      return plain.toString("utf8");
    } catch {
      return null;
    }
  }

  set(providerId: string, apiKey: string): void {
    const file = this.load();
    const key = this.loadKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    file.entries[providerId] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    this.persist(file);
  }

  delete(providerId: string): void {
    const file = this.load();
    if (file.entries[providerId]) {
      delete file.entries[providerId];
      this.persist(file);
    }
  }

  list(): string[] {
    return Object.keys(this.load().entries);
  }

  /** Resolves a provider key from the encrypted store, then its configured env var. */
  resolve(providerId: string, apiKeyEnv?: string): string | null {
    const stored = this.get(providerId);
    if (stored) return stored;
    if (apiKeyEnv && process.env[apiKeyEnv]) return process.env[apiKeyEnv] ?? null;
    return null;
  }

  has(providerId: string, apiKeyEnv?: string): boolean {
    return this.resolve(providerId, apiKeyEnv) !== null;
  }
}
