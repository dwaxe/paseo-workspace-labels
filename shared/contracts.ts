import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const enrollmentSchema = z.object({
  workspaceId: z.string().min(1).max(512),
  alias: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  mode: z.enum(["conversation", "branch"]).default("conversation"),
  agentId: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  generation: z.number().int().nonnegative().default(0),
});

export const settingsSchema = z
  .object({
    workspaces: z.array(enrollmentSchema).max(500).default([]),
  })
  .refine(
    ({ workspaces }) =>
      new Set(workspaces.map((item) => item.workspaceId)).size ===
      workspaces.length,
    {
      message: "Each workspace can be enrolled only once.",
    },
  );

export const labelSettings = defineSettings({
  id: "labels",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export type Enrollment = z.output<typeof enrollmentSchema>;
export type LabelSettings = z.output<typeof settingsSchema>;

export interface WorkspaceView {
  id: string;
  cwd: string;
  title: string | null;
  displayName?: string;
  archived: boolean;
}

export interface AgentView {
  id: string;
  workspaceId: string | null;
  title: string | null;
  createdAt: string;
  parentAgentId: string | null;
  archived: boolean;
  closed: boolean;
  internal: boolean;
}

export const statusSchema = z.object({
  workspaceId: z.string(),
  state: z.enum(["disabled", "ready", "paused", "waiting", "error"]),
  message: z.string(),
  preview: z.string().nullable(),
  sourceAgentId: z.string().nullable(),
});
export type LabelStatus = z.output<typeof statusSchema>;

export const inspectLabelsRpc = defineRpc({
  name: "labels.inspect",
  input: z.object({}),
  output: z.object({
    workspaces: z.array(
      z.object({
        workspaceId: z.string(),
        title: z.string().nullable(),
        cwd: z.string(),
      }),
    ),
    agents: z.array(
      z.object({
        id: z.string(),
        workspaceId: z.string().nullable(),
        title: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    statuses: z.array(statusSchema),
  }),
});
