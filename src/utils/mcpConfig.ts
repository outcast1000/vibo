/**
 * Builds the client config a user pastes to connect an MCP client (Claude
 * Desktop, Claude Code, …) to this app's control API.
 *
 * Pure on purpose: the two facts that make the block correct come from the
 * backend (`mcp_setup_info` — see `src-tauri/src/mcp_setup.rs`), and the
 * assembly is what we want to assert without a webview. See
 * `__tests__/mcpConfig.test.ts`.
 *
 * Deliberately emits **no `--tier=full`**: the default tier is what
 * `mcp/README.md` recommends per client for Desktop, since lyrics, bios and
 * catalog results are untrusted web content flowing into the model's context
 * and the tier bounds what an injected instruction could reach. A user who
 * wants the power verbs adds the flag themselves.
 */

/** Shape of the backend's `mcp_setup_info` reply. */
export interface McpSetupInfo {
  /** Absolute path of the bundled server script; null when it isn't there. */
  scriptPath: string | null;
  /** Absolute path of a usable `node`; null when none was found. */
  nodePath: string | null;
  /** Raw `node --version` output, e.g. `v22.23.2`. */
  nodeVersion: string | null;
  /** Found, ran, and new enough. */
  nodeOk: boolean;
  /** Minimum Node major this build requires. */
  minNodeMajor: number;
  /** Set only for a non-default profile (see below). */
  profile: string | null;
}

/** The key the server is registered under, in every client, for the default profile. */
export const MCP_SERVER_KEY = "viboplr";

/**
 * The key for this profile. A named profile gets `viboplr-<name>`, so setting
 * up a second profile adds a server instead of repointing the default one.
 * Mirrors `mcp_clients::server_key` in Rust, which the Install buttons use.
 */
export function mcpServerKey(info: Pick<McpSetupInfo, "profile">): string {
  return info.profile ? `${MCP_SERVER_KEY}-${info.profile}` : MCP_SERVER_KEY;
}

/**
 * Script path plus, for a named profile, `--profile=`.
 *
 * The MCP server resolves the `default` profile on its own, so the flag is
 * added exactly when the app is running a named one — otherwise a user on a
 * named profile gets a config that connects to nothing.
 */
export function buildMcpArgs(info: McpSetupInfo): string[] {
  if (!info.scriptPath) return [];
  const args = [info.scriptPath];
  if (info.profile) args.push(`--profile=${info.profile}`);
  return args;
}

/**
 * The JSON block for a `claude_desktop_config.json`-style client, or null when
 * there is no script to point at.
 *
 * Emits the full `mcpServers` wrapper rather than the bare entry: pasted into
 * an empty config it is immediately valid, and a user who already has servers
 * can see the nesting and merge. `command` falls back to a bare `"node"` when
 * none was found — the config is still the right shape, and Settings says
 * separately that Node is missing.
 */
export function buildMcpConfigSnippet(info: McpSetupInfo): string | null {
  if (!info.scriptPath) return null;
  return JSON.stringify(
    {
      mcpServers: {
        [mcpServerKey(info)]: {
          command: info.nodePath ?? "node",
          args: buildMcpArgs(info),
        },
      },
    },
    null,
    2,
  );
}

/**
 * Quote an argument for a shell only when it needs it.
 *
 * Double quotes rather than single: Windows paths are the common case with a
 * space in them (`C:\Program Files\nodejs\node.exe`) and double quotes are the
 * one form cmd, PowerShell and POSIX shells all read the same way.
 */
export function shellQuote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * The one-line `claude mcp add` form, or null when there is no script.
 * `--scope user`, like the Install button: the default (local) scope only
 * registers the server for the folder the command happens to run in.
 */
export function buildMcpCliCommand(info: McpSetupInfo): string | null {
  if (!info.scriptPath) return null;
  const parts = ["claude", "mcp", "add", "--scope", "user", mcpServerKey(info), "--", info.nodePath ?? "node", ...buildMcpArgs(info)];
  return parts.map(shellQuote).join(" ");
}

/**
 * One sentence naming what is missing, or null when the setup is complete.
 *
 * A too-old Node is reported with the version the user actually has, which is
 * the difference between an actionable message and "no Node found" on a
 * machine that plainly has one.
 */
export function mcpSetupProblem(info: McpSetupInfo): string | null {
  if (!info.scriptPath) {
    return "The bundled MCP server script is missing from this install.";
  }
  if (!info.nodePath) {
    return `Node ${info.minNodeMajor} or newer is required to run the server, and none was found on this computer.`;
  }
  if (!info.nodeOk) {
    return `Node ${info.nodeVersion ?? "(unknown version)"} was found, but the server needs ${info.minNodeMajor} or newer.`;
  }
  return null;
}

/**
 * One MCP client the app can install the server into, as `mcp_clients_status`
 * reports it (`src-tauri/src/mcp_clients.rs`). The Install buttons send only
 * the `id`: the entry written is computed in Rust, never in the webview.
 */
export interface McpClientStatus {
  id: "claude-desktop" | "claude-code" | "cursor";
  name: string;
  configPath: string;
  /** The client's own folder exists on this computer. */
  detected: boolean;
  state: "notInstalled" | "installed" | "outdated" | "unreadable";
  /** Why the config couldn't be read (`unreadable` only). */
  error: string | null;
}

/**
 * The clients Settings lists: the ones found on this computer, plus any that
 * still has our entry (an uninstalled client still deserves a Remove).
 */
export function visibleMcpClients(clients: McpClientStatus[]): McpClientStatus[] {
  return clients.filter((c) => c.detected || c.state === "installed" || c.state === "outdated");
}

/** How the client picks up a change to its config. */
export function mcpRestartHint(client: Pick<McpClientStatus, "id" | "name">): string {
  return client.id === "claude-code"
    ? "Start a new Claude Code session to use it."
    : `Quit ${client.name} completely and reopen it to use it.`;
}

/** The status line under a client's name. */
export function describeMcpClient(client: McpClientStatus): string {
  switch (client.state) {
    case "installed":
      return `Installed. ${mcpRestartHint(client)}`;
    case "outdated":
      return "Set up for a different Node or app location. Update it to use this one.";
    case "unreadable":
      return `Vibo can't edit this config (${client.error ?? "unreadable"}). Use Copy config instead.`;
    default:
      return "Not installed.";
  }
}
