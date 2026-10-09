import { describe, expect, it, vi } from "vitest";
import type { AgentView, Enrollment, WorkspaceView } from "../shared/contracts";
import {
  LabelEngine,
  parseEngineState,
  type EnginePorts,
  type EngineState,
} from "./engine";

function enrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    workspaceId: "workspace",
    alias: "alpha",
    mode: "conversation",
    enabled: true,
    generation: 0,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: "current",
    workspaceId: "workspace",
    title: "Fix sidebar navigation",
    createdAt: "2026-01-02T00:00:00Z",
    parentAgentId: null,
    archived: false,
    closed: false,
    internal: false,
    ...overrides,
  };
}

function fixture() {
  const data: {
    saved: unknown;
    workspace: WorkspaceView | null;
    agents: AgentView[];
    branch: string | null;
  } = {
    saved: null,
    workspace: {
      id: "workspace",
      cwd: "/checkout",
      title: "alpha",
      archived: false,
    },
    agents: [agent()],
    branch: "owner/proj-123-sidebar-navigation",
  };
  const ports = {
    load: vi.fn(async () => structuredClone(data.saved)),
    save: vi.fn(async (state: EngineState) => {
      data.saved = structuredClone(state);
    }),
    workspace: vi.fn(async (_id: string) => structuredClone(data.workspace)),
    agents: vi.fn(async (_id: string) => structuredClone(data.agents)),
    branch: vi.fn(async (_cwd: string) => data.branch),
    rename: vi.fn(async (_id: string, title: string) => {
      if (data.workspace) data.workspace.title = title;
    }),
  } satisfies EnginePorts;
  return { data, ports, engine: new LabelEngine(ports) };
}

function savedRecord(data: ReturnType<typeof fixture>["data"]) {
  return (data.saved as EngineState).records.workspace;
}

