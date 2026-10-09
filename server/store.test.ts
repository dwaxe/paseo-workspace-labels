import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultStateDirectory, FileStateStore } from "./store";
import type { EngineState } from "./engine";

const roots: string[] = [];
const empty: EngineState = { version: 1, records: {} };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-label-store-"));
  roots.push(root);
  const directory = path.join(root, "state");
  return { root, directory, store: new FileStateStore(directory) };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("private state persistence", () => {
  it("starts empty and round-trips an atomic private state file", async () => {
    const { directory, store } = await fixture();
    expect(await store.load()).toBeNull();
    await store.save(empty);
    expect(await store.load()).toEqual(empty);
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect(
        (await lstat(path.join(directory, "state.json"))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("preserves and reports a corrupt state file", async () => {
    const { directory, store } = await fixture();
    await store.load();
    await writeFile(path.join(directory, "state.json"), "broken", {
      mode: 0o600,
    });
    await expect(store.load()).rejects.toThrow();
    expect(await readFile(path.join(directory, "state.json"), "utf8")).toBe(
      "broken",
    );
  });

  it("distinguishes a missing file from JSON null corruption", async () => {
    const { directory, store } = await fixture();
    expect(await store.load()).toBeNull();
    await writeFile(path.join(directory, "state.json"), "null\n", {
      mode: 0o600,
    });
    await expect(store.load()).rejects.toThrow("Saved naming state is invalid");
    expect(await readFile(path.join(directory, "state.json"), "utf8")).toBe(
      "null\n",
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlinked state directories",
    async () => {
      const { root, directory, store } = await fixture();
      const target = path.join(root, "elsewhere");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, directory);
      await expect(store.load()).rejects.toThrow("real directory");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses symlinked state files without changing their target",
    async () => {
      const { root, directory, store } = await fixture();
      await store.load();
      const target = path.join(root, "target");
      await writeFile(target, "untouched", { mode: 0o600 });
      await symlink(target, path.join(directory, "state.json"));
      await expect(store.load()).rejects.toThrow("Invalid");
      expect(await readFile(target, "utf8")).toBe("untouched");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses public state files",
    async () => {
      const { directory, store } = await fixture();
      await store.save(empty);
      await chmod(path.join(directory, "state.json"), 0o644);
      await expect(store.load()).rejects.toThrow("private");
    },
  );

  it("separates custom daemon homes and rejects relative overrides", () => {
    expect(defaultStateDirectory({ PASEO_HOME: "/daemon/one" })).not.toBe(
      defaultStateDirectory({ PASEO_HOME: "/daemon/two" }),
    );
    expect(
      defaultStateDirectory({
        PASEO_WORKSPACE_LABELS_STATE_DIR: "/custom/state",
      }),
    ).toBe("/custom/state");
    expect(() =>
      defaultStateDirectory({ PASEO_WORKSPACE_LABELS_STATE_DIR: "relative" }),
    ).toThrow("absolute");
  });
});
