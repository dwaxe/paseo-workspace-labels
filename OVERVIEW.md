Workspace labels keeps reusable checkout names useful: a workspace called
`alpha` can appear as `Improve search · alpha` while its directory stays the same.

Enable automatic naming for individual workspaces in Workspace names. Follow
the newest conversation title, pin a conversation, or follow the Git branch.
Manual renames pause automatic naming until you explicitly resume it.

Requires Paseo 0.11.1. Branch mode also requires Git on the daemon host. The plugin
reads local workspace and conversation metadata, not conversation bodies, and
makes no model calls. Settings and recovery state stay on the host. A topic change
needs a changed conversation title or branch to affect the workspace name.
