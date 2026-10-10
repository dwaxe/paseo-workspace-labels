import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PaseoApi,
  PaseoAgent,
  PaseoAgentUpdate,
  PaseoWorkspace,
} from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { labelSettings, type LabelSettings } from "../shared/contracts";
import { agentView, LabelRuntime, readBranch, workspaceView } from "./runtime";

const runtimes: LabelRuntime[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function agent(overrides: Partial<PaseoAgent> = {}): PaseoAgent {
  return {
    id: "a1",
    workspaceId: "w1",
    title: "Improve search",
    createdAt: "2026-01-01T00:00:00Z",
    status: "idle",
    labels: {},
    ...overrides,
  } as PaseoAgent;
}
function workspace(overrides: Partial<PaseoWorkspace> = {}): PaseoWorkspace {
  return {
    id: "w1",
    workspaceDirectory: "/checkouts/alpha",
    name: "alpha",
    title: "alpha",
    ...overrides,
  } as PaseoWorkspace;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-label-runtime-"));
  roots.push(root);
  let config: LabelSettings = {
    workspaces: [
      {
        workspaceId: "w1",
        alias: "alpha",
        mode: "conversation",
        enabled: true,
        generation: 0,
      },
    ],
  };
  const currentWorkspace = workspace();
  const agents = [
    agent(),
    agent({
      id: "child",
      title: "Private child",
      createdAt: "2026-02-01T00:00:00Z",
      labels: { "paseo.parent-agent-id": "a1" },
    }),
  ];
  const rename = vi.fn(async (_title: string) => {
    currentWorkspace.title = _title;
    currentWorkspace.name = _title;
  });
  const streams: {
    release: ReturnType<typeof vi.fn>;
  }[] = [];
  const listeners = { agent: vi.fn(), workspace: vi.fn() };
  let onAgentUpdate: (update: PaseoAgentUpdate) => void = () => {};
  const subscription = () => {
    const stream = { release: vi.fn(async () => {}) };
    streams.push(stream);
    return { release: stream.release, subscribe: () => () => {} };
  };
  const agentList = vi.fn(
    async (options: { subscribe?: object; page?: { cursor?: string } }) => ({
      entries: agents.map((value) => ({ agent: structuredClone(value) })),
      pageInfo: { hasMore: false, nextCursor: null as string | null },
      ...(options.subscribe ? { subscription: subscription() } : {}),
    }),
  );
  const api = {
    agents: {
      list: agentList,
      subscribe: (listener: typeof onAgentUpdate) => {
        onAgentUpdate = listener;
        return listeners.agent;
      },
    },
    workspaces: {
      list: async (options: { subscribe?: object }) => ({
        entries: [structuredClone(currentWorkspace)],
        pageInfo: { hasMore: false, nextCursor: null },
        ...(options.subscribe ? { subscription: subscription() } : {}),
      }),
      subscribe: () => listeners.workspace,
      ref: () => ({
        refresh: async () => structuredClone(currentWorkspace),
        setTitle: rename,
      }),
    },
  } as unknown as PaseoApi;
  const settings = {
    read: async () => ({
      status: "ready",
      revision: "r1",
      values: structuredClone(config),
    }),
  } as PluginSettings<typeof labelSettings.schema>;
  const runtime = new LabelRuntime(settings, path.join(root, "state"));
  runtimes.push(runtime);
  return {
    runtime,
    api,
    agents,
    currentWorkspace,
    rename,
    streams,
    listeners,
    agentList,
    emitAgent: (value: PaseoAgent) =>
      onAgentUpdate({ kind: "upsert", agent: value } as PaseoAgentUpdate),
    settings,
    stateDirectory: path.join(root, "state"),
    setConfig: (value: LabelSettings) => {
      config = value;
    },
  };
}

describe("Paseo SDK wiring", () => {
  it.each(["", "  "])(
    "follows a root conversation with a blank parent label (%j)",
    async (parent) => {
      const f = await fixture();
      f.agents[0].labels["paseo.parent-agent-id"] = parent;
      const result = await f.runtime.inspect(f.api);
      expect(result.agents.map((item) => item.id)).toEqual(["a1"]);
      expect(result.statuses[0].state).toBe("ready");
      expect(f.rename).toHaveBeenCalledExactlyOnceWith(
        "Improve search · alpha",
      );
    },
  );

  it("reads the workspace branch instead of an inherited Git directory", async () => {
    const requested = await fixture();
    const unrelated = await fixture();
    const cwd = path.dirname(requested.stateDirectory);
    const other = path.dirname(unrelated.stateDirectory);
    execFileSync("git", ["init", "--quiet", "-b", "owner/requested-task", cwd]);
    execFileSync("git", [
      "init",
      "--quiet",
      "-b",
      "owner/unrelated-task",
      other,
    ]);
    vi.stubEnv("GIT_DIR", path.join(other, ".git"));
    try {
      expect(await readBranch(cwd)).toBe("refs/heads/owner/requested-task");
      expect(process.env.GIT_DIR).toBe(path.join(other, ".git"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the same branch ref when a matching tag is added", async () => {
    const f = await fixture();
    const cwd = path.dirname(f.stateDirectory);
    execFileSync("git", ["init", "--quiet", "-b", "release/v1.3.0", cwd]);
    execFileSync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Initialize test",
    ]);
    const before = await readBranch(cwd);
    execFileSync("git", ["-C", cwd, "tag", "release/v1.3.0"]);
    expect(await readBranch(cwd)).toBe(before);
    expect(before).toBe("refs/heads/release/v1.3.0");
  });

  it("uses the snapshot parent label and exact workspace directory", () => {
    expect(
      agentView(agent({ labels: { "paseo.parent-agent-id": "parent" } }))
        .parentAgentId,
    ).toBe("parent");
    expect(agentView(agent()).parentAgentId).toBeNull();
    expect(
      workspaceView(workspace({ workspaceDirectory: undefined })),
    ).toBeNull();
    expect(
      workspaceView(workspace({ archivingAt: "2026-02-01" }))?.archived,
    ).toBe(true);
  });

  it("boots both streams, follows an eligible root title, and releases observations", async () => {
    const f = await fixture();
    const result = await f.runtime.inspect(f.api);
    expect(f.rename).toHaveBeenCalledExactlyOnceWith("Improve search · alpha");
    expect(result.agents.map((item) => item.id)).toEqual(["a1"]);
    expect(result.statuses[0].state).toBe("ready");
    await f.runtime.inspect(f.api);
    expect(f.streams).toHaveLength(2);
    expect(f.rename).toHaveBeenCalledTimes(1);
    await f.runtime.stop();
    for (const stream of f.streams) {
      expect(stream.release).toHaveBeenCalledTimes(1);
    }
    expect(f.listeners.agent).toHaveBeenCalledTimes(1);
    expect(f.listeners.workspace).toHaveBeenCalledTimes(1);
  });

  it("finishes pre-write cleanup before a replacement runtime can start", async () => {
    const f = await fixture();
    await f.runtime.inspect(f.api);
    f.agents[0].title = "Another task";
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.agentList.getMockImplementation()!;
    f.agentList.mockImplementationOnce(original);
    f.agentList.mockImplementationOnce(async (options) => {
      entered();
      await blocked;
      return original(options);
    });
    const inFlight = f.runtime.inspect(f.api).catch(() => null);
    await reached;
    const stopped = vi.fn();
    const stopping = f.runtime.stop().then(stopped);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([stopping, inFlight]);
    }
    f.currentWorkspace.title = "Another task · alpha";
    f.agents[0].title = "Latest work";
    const replacement = new LabelRuntime(f.settings, f.stateDirectory);
    runtimes.push(replacement);
    expect((await replacement.inspect(f.api)).statuses[0].state).toBe("paused");
    expect(f.rename).toHaveBeenCalledTimes(1);
  });

  it("follows a detached child without waiting for its next turn", async () => {
    const f = await fixture();
    await f.runtime.inspect(f.api);
    expect(f.currentWorkspace.title).toBe("Improve search · alpha");
    f.agents[1].labels = {};
    const result = await f.runtime.inspect(f.api);
    expect(result.agents.map((item) => item.id)).toEqual(["a1", "child"]);
    expect(f.currentWorkspace.title).toBe("Private child · alpha");
    expect(f.rename).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "keeps branch workspaces usable during conversation outages (connected: %s)",
    async (connected) => {
      const f = await fixture();
      const cwd = path.dirname(f.stateDirectory);
      execFileSync("git", ["init", "--quiet", "-b", "dwaxe/fix-export", cwd]);
      f.currentWorkspace.workspaceDirectory = cwd;
      if (connected) await f.runtime.inspect(f.api);
      f.setConfig({
        workspaces: [
          {
            workspaceId: "w1",
            alias: "alpha",
            mode: "branch",
            enabled: true,
            generation: 1,
          },
        ],
      });
      f.runtime.settingsChanged();
      f.agentList.mockRejectedValue(new Error("Conversation list unavailable"));
      const result = await f.runtime.inspect(f.api);
      expect(result.agents).toEqual([]);
      expect(result.agentsError).toBe(
        "Could not load conversations. Try again.",
      );
      expect(result.workspaces[0].workspaceId).toBe("w1");
      expect(result.statuses[0].state).toBe("ready");
      expect(f.currentWorkspace.title).toBe("fix export · alpha");
    },
  );

  it("refreshes when only a conversation's internal label changes", async () => {
    const f = await fixture();
    await f.runtime.inspect(f.api);
    f.emitAgent(structuredClone(f.agents[0]));
    const schedule = vi.spyOn(f.runtime, "schedule");
    f.agents[0].labels["paseo.internal"] = "true";
    f.emitAgent(structuredClone(f.agents[0]));
    expect(schedule).toHaveBeenCalledOnce();
    expect((await f.runtime.inspect(f.api)).statuses[0].state).toBe("waiting");
  });

  it("pauses on an externally changed title and resumes only after explicit settings change", async () => {
    const f = await fixture();
    await f.runtime.inspect(f.api);
    f.currentWorkspace.title = "My name";
    f.currentWorkspace.name = "My name";
    expect((await f.runtime.inspect(f.api)).statuses[0].state).toBe("paused");
    expect(f.rename).toHaveBeenCalledTimes(1);
    f.setConfig({
      workspaces: [
        {
          workspaceId: "w1",
          alias: "alpha",
          mode: "conversation",
          enabled: true,
          generation: 1,
        },
      ],
    });
    f.runtime.settingsChanged();
    await f.runtime.inspect(f.api);
    expect(f.rename).toHaveBeenCalledTimes(2);
  });

  it("does not rename an enrollment disabled during a slow source read", async () => {
    const f = await fixture();
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.agentList.getMockImplementation()!;
    f.agentList.mockImplementation(async (options) => {
      if (!options.subscribe) {
        reached();
        await blocked;
      }
      return original(options);
    });
    const inFlight = f.runtime.inspect(f.api);
    await entered;
    f.setConfig({
      workspaces: [
        {
          workspaceId: "w1",
          alias: "alpha",
          mode: "conversation",
          enabled: false,
          generation: 0,
        },
      ],
    });
    f.runtime.settingsChanged();
    release();
    await inFlight;
    await f.runtime.inspect(f.api);
    expect(f.rename).not.toHaveBeenCalled();
  });

  it("finishes a slow naming update before coalescing another refresh", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.agentList.getMockImplementation()!;
    f.agentList.mockImplementation(async (options) => {
      if (!options.subscribe) {
        reached();
        await blocked;
      }
      return original(options);
    });
    const read = vi.spyOn(f.settings, "read");
    try {
      const inFlight = f.runtime.inspect(f.api);
      await entered;
      await vi.advanceTimersByTimeAsync(350);
      expect(read).toHaveBeenCalledTimes(1);
      release();
      await inFlight;
      expect(f.rename).toHaveBeenCalledExactlyOnceWith(
        "Improve search · alpha",
      );
      await vi.advanceTimersByTimeAsync(350);
      await f.runtime.inspect(f.api);
      expect(read.mock.calls.length).toBeGreaterThan(1);
      expect(f.rename).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await f.runtime.stop();
      vi.useRealTimers();
    }
  });

  it("does not confuse branch-derived display names with explicit manual renames", async () => {
    const f = await fixture();
    f.currentWorkspace.title = null;
    f.currentWorkspace.name = "old branch";
    f.agents[0].title = "Untitled";
    expect((await f.runtime.inspect(f.api)).statuses[0].state).toBe("waiting");
    f.currentWorkspace.name = "new branch";
    f.agents[0].title = "Improve search";
    expect((await f.runtime.inspect(f.api)).statuses[0].state).toBe("ready");
    expect(f.rename).toHaveBeenCalledExactlyOnceWith("Improve search · alpha");
  });

  it("keeps a manual title when recovery state becomes JSON null", async () => {
    const f = await fixture();
    await f.runtime.inspect(f.api);
    f.currentWorkspace.title = "My name";
    f.currentWorkspace.name = "My name";
    expect((await f.runtime.inspect(f.api)).statuses[0].state).toBe("paused");
    await writeFile(path.join(f.stateDirectory, "state.json"), "null\n", {
      mode: 0o600,
    });
    expect((await f.runtime.inspect(f.api)).statuses[0].state).toBe("error");
    expect(f.rename).toHaveBeenCalledTimes(1);
    expect(f.currentWorkspace.title).toBe("My name");
  });

  it("stops safely if conversation pagination repeats a cursor", async () => {
    const f = await fixture();
    const original = f.agentList.getMockImplementation()!;
    f.agentList.mockImplementation(async (options) => ({
      ...(await original(options)),
      pageInfo: { hasMore: true, nextCursor: "same" },
    }));
    const result = await f.runtime.inspect(f.api);
    expect(result.agents).toEqual([]);
    expect(result.agentsError).toBe("Could not load conversations. Try again.");
    expect(result.statuses[0]).toMatchObject({
      state: "error",
      message: "Conversation list pagination did not advance.",
    });
    expect(f.rename).not.toHaveBeenCalled();
  });
});