describe("opt-in workspace naming", () => {
  it("persists intent before mutation and confirms the resulting name", async () => {
    const { data, ports, engine } = fixture();
    ports.rename.mockImplementation(async (_id, title) => {
      expect(savedRecord(data).pending?.title).toBe(title);
      expect(savedRecord(data).lastApplied).toBe("alpha");
      data.workspace!.title = title;
    });
    expect(await engine.reconcile([enrollment()])).toEqual([
      {
        workspaceId: "workspace",
        state: "ready",
        message: "Workspace name updated.",
        preview: "Fix sidebar navigation · alpha",
        sourceAgentId: "current",
      },
    ]);
    expect(savedRecord(data).lastApplied).toBe(
      "Fix sidebar navigation · alpha",
    );
    expect(savedRecord(data).pending).toBeNull();
    expect(ports.rename).toHaveBeenCalledWith(
      "workspace",
      "Fix sidebar navigation · alpha",
    );
  });

  it("performs no write for an already current name", async () => {
    const { ports, engine } = fixture();
    await engine.reconcile([enrollment()]);
    ports.rename.mockClear();
    ports.save.mockClear();
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("ready");
    expect(ports.rename).not.toHaveBeenCalled();
    expect(ports.save).not.toHaveBeenCalled();
  });

  it("never touches disabled or unregistered workspaces", async () => {
    const { data, ports, engine } = fixture();
    expect(await engine.reconcile([])).toEqual([]);
    expect(
      (await engine.reconcile([enrollment({ enabled: false })]))[0].state,
    ).toBe("disabled");
    expect(ports.workspace).not.toHaveBeenCalled();
    expect(ports.rename).not.toHaveBeenCalled();
    expect(data.saved).toBeNull();
  });

  it.each(["missing", "archived", "different ID"])(
    "skips %s workspaces",
    async (kind) => {
      const { data, ports, engine } = fixture();
      if (kind === "missing") data.workspace = null;
      else if (kind === "archived") data.workspace!.archived = true;
      else data.workspace!.id = "other";
      expect((await engine.reconcile([enrollment()]))[0].state).toBe("error");
      expect(ports.rename).not.toHaveBeenCalled();
    },
  );

  it("does not fall back from a newest generic or missing title", async () => {
    const { data, ports, engine } = fixture();
    data.agents = [
      agent({ id: "old", createdAt: "2025-01-01T00:00:00Z" }),
      agent({ title: "New chat" }),
    ];
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("waiting");
    data.agents[1].title = null;
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("waiting");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("uses only an eligible pinned conversation", async () => {
    const { data, ports, engine } = fixture();
    data.agents.push(
      agent({
        id: "pinned",
        title: "Review navigation",
        createdAt: "2025-01-01T00:00:00Z",
      }),
    );
    await engine.reconcile([enrollment({ agentId: "pinned" })]);
    expect(data.workspace!.title).toBe("Review navigation · alpha");
    ports.rename.mockClear();
    data.agents[1].archived = true;
    expect(
      (await engine.reconcile([enrollment({ agentId: "pinned" })]))[0].state,
    ).toBe("waiting");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("formats the branch only in branch mode and waits at detached HEAD", async () => {
    const { data, ports, engine } = fixture();
    await engine.reconcile([enrollment({ mode: "branch" })]);
    expect(data.workspace!.title).toBe("PROJ-123 sidebar navigation · alpha");
    expect(ports.agents).not.toHaveBeenCalled();
    ports.rename.mockClear();
    data.branch = null;
    expect(
      (await engine.reconcile([enrollment({ mode: "branch" })]))[0].state,
    ).toBe("waiting");
    expect(ports.rename).not.toHaveBeenCalled();
  });
});

describe("manual control and durable state", () => {
  it("keeps manual edits paused across restarts until explicit resume", async () => {
    const { data, ports, engine } = fixture();
    await engine.reconcile([enrollment()]);
    data.workspace!.title = "My custom name";
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("paused");
    ports.rename.mockClear();
    const restarted = new LabelEngine(ports);
    expect(
      (await restarted.reconcile([enrollment({ alias: "beta" })]))[0].state,
    ).toBe("paused");
    expect(ports.rename).not.toHaveBeenCalled();
    expect(
      (
        await restarted.reconcile([
          enrollment({ alias: "beta", generation: 1 }),
        ])
      )[0].state,
    ).toBe("ready");
    expect(data.workspace!.title).toBe("Fix sidebar navigation · beta");
  });

  it("forgets disabled and removed enrollments before reenrollment", async () => {
    const { data, ports, engine } = fixture();
    await engine.reconcile([enrollment()]);
    await engine.reconcile([enrollment({ enabled: false })]);
    expect(Object.keys((data.saved as EngineState).records)).toEqual([]);
    data.workspace!.title = "Manual title while disabled";
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("ready");
    await engine.reconcile([]);
    expect(Object.keys((data.saved as EngineState).records)).toEqual([]);
    expect(ports.rename).toHaveBeenCalledTimes(2);
  });

  it("refuses relocated workspaces even when resume is requested", async () => {
    const { data, ports, engine } = fixture();
    await engine.reconcile([enrollment()]);
    data.workspace!.cwd = "/other-checkout";
    ports.rename.mockClear();
    expect(
      (await engine.reconcile([enrollment({ generation: 1 })]))[0].state,
    ).toBe("error");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { version: 2, records: {} },
    { version: 1, records: { workspace: {} } },
    { version: 1, records: {}, surprise: true },
  ])("fails closed for corrupt state %j", async (corrupt) => {
    const { data, ports, engine } = fixture();
    data.saved = corrupt;
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("error");
    expect(ports.save).not.toHaveBeenCalled();
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("rejects a corrupt unenrolled record rather than silently discarding it", async () => {
    const { data, ports, engine } = fixture();
    data.saved = { version: 1, records: { obsolete: { paused: "yes" } } };
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("error");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("accepts absent state while strictly validating pending records", async () => {
    expect(parseEngineState(undefined).version).toBe(1);
    const { data, engine } = fixture();
    await engine.reconcile([enrollment()]);
    savedRecord(data).pending = { title: "Next", sourceFingerprint: "bad" };
    expect(() => parseEngineState(data.saved)).toThrow(
      "Saved naming state is invalid",
    );
  });
});

describe("failure recovery and observation races", () => {
  it("recovers a successful rename whose command acknowledgement was lost", async () => {
    const { data, ports, engine } = fixture();
    ports.rename.mockImplementationOnce(async (_id, title) => {
      data.workspace!.title = title;
      throw new Error("Connection lost after write");
    });
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("error");
    expect(savedRecord(data).pending).not.toBeNull();
    expect(
      (await new LabelEngine(ports).reconcile([enrollment()]))[0].state,
    ).toBe("ready");
    expect(savedRecord(data).paused).toBe(false);
    expect(savedRecord(data).pending).toBeNull();
    expect(ports.rename).toHaveBeenCalledTimes(1);
  });

  it("recovers failed readback without mistaking its own title for a manual edit", async () => {
    const { data, ports, engine } = fixture();
    ports.workspace.mockImplementationOnce(async () =>
      structuredClone(data.workspace),
    );
    ports.workspace.mockImplementationOnce(async () =>
      structuredClone(data.workspace),
    );
    ports.workspace.mockRejectedValueOnce(new Error("Readback unavailable"));
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("error");
    expect(
      (await new LabelEngine(ports).reconcile([enrollment()]))[0].state,
    ).toBe("ready");
    expect(savedRecord(data).paused).toBe(false);
    expect(ports.rename).toHaveBeenCalledTimes(1);
  });

  it("retries an unconfirmed failed rename from its unchanged baseline", async () => {
    const { ports, engine } = fixture();
    ports.rename.mockRejectedValueOnce(new Error("Rename unavailable"));
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("error");
    expect(
      (await new LabelEngine(ports).reconcile([enrollment()]))[0].state,
    ).toBe("ready");
    expect(ports.rename).toHaveBeenCalledTimes(2);
  });

  it("preserves a manual rename after an uncertain result", async () => {
    const { data, ports, engine } = fixture();
    ports.rename.mockRejectedValueOnce(new Error("Rename unavailable"));
    await engine.reconcile([enrollment()]);
    data.workspace!.title = "Manual after failure";
    expect(
      (await new LabelEngine(ports).reconcile([enrollment()]))[0].state,
    ).toBe("paused");
    expect(ports.rename).toHaveBeenCalledTimes(1);
  });

  it("prevents mutation when initial or intent state cannot be persisted", async () => {
    const initial = fixture();
    initial.ports.save.mockRejectedValueOnce(new Error("Disk full"));
    expect((await initial.engine.reconcile([enrollment()]))[0].state).toBe(
      "error",
    );
    expect(initial.ports.rename).not.toHaveBeenCalled();
    const intent = fixture();
    intent.ports.save.mockImplementationOnce(async (state) => {
      intent.data.saved = structuredClone(state);
    });
    intent.ports.save.mockRejectedValueOnce(new Error("Disk full"));
    expect((await intent.engine.reconcile([enrollment()]))[0].state).toBe(
      "error",
    );
    expect(intent.ports.rename).not.toHaveBeenCalled();
  });

  it("recovers a completed rename if final state persistence fails", async () => {
    const { data, ports, engine } = fixture();
    ports.save.mockImplementationOnce(async (state) => {
      data.saved = structuredClone(state);
    });
    ports.save.mockImplementationOnce(async (state) => {
      data.saved = structuredClone(state);
    });
    ports.save.mockRejectedValueOnce(new Error("Disk full"));
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("error");
    expect(
      (await new LabelEngine(ports).reconcile([enrollment()]))[0].state,
    ).toBe("ready");
    expect(savedRecord(data).paused).toBe(false);
    expect(ports.rename).toHaveBeenCalledTimes(1);
  });

  it("pauses for a manual edit during source observation", async () => {
    const { data, ports, engine } = fixture();
    ports.agents.mockImplementationOnce(async () => {
      data.workspace!.title = "My manual title";
      return structuredClone(data.agents);
    });
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("paused");
    expect(data.workspace!.title).toBe("My manual title");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("pauses for a manual edit while intent is persisted", async () => {
    const { data, ports, engine } = fixture();
    ports.save.mockImplementationOnce(async (state) => {
      data.saved = structuredClone(state);
    });
    ports.save.mockImplementationOnce(async (state) => {
      data.saved = structuredClone(state);
      data.workspace!.title = "Manual during save";
    });
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("paused");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("waits if the selected source changes before writing", async () => {
    const { data, ports, engine } = fixture();
    ports.agents.mockImplementationOnce(async () =>
      structuredClone(data.agents),
    );
    ports.agents.mockImplementationOnce(async () => {
      data.agents.push(
        agent({
          id: "newer",
          title: "A new task",
          createdAt: "2026-02-01T00:00:00Z",
        }),
      );
      return structuredClone(data.agents);
    });
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("waiting");
    expect(ports.rename).not.toHaveBeenCalled();
    expect(savedRecord(data).pending).toBeNull();
    expect((await engine.reconcile([enrollment()]))[0].preview).toBe(
      "A new task · alpha",
    );
  });

  it("waits when a branch changes during the final source guard", async () => {
    const { ports, engine } = fixture();
    ports.branch.mockResolvedValueOnce("owner/first-task");
    ports.branch.mockResolvedValueOnce("owner/second-task");
    expect(
      (await engine.reconcile([enrollment({ mode: "branch" })]))[0].state,
    ).toBe("waiting");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("does not rename when the workspace moves during observation", async () => {
    const { data, ports, engine } = fixture();
    ports.agents.mockImplementationOnce(async () => {
      data.workspace!.cwd = "/different-checkout";
      return structuredClone(data.agents);
    });
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("error");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("stops safely while awaiting source metadata", async () => {
    const { data, ports, engine } = fixture();
    ports.agents.mockImplementationOnce(async () => {
      engine.stop();
      return structuredClone(data.agents);
    });
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("waiting");
    expect(ports.rename).not.toHaveBeenCalled();
  });

  it("invalidates stale in-flight settings before an older run can rename", async () => {
    const { data, ports, engine } = fixture();
    let latest: Promise<unknown> | undefined;
    ports.agents.mockImplementationOnce(async () => {
      latest = engine.reconcile([enrollment({ enabled: false })]);
      return structuredClone(data.agents);
    });
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("waiting");
    await latest;
    expect(ports.rename).not.toHaveBeenCalled();
    expect(Object.keys((data.saved as EngineState).records)).toEqual([]);
  });

  it("can invalidate an observation before an async settings read completes", async () => {
    const { data, ports, engine } = fixture();
    ports.agents.mockImplementationOnce(async () => {
      engine.invalidate();
      return structuredClone(data.agents);
    });
    expect((await engine.reconcile([enrollment()]))[0].state).toBe("waiting");
    expect(ports.rename).not.toHaveBeenCalled();
    expect(
      (await engine.reconcile([enrollment({ enabled: false })]))[0].state,
    ).toBe("disabled");
    expect(Object.keys((data.saved as EngineState).records)).toEqual([]);
  });
});
