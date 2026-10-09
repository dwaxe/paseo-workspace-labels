import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { EngineState } from "./engine";

const MAX_STATE_BYTES = 4 * 1024 * 1024;

export function defaultStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PASEO_WORKSPACE_LABELS_STATE_DIR) {
    if (!path.isAbsolute(env.PASEO_WORKSPACE_LABELS_STATE_DIR)) {
      throw new Error(
        "PASEO_WORKSPACE_LABELS_STATE_DIR must be an absolute path.",
      );
    }
    return env.PASEO_WORKSPACE_LABELS_STATE_DIR;
  }
  const daemonHome = path.resolve(
    env.PASEO_HOME || path.join(homedir(), ".paseo"),
  );
  const hostKey = createHash("sha256")
    .update(daemonHome)
    .digest("hex")
    .slice(0, 16);
  const stateHome =
    env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : path.join(homedir(), ".local", "state");
  return path.join(stateHome, "paseo-workspace-labels", hostKey);
}

function assertPrivate(stats: Stats) {
  if (typeof process.getuid === "function") {
    if (stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0) {
      throw new Error(
        "Workspace label state must be owned by you and private.",
      );
    }
  }
}

export class FileStateStore {
  constructor(private readonly directory: string) {}

  private async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(
        "Workspace label state directory must be a real directory.",
      );
    }
    assertPrivate(stats);
  }

  async load(): Promise<unknown> {
    await this.ensureDirectory();
    const filename = path.join(this.directory, "state.json");
    let handle;
    try {
      const before = await lstat(filename);
      if (before.isSymbolicLink() || !before.isFile())
        throw new Error("Invalid workspace label state file.");
      assertPrivate(before);
      handle = await open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
      );
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.dev !== before.dev ||
        stats.ino !== before.ino ||
        stats.size > MAX_STATE_BYTES
      ) {
        throw new Error("Invalid workspace label state file.");
      }
      assertPrivate(stats);
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content) > MAX_STATE_BYTES)
        throw new Error("Workspace label state is too large.");
      const parsed: unknown = JSON.parse(content);
      if (parsed === null) {
        throw new Error(
          "Saved naming state is invalid. No workspace names were changed.",
        );
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async save(state: EngineState): Promise<void> {
    await this.ensureDirectory();
    const content = JSON.stringify(state) + "\n";
    if (Buffer.byteLength(content) > MAX_STATE_BYTES)
      throw new Error("Workspace label state is too large.");
    const temporary = path.join(this.directory, ".state-" + randomUUID());
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, path.join(this.directory, "state.json"));
      if (process.platform !== "win32") {
        const directoryHandle = await open(this.directory, constants.O_RDONLY);
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
