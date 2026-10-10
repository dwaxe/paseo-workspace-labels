import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inspectLabelsRpc, labelSettings } from "./shared/contracts";
import { LabelRuntime } from "./server/runtime";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(labelSettings);
  const runtime = new LabelRuntime(settings);
  const cleanups = [settings.subscribe(() => runtime.settingsChanged())];
  for (const event of [
    "agent.created",
    "agent.turn_started",
    "agent.turn_ended",
    "agent.closed",
    "agent.archived",
  ] as const) {
    cleanups.push(
      server.on(event, async ({ agent }, context) => {
        if (agent.parentAgentId !== null) return;
        await runtime.connect(context.paseo);
        runtime.schedule();
      }),
    );
  }
  for (const event of ["workspace.created", "workspace.archived"] as const) {
    cleanups.push(
      server.on(event, async (_event, context) => {
        await runtime.connect(context.paseo);
        runtime.schedule();
      }),
    );
  }
  server.handle(inspectLabelsRpc, (_input, context) =>
    runtime.inspect(context.paseo),
  );
  return async () => {
    for (const cleanup of cleanups) cleanup();
    await runtime.stop();
  };
}
