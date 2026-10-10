import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type {
  PluginHandlerContext,
  PluginSettings,
} from "@getpaseo/plugin/server";
import {
  labelSettings,
  type AgentView,
  type Enrollment,
  type LabelStatus,
  type WorkspaceView,
} from "../shared/contracts";
import { LabelEngine } from "./engine";
import { defaultStateDirectory, FileStateStore } from "./store";

const execute = promisify(execFile);
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgent = Awaited<
  ReturnType<PaseoApi["agents"]["list"]>
>["entries"][number]["agent"];
type PaseoWorkspace = Awaited<
  ReturnType<PaseoApi["workspaces"]["list"]>
>["entries"][number];
type OwnedSubscription =
  | NonNullable<Awaited<ReturnType<PaseoApi["agents"]["list"]>>["subscription"]>
  | NonNullable<
      Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["subscription"]
    >;

export function agentView(agent: PaseoAgent): AgentView {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title,
    createdAt: agent.createdAt,
    parentAgentId: agent.labels["paseo.parent-agent-id"]?.trim() || null,
    archived: Boolean(agent.archivedAt),
    closed: agent.status === "closed",
    internal: agent.labels["paseo.internal"] === "true",
  };
}

export function workspaceView(workspace: PaseoWorkspace): WorkspaceView | null {
  if (
    !workspace.workspaceDirectory ||
    !path.isAbsolute(workspace.workspaceDirectory)
  )
    return null;
  return {
    id: workspace.id,
    cwd: workspace.workspaceDirectory,
    title: workspace.title ?? null,
    displayName: workspace.name,
    archived: Boolean(workspace.archivingAt),
  };
}

export async function readBranch(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!path.isAbsolute(cwd))
    throw new Error("Workspace directory must be an absolute path.");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const variable of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"])
    delete environment[variable];
  try {
    const result = await execute(
      "git",
      ["-C", cwd, "symbolic-ref", "--quiet", "HEAD"],
      {
        timeout: 10_000,
        maxBuffer: 4096,
        signal,
        env: environment,
      },
    );
    const branch = result.stdout.trim();
    if (!branch || branch.includes("\n"))
      throw new Error("Git returned an invalid branch name.");
    return branch;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw new Error("Could not read this workspace's Git branch.");
  }
}

export class LabelRuntime {
  private api: PaseoApi | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly cleanups: (() => void)[] = [];
  private readonly releases: (() => Promise<void>)[] = [];
  private readonly signatures = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private statuses: LabelStatus[] = [];
  private enrollments: Enrollment[] = [];
  private settingsEpoch = 0;
  private reconciliation: Promise<void> | null = null;
  private refreshRequested = false;
  private readonly engine: LabelEngine;

  constructor(
    private readonly settings: PluginSettings<typeof labelSettings.schema>,
    directory = defaultStateDirectory(),
  ) {
    const store = new FileStateStore(directory);
    this.engine = new LabelEngine({
      load: () => store.load(),
      save: (state) => store.save(state),
      workspace: async (id) => {
        const row = await this.requireApi().workspaces.ref(id).refresh();
        return row ? workspaceView(row) : null;
      },
      agents: () => this.listAgents(),
      branch: (cwd) => readBranch(cwd, this.abort.signal),
      rename: async (id, title) => {
        await this.requireApi().workspaces.ref(id).setTitle(title);
      },
    });
  }

  private requireApi() {
    if (!this.api || this.stopped)
      throw new Error("Workspace labels are not connected.");
    return this.api;
  }

  settingsChanged() {
    this.settingsEpoch++;
    this.engine.invalidate();
    this.schedule();
  }

  private own(subscription: OwnedSubscription) {
    if (this.stopped) {
      void subscription.release().catch(() => {});
      return;
    }
    this.releases.push(() => subscription.release());
    subscription.subscribe({
      snapshot: () => this.schedule(),
      update: () => {},
      error: () => this.schedule(),
    });
  }

