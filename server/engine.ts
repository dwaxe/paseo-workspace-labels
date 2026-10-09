import { createHash } from "node:crypto";
import type {
  AgentView,
  Enrollment,
  LabelStatus,
  WorkspaceView,
} from "../shared/contracts";
import {
  branchTitle,
  conversationTitle,
  selectConversation,
} from "../shared/naming";

interface EnrollmentRecord {
  cwd: string;
  lastApplied: string | null;
  paused: boolean;
  configFingerprint: string;
  generation: number;
  pending: { title: string; sourceFingerprint: string } | null;
}

export interface EngineState {
  version: 1;
  records: Record<string, EnrollmentRecord>;
}

export interface EnginePorts {
  load(): Promise<unknown>;
  save(state: EngineState): Promise<void>;
  workspace(id: string): Promise<WorkspaceView | null>;
  agents(workspaceId: string): Promise<AgentView[]>;
  branch(cwd: string): Promise<string | null>;
  rename(id: string, title: string): Promise<void>;
}

interface Source {
  title: string;
  fingerprint: string;
  agentId: string | null;
}

class Superseded extends Error {}
class PersistenceFailure extends Error {}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.join("\u0000") === [...expected].sort().join("\u0000");
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** A corrupt record must never be silently treated as a fresh enrollment. */
export function parseEngineState(value: unknown): EngineState {
  if (value === null || value === undefined) {
    return { version: 1, records: Object.create(null) };
  }
  if (
    !object(value) ||
    !keys(value, ["version", "records"]) ||
    value.version !== 1 ||
    !object(value.records)
  ) {
    throw new Error(
      "Saved naming state is invalid. No workspace names were changed.",
    );
  }
  for (const [workspaceId, record] of Object.entries(value.records)) {
    if (
      !workspaceId ||
      !object(record) ||
      !keys(record, [
        "cwd",
        "lastApplied",
        "paused",
        "configFingerprint",
        "generation",
        "pending",
      ]) ||
      typeof record.cwd !== "string" ||
      !record.cwd ||
      !nullableString(record.lastApplied) ||
      typeof record.paused !== "boolean" ||
      !digest(record.configFingerprint) ||
      typeof record.generation !== "number" ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 0 ||
      (record.pending !== null &&
        (!object(record.pending) ||
          !keys(record.pending, ["title", "sourceFingerprint"]) ||
          typeof record.pending.title !== "string" ||
          !record.pending.title ||
          record.pending.title.length > 120 ||
          !digest(record.pending.sourceFingerprint)))
    ) {
      throw new Error(
        "Saved naming state is invalid. No workspace names were changed.",
      );
    }
  }
  return structuredClone(value) as unknown as EngineState;
}