  async connect(api: PaseoApi): Promise<void> {
    if (this.stopped) return;
    if (this.starting) return this.starting;
    if (this.api) return;
    this.api = api;
    this.starting = (async () => {
      this.cleanups.push(
        api.agents.subscribe((update) => {
          if (update.kind !== "upsert") {
            this.schedule();
            return;
          }
          const agent = agentView(update.agent);
          const signature = JSON.stringify([
            agent.workspaceId,
            agent.title,
            agent.createdAt,
            agent.parentAgentId,
            agent.archived,
            agent.closed,
            agent.internal,
          ]);
          if (this.signatures.get(agent.id) !== signature) {
            this.signatures.set(agent.id, signature);
            this.schedule();
          }
        }),
      );
      this.cleanups.push(api.workspaces.subscribe(() => this.schedule()));
      const agentStream = await api.agents
        .list({
          filter: { includeArchived: false },
          page: { limit: PAGE_SIZE },
          subscribe: {},
        })
        .catch(() => null);
      if (agentStream) this.own(agentStream.subscription);
      if (this.stopped) return;
      const workspaceStream = await api.workspaces.list({
        page: { limit: PAGE_SIZE },
        subscribe: {},
      });
      this.own(workspaceStream.subscription);
      if (!this.stopped) {
        this.heartbeat = setInterval(() => this.schedule(), 60_000);
        this.schedule();
      }
    })()
      .catch(async (error: unknown) => {
        await this.clearSubscriptions();
        this.api = null;
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  schedule() {
    if (this.stopped || !this.api || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile().catch(() =>
        console.error(
          "Workspace labels could not refresh; retrying on the next update.",
        ),
      );
    }, 300);
  }

  private async listAgents(): Promise<AgentView[]> {
    const api = this.requireApi();
    const agents: AgentView[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await api.agents.list({
        filter: { includeArchived: false },
        sort: [{ key: "created_at", direction: "desc" }],
        page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      agents.push(...result.entries.map(({ agent }) => agentView(agent)));
      if (!result.pageInfo.hasMore) return agents;
      const next = result.pageInfo.nextCursor;
      if (!next || seen.has(next))
        throw new Error("Conversation list pagination did not advance.");
      seen.add(next);
      cursor = next;
    }
    throw new Error("Too many conversations to safely choose a naming source.");
  }

  private async listWorkspaces(): Promise<WorkspaceView[]> {
    const api = this.requireApi();
    const rows: WorkspaceView[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await api.workspaces.list({
        page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      for (const row of result.entries) {
        const view = workspaceView(row);
        if (view && !view.archived) rows.push(view);
      }
      if (!result.pageInfo.hasMore) return rows;
      const next = result.pageInfo.nextCursor;
      if (!next || seen.has(next))
        throw new Error("Workspace list pagination did not advance.");
      seen.add(next);
      cursor = next;
    }
    throw new Error("Too many workspaces to safely enumerate.");
  }

  private async reconcile(): Promise<void> {
    if (this.reconciliation) {
      this.refreshRequested = true;
      return this.reconciliation;
    }
    this.reconciliation = this.reconcileOnce();
    try {
      await this.reconciliation;
    } finally {
      this.reconciliation = null;
      if (this.refreshRequested) {
        this.refreshRequested = false;
        this.schedule();
      }
    }
  }

  private async reconcileOnce(): Promise<void> {
    if (this.stopped) return;
    const epoch = this.settingsEpoch;
    const config = await this.settings.read();
    if (this.stopped || epoch !== this.settingsEpoch) return;
    if (config.status !== "ready") {
      this.engine.invalidate();
      this.statuses = this.enrollments.map((item) => ({
        workspaceId: item.workspaceId,
        state: "error",
        message:
          "Naming preferences could not be read. Reload settings to continue.",
        preview: null,
      }));
      return;
    }
    this.enrollments = config.values.workspaces;
    const result = await this.engine.reconcile(this.enrollments);
    if (!this.stopped && epoch === this.settingsEpoch) this.statuses = result;
  }

  async inspect(api: PaseoApi) {
    await this.connect(api);
    await this.reconcile();
    const [workspaces, conversations] = await Promise.all([
      this.listWorkspaces(),
      this.listAgents().then(
        (agents) => ({ agents, agentsError: null }),
        () => ({
          agents: [],
          agentsError: "Could not load conversations. Try again.",
        }),
      ),
    ]);
    return {
      workspaces: workspaces.map((item) => ({
        workspaceId: item.id,
        title: item.displayName ?? item.title,
        cwd: item.cwd,
      })),
      agents: conversations.agents
        .filter(
          (item) =>
            !item.parentAgentId &&
            !item.archived &&
            !item.closed &&
            !item.internal,
        )
        .map(({ id, workspaceId, title, createdAt }) => ({
          id,
          workspaceId,
          title,
          createdAt,
        })),
      agentsError: conversations.agentsError,
      statuses: this.statuses,
    };
  }

  private async clearSubscriptions() {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    await Promise.allSettled(
      this.releases.splice(0).map((release) => release()),
    );
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    this.engine.stop();
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.clearSubscriptions();
    await this.reconciliation;
  }
}