function status(
  enrollment: Enrollment,
  state: LabelStatus["state"],
  message: string,
  source: Source | null = null,
): LabelStatus {
  return {
    workspaceId: enrollment.workspaceId,
    state,
    message,
    preview: source?.title ?? null,
    sourceAgentId: source?.agentId ?? null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Workspace naming failed.";
}

export class LabelEngine {
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;
  private stopped = false;

  constructor(private readonly ports: EnginePorts) {}

  /** Cancel in-flight observations while fresh settings are being read. */
  invalidate(): void {
    this.revision += 1;
  }

  stop(): void {
    this.stopped = true;
    this.invalidate();
  }

  reconcile(enrollments: Enrollment[]): Promise<LabelStatus[]> {
    const revision = ++this.revision;
    const settings = structuredClone(enrollments);
    const result = this.tail.then(() => this.run(settings, revision));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertActive(revision: number): void {
    if (this.stopped || revision !== this.revision) {
      throw new Superseded(
        "Naming stopped or settings changed during this run.",
      );
    }
  }

  private async persist(state: EngineState, revision: number): Promise<void> {
    this.assertActive(revision);
    try {
      await this.ports.save(structuredClone(state));
    } catch {
      throw new PersistenceFailure(
        "Could not save naming state. No further names were changed.",
      );
    }
    this.assertActive(revision);
  }

  private async observe(
    enrollment: Enrollment,
    workspace: WorkspaceView,
    revision: number,
  ): Promise<Source | null> {
    if (enrollment.mode === "branch") {
      const branch = await this.ports.branch(workspace.cwd);
      this.assertActive(revision);
      const title = branchTitle(branch, enrollment.alias);
      return title
        ? {
            title,
            fingerprint: fingerprint(["branch", workspace.cwd, branch]),
            agentId: null,
          }
        : null;
    }
    const agents = await this.ports.agents(workspace.id);
    this.assertActive(revision);
    const agent = selectConversation(agents, workspace.id, enrollment.agentId);
    const title = conversationTitle(agent?.title ?? null, enrollment.alias);
    return agent && title
      ? {
          title,
          fingerprint: fingerprint([
            "conversation",
            agent.id,
            agent.title,
            agent.createdAt,
          ]),
          agentId: agent.id,
        }
      : null;
  }

  private validateWorkspace(
    workspace: WorkspaceView | null,
    enrollment: Enrollment,
    cwd?: string,
  ): asserts workspace is WorkspaceView {
    if (
      !workspace ||
      workspace.id !== enrollment.workspaceId ||
      workspace.archived
    ) {
      throw new Error("Workspace is missing or archived.");
    }
    if (cwd !== undefined && workspace.cwd !== cwd) {
      throw new Error(
        "Workspace directory changed. Remove and enroll it again to use this directory.",
      );
    }
  }

  private async run(
    enrollments: Enrollment[],
    revision: number,
  ): Promise<LabelStatus[]> {
    let state: EngineState;
    try {
      this.assertActive(revision);
      state = parseEngineState(await this.ports.load());
      this.assertActive(revision);
      const enabledIds = new Set(
        enrollments
          .filter((item) => item.enabled)
          .map((item) => item.workspaceId),
      );
      let changed = false;
      for (const workspaceId of Object.keys(state.records)) {
        if (!enabledIds.has(workspaceId)) {
          delete state.records[workspaceId];
          changed = true;
        }
      }
      if (changed) await this.persist(state, revision);
    } catch (error) {
      return enrollments.map((enrollment) =>
        status(
          enrollment,
          !enrollment.enabled
            ? "disabled"
            : error instanceof Superseded
              ? "waiting"
              : "error",
          message(error),
        ),
      );
    }

    const statuses: LabelStatus[] = [];
    let abort: Error | null = null;
    for (const enrollment of enrollments) {
      if (!enrollment.enabled) {
        statuses.push(
          status(enrollment, "disabled", "Automatic naming is disabled."),
        );
        continue;
      }
      if (abort) {
        statuses.push(
          status(
            enrollment,
            abort instanceof Superseded ? "waiting" : "error",
            abort.message,
          ),
        );
        continue;
      }
      try {
        statuses.push(await this.reconcileOne(enrollment, state, revision));
      } catch (error) {
        statuses.push(
          status(
            enrollment,
            error instanceof Superseded ? "waiting" : "error",
            message(error),
          ),
        );
        if (error instanceof Superseded || error instanceof PersistenceFailure)
          abort = error;
      }
    }
    return statuses;
  }

  private async reconcileOne(
    enrollment: Enrollment,
    state: EngineState,
    revision: number,
  ): Promise<LabelStatus> {
    this.assertActive(revision);
    const workspace = await this.ports.workspace(enrollment.workspaceId);
    this.assertActive(revision);
    this.validateWorkspace(workspace, enrollment);
    const configFingerprint = fingerprint([
      enrollment.alias,
      enrollment.mode,
      enrollment.agentId ?? null,
      enrollment.generation,
    ]);
    let record = Object.hasOwn(state.records, workspace.id)
      ? state.records[workspace.id]
      : undefined;
    if (record) this.validateWorkspace(workspace, enrollment, record.cwd);
    if (!record || record.generation !== enrollment.generation) {
      record = {
        cwd: workspace.cwd,
        lastApplied: workspace.title,
        paused: false,
        configFingerprint,
        generation: enrollment.generation,
        pending: null,
      };
      Object.defineProperty(state.records, workspace.id, {
        value: record,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      await this.persist(state, revision);
    } else {
      let changed = false;
      if (record.pending && workspace.title === record.pending.title) {
        record.lastApplied = record.pending.title;
        record.pending = null;
        changed = true;
      } else if (workspace.title !== record.lastApplied) {
        if (!record.paused || record.pending !== null) changed = true;
        record.paused = true;
        record.pending = null;
      } else if (record.pending) {
        record.pending = null;
        changed = true;
      }
      if (record.configFingerprint !== configFingerprint) {
        record.configFingerprint = configFingerprint;
        changed = true;
      }
      if (changed) await this.persist(state, revision);
    }
    if (record.paused)
      return status(
        enrollment,
        "paused",
        "A manual rename paused automatic naming. Resume to use the current title as a new baseline.",
      );
    const source = await this.observe(enrollment, workspace, revision);
    if (!source)
      return status(
        enrollment,
        "waiting",
        "Waiting for a current conversation title or Git branch.",
      );
    if (source.title === record.lastApplied)
      return status(enrollment, "ready", "Workspace name is current.", source);

    record.pending = {
      title: source.title,
      sourceFingerprint: source.fingerprint,
    };
    await this.persist(state, revision);
    const refreshedSource = await this.observe(enrollment, workspace, revision);
    if (refreshedSource?.fingerprint !== source.fingerprint) {
      record.pending = null;
      await this.persist(state, revision);
      return status(
        enrollment,
        "waiting",
        "The naming source changed during this run; waiting for the next check.",
        refreshedSource,
      );
    }
    // No CAS exists in the SDK. Keep this title read as the final operation before
    // rename, after source checks and durable intent persistence have finished.
    const latest = await this.ports.workspace(workspace.id);
    this.assertActive(revision);
    this.validateWorkspace(latest, enrollment, record.cwd);
    if (latest.title !== record.lastApplied) {
      if (latest.title === source.title) {
        record.lastApplied = source.title;
        record.pending = null;
        await this.persist(state, revision);
        return status(
          enrollment,
          "ready",
          "Workspace name is current.",
          source,
        );
      }
      record.paused = true;
      record.pending = null;
      await this.persist(state, revision);
      return status(
        enrollment,
        "paused",
        "A manual rename paused automatic naming.",
        source,
      );
    }
    this.assertActive(revision);
    await this.ports.rename(workspace.id, source.title);
    this.assertActive(revision);
    const readback = await this.ports.workspace(workspace.id);
    this.assertActive(revision);
    this.validateWorkspace(readback, enrollment, record.cwd);
    if (readback.title !== source.title) {
      if (readback.title !== record.lastApplied) {
        record.paused = true;
        record.pending = null;
        await this.persist(state, revision);
        return status(
          enrollment,
          "paused",
          "A manual rename paused automatic naming.",
          source,
        );
      }
      throw new Error(
        "The rename was not confirmed. Its saved intent will be checked on the next run.",
      );
    }
    record.lastApplied = source.title;
    record.pending = null;
    await this.persist(state, revision);
    return status(enrollment, "ready", "Workspace name updated.", source);
  }
}
