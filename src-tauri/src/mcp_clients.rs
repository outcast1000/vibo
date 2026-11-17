//! One-click install of the MCP server into the user's MCP clients, for
//! Settings → AI control → "Connect an AI assistant".
//!
//! `mcp_setup.rs` works out *what* the entry is (the bundled script and a
//! `node` that can run it). This module writes that entry into each client's
//! own config file, so the user doesn't have to find the file, paste JSON into
//! it, or open a terminal.
//!
//! The rules, each one a way a hand-edited config could otherwise break:
//!
//! - **The host computes the entry. The webview never supplies one.** These
//!   commands can be called from any JS in the webview, a plugin's included.
//!   An install that took `command`/`args` would let a plugin make Claude
//!   Desktop run any program it liked at its next launch. Install takes a
//!   client id and nothing else.
//! - **We only touch our own key.** Every other top-level key and every other
//!   server entry is kept as the raw text it was read as (`RawValue` in an
//!   insertion-ordered map). `~/.claude.json` is Claude Code's whole state
//!   file, so a round-trip through `serde_json::Value` would re-sort all of it.
//!   Inside our own entry, fields we don't write (`env`, say) are kept.
//! - **A file we can't parse is refused, never overwritten.** Cursor allows
//!   comments in its JSON, so a config can be valid for its owner and still
//!   be one we can't read. That shows up as `unreadable` with the parse error,
//!   and Copy config still works.
//! - **A backup and an atomic write**: the previous file goes to
//!   `<file>.viboplr-backup`, and the new one is renamed into place.

use indexmap::IndexMap;
use serde_json::value::RawValue;
use std::path::{Path, PathBuf};

use crate::mcp_setup::McpSetupInfo;

/// The clients we know how to install into, in the order Settings lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Client {
    ClaudeDesktop,
    ClaudeCode,
    Cursor,
}

pub const ALL_CLIENTS: [Client; 3] = [Client::ClaudeDesktop, Client::ClaudeCode, Client::Cursor];

impl Client {
    pub fn id(self) -> &'static str {
        match self {
            Client::ClaudeDesktop => "claude-desktop",
            Client::ClaudeCode => "claude-code",
            Client::Cursor => "cursor",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Client::ClaudeDesktop => "Claude Desktop",
            Client::ClaudeCode => "Claude Code",
            Client::Cursor => "Cursor",
        }
    }

    pub fn from_id(id: &str) -> Option<Client> {
        ALL_CLIENTS.into_iter().find(|c| c.id() == id)
    }

    /// Which config file the client reads, and whether the client looks
    /// installed.
    ///
    /// "Detected" means the client's own directory exists, not that the config
    /// file does: a fresh Claude Desktop has no `claude_desktop_config.json`
    /// until something writes one, and we are allowed to be that something.
    fn locate(self, home: &Path) -> (PathBuf, bool) {
        match self {
            Client::ClaudeDesktop => {
                let dir = claude_desktop_dir(home);
                let detected = dir.is_dir();
                (dir.join("claude_desktop_config.json"), detected)
            }
            Client::ClaudeCode => {
                // User scope: top-level `mcpServers` in ~/.claude.json, what
                // `claude mcp add --scope user` writes.
                let file = home.join(".claude.json");
                let detected = file.is_file() || home.join(".claude").is_dir();
                (file, detected)
            }
            Client::Cursor => {
                let dir = home.join(".cursor");
                let detected = dir.is_dir();
                (dir.join("mcp.json"), detected)
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn claude_desktop_dir(home: &Path) -> PathBuf {
    home.join("Library").join("Application Support").join("Claude")
}

#[cfg(windows)]
fn claude_desktop_dir(home: &Path) -> PathBuf {
    let roaming = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Roaming"));
    let classic = roaming.join("Claude");
    if classic.is_dir() {
        return classic;
    }
    // The Microsoft Store build can keep AppData inside its package instead.
    // Look there only when the ordinary location doesn't exist, because a
    // Store install can use the ordinary location too.
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    if let Ok(entries) = std::fs::read_dir(local.join("Packages")) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("Claude_") {
                let dir = e.path().join("LocalCache").join("Roaming").join("Claude");
                if dir.is_dir() {
                    return dir;
                }
            }
        }
    }
    classic
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn claude_desktop_dir(home: &Path) -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("Claude")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// The server key for this profile. The default profile is `viboplr`; a named
/// one gets its own key, so installing from a second profile adds a server
/// rather than repointing the default one.
pub fn server_key(profile: Option<&str>) -> String {
    match profile {
        Some(p) => format!("viboplr-{p}"),
        None => "viboplr".to_string(),
    }
}

/// The `command` + `args` this build would install, or the reason it can't.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub command: String,
    pub args: Vec<String>,
}

/// An entry is installed only with a Node that will actually run it. A bare
/// `"node"` in a GUI client's config is the classic way the server silently
/// never shows up, so the install refuses rather than writing one.
pub fn expected_entry(info: &McpSetupInfo) -> Result<Entry, String> {
    let script = info
        .script_path
        .clone()
        .ok_or("The bundled MCP server script is missing from this install.")?;
    let node = match (&info.node_path, info.node_ok) {
        (Some(p), true) => p.clone(),
        (Some(_), false) => {
            return Err(format!(
                "Node {} was found, but the server needs {} or newer.",
                info.node_version.as_deref().unwrap_or("(unknown version)"),
                info.min_node_major
            ))
        }
        (None, _) => {
            return Err(format!(
                "Node {} or newer is required to run the server, and none was found on this computer.",
                info.min_node_major
            ))
        }
    };
    let mut args = vec![script];
    if let Some(p) = &info.profile {
        args.push(format!("--profile={p}"));
    }
    Ok(Entry { command: node, args })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallState {
    NotInstalled,
    /// Present and matching what this build would write.
    Installed,
    /// Present but pointing somewhere else: an older node, a moved app, or an
    /// entry the user wrote by hand. Install rewrites it.
    Outdated,
    /// The file exists and isn't JSON we can edit. See `error`.
    Unreadable,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub config_path: String,
    pub detected: bool,
    pub state: InstallState,
    pub error: Option<String>,
}

type RawMap = IndexMap<String, Box<RawValue>>;

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// Parse a config file's top level and its `mcpServers`, keeping everything
/// else as raw text. An empty or whitespace-only file counts as `{}`.
fn parse_config(text: &str) -> Result<(RawMap, RawMap), String> {
    let text = strip_bom(text);
    let top: RawMap = if text.trim().is_empty() {
        RawMap::new()
    } else {
        serde_json::from_str(text).map_err(|e| format!("Not a JSON object: {e}"))?
    };
    let servers: RawMap = match top.get("mcpServers") {
        Some(raw) => serde_json::from_str(raw.get())
            .map_err(|e| format!("\"mcpServers\" is not an object: {e}"))?,
        None => RawMap::new(),
    };
    Ok((top, servers))
}

/// How the entry under `key` compares with `expected`. `expected` is `None`
/// when this build can't say what it would write (no usable Node); then any
/// entry counts as installed, since we have nothing better to replace it with.
pub fn entry_state(text: Option<&str>, key: &str, expected: Option<&Entry>) -> Result<InstallState, String> {
    let Some(text) = text else { return Ok(InstallState::NotInstalled) };
    let (_, servers) = parse_config(text)?;
    let Some(raw) = servers.get(key) else { return Ok(InstallState::NotInstalled) };
    let Some(expected) = expected else { return Ok(InstallState::Installed) };
    let v: serde_json::Value = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
    let command = v.get("command").and_then(|c| c.as_str());
    let args: Option<Vec<&str>> = v
        .get("args")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect());
    let matches = command == Some(expected.command.as_str())
        && args.as_deref() == Some(&expected.args.iter().map(String::as_str).collect::<Vec<_>>()[..]);
    Ok(if matches { InstallState::Installed } else { InstallState::Outdated })
}

/// Re-indent a pretty-printed value so it sits at `depth` levels inside the
/// file (2 spaces per level, what every one of these clients writes).
fn indented_raw(value: &impl serde::Serialize, depth: usize) -> Result<Box<RawValue>, String> {
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let pad = "  ".repeat(depth);
    let text = pretty.lines().enumerate().fold(String::new(), |mut acc, (i, line)| {
        if i > 0 {
            acc.push('\n');
            acc.push_str(&pad);
        }
        acc.push_str(line);
        acc
    });
    RawValue::from_string(text).map_err(|e| e.to_string())
}

/// The `mcpServers` object as it sits at depth 1, written by hand so every
/// entry's raw text goes out exactly as it came in (a pretty-printer would
/// indent from column 0 and shift entries we don't own).
fn servers_block(servers: &RawMap) -> Result<Box<RawValue>, String> {
    if servers.is_empty() {
        return RawValue::from_string("{}".into()).map_err(|e| e.to_string());
    }
    let mut out = String::from("{\n");
    for (i, (k, v)) in servers.iter().enumerate() {
        if i > 0 {
            out.push_str(",\n");
        }
        out.push_str("    ");
        out.push_str(&serde_json::to_string(k).map_err(|e| e.to_string())?);
        out.push_str(": ");
        out.push_str(v.get());
    }
    out.push_str("\n  }");
    RawValue::from_string(out).map_err(|e| e.to_string())
}

/// The file's new text with `key` set to `entry` (`Some`) or removed (`None`).
/// Pure, so the merge can be tested without touching a real client's config.
pub fn edit_config(text: Option<&str>, key: &str, entry: Option<&Entry>) -> Result<String, String> {
    let (mut top, mut servers) = parse_config(text.unwrap_or(""))?;
    match entry {
        Some(entry) => {
            // Keep whatever else the user put in our entry (`env`, `disabled`).
            // An IndexMap, not serde_json::Map: that one sorts, which would
            // put `args` before `command` and reorder the user's own fields.
            let mut obj = servers
                .get(key)
                .and_then(|raw| serde_json::from_str::<IndexMap<String, serde_json::Value>>(raw.get()).ok())
                .unwrap_or_default();
            obj.insert("command".into(), entry.command.clone().into());
            obj.insert("args".into(), entry.args.clone().into());
            // `insert` on an existing key keeps its position in the map.
            servers.insert(key.to_string(), indented_raw(&obj, 2)?);
        }
        None => {
            if servers.shift_remove(key).is_none() {
                // Nothing to remove: hand the file back exactly as it was.
                return Ok(text.unwrap_or("").to_string());
            }
        }
    }
    top.insert("mcpServers".to_string(), servers_block(&servers)?);
    let mut out = serde_json::to_string_pretty(&top).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn't read {}: {e}", path.display())),
    }
}

fn write_with_backup(path: &Path, previous: Option<&str>, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let with_suffix = |suffix: &str| {
        let mut s = path.as_os_str().to_owned();
        s.push(suffix);
        PathBuf::from(s)
    };
    if let Some(prev) = previous {
        std::fs::write(with_suffix(".viboplr-backup"), prev).map_err(|e| format!("Couldn't write the backup: {e}"))?;
    }
    let tmp = with_suffix(".viboplr-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't replace {}: {e}", path.display())
    })
}

fn status_at(client: Client, path: &Path, detected: bool, key: &str, expected: Option<&Entry>) -> ClientStatus {
    let (state, error) = match read_optional(path).and_then(|t| entry_state(t.as_deref(), key, expected)) {
        Ok(s) => (s, None),
        Err(e) => (InstallState::Unreadable, Some(e)),
    };
    ClientStatus {
        id: client.id(),
        name: client.name(),
        config_path: path.to_string_lossy().into_owned(),
        detected,
        state,
        error,
    }
}

/// Every known client, detected or not. Settings shows the detected ones and
/// any undetected one that already has our entry (a client uninstalled after
/// the fact still deserves a Remove).
pub fn statuses(info: &McpSetupInfo) -> Vec<ClientStatus> {
    let Some(home) = home_dir() else { return Vec::new() };
    let key = server_key(info.profile.as_deref());
    let expected = expected_entry(info).ok();
    ALL_CLIENTS
        .into_iter()
        .map(|c| {
            let (path, detected) = c.locate(&home);
            status_at(c, &path, detected, &key, expected.as_ref())
        })
        .collect()
}

/// Install (`install = true`) or remove our entry in one client's config, and
/// return that client's status afterwards.
pub fn apply(info: &McpSetupInfo, client_id: &str, install: bool) -> Result<ClientStatus, String> {
    let client = Client::from_id(client_id).ok_or_else(|| format!("Unknown MCP client: {client_id}"))?;
    let home = home_dir().ok_or("Couldn't find the home directory.")?;
    let (path, detected) = client.locate(&home);
    let key = server_key(info.profile.as_deref());
    let entry = if install { Some(expected_entry(info)?) } else { None };
    let previous = read_optional(&path)?;
    let next = edit_config(previous.as_deref(), &key, entry.as_ref())
        .map_err(|e| format!("{} isn't a config Vibo can edit ({e}). Use Copy config instead.", path.display()))?;
    // Removing from a file that isn't there is a no-op, not an empty file.
    let changed = match &previous {
        Some(prev) => prev != &next,
        None => install,
    };
    if changed {
        write_with_backup(&path, previous.as_deref(), &next)?;
    }
    let expected = expected_entry(info).ok();
    Ok(status_at(client, &path, detected, &key, expected.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> Entry {
        Entry { command: "/opt/homebrew/bin/node".into(), args: vec!["/A/viboplr-mcp.mjs".into()] }
    }

    #[test]
    fn test_install_into_a_missing_file_makes_a_valid_config() {
        let out = edit_config(None, "viboplr", Some(&entry())).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["viboplr"]["command"], "/opt/homebrew/bin/node");
        assert_eq!(v["mcpServers"]["viboplr"]["args"][0], "/A/viboplr-mcp.mjs");
    }

    #[test]
    fn test_other_keys_and_servers_survive_verbatim_and_in_order() {
        // ~/.claude.json is Claude Code's whole state file: a re-sort or a
        // reformat of anything we don't own is a diff the user never asked for.
        let before = "{\n  \"zeta\": 1,\n  \"mcpServers\": {\n    \"other\": {\"command\": \"x\",   \"args\": []}\n  },\n  \"alpha\": {\"b\": 2, \"a\": 1}\n}\n";
        let out = edit_config(Some(before), "viboplr", Some(&entry())).unwrap();
        assert!(out.find("\"zeta\"").unwrap() < out.find("\"alpha\"").unwrap());
        assert!(out.contains("{\"command\": \"x\",   \"args\": []}"));
        assert!(out.contains("{\"b\": 2, \"a\": 1}"));
        assert!(out.find("\"other\"").unwrap() < out.find("\"viboplr\"").unwrap());
    }

    #[test]
    fn test_output_reads_like_a_hand_written_config() {
        let before = "{\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\"\n    }\n  },\n  \"theme\": \"dark\"\n}\n";
        let out = edit_config(Some(before), "viboplr", Some(&entry())).unwrap();
        let expected = "{\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\"\n    },\n    \"viboplr\": {\n      \"command\": \"/opt/homebrew/bin/node\",\n      \"args\": [\n        \"/A/viboplr-mcp.mjs\"\n      ]\n    }\n  },\n  \"theme\": \"dark\"\n}\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn test_reinstall_keeps_fields_we_do_not_write() {
        let before = r#"{"mcpServers":{"viboplr":{"command":"node","args":["old"],"env":{"K":"V"}}}}"#;
        let out = edit_config(Some(before), "viboplr", Some(&entry())).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["viboplr"]["env"]["K"], "V");
        assert_eq!(v["mcpServers"]["viboplr"]["command"], "/opt/homebrew/bin/node");
    }

    #[test]
    fn test_remove_drops_only_our_key() {
        let before = r#"{"mcpServers":{"other":{"command":"x"},"viboplr":{"command":"node"}}}"#;
        let out = edit_config(Some(before), "viboplr", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v["mcpServers"].get("viboplr").is_none());
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
    }

    #[test]
    fn test_remove_without_our_key_returns_the_file_unchanged() {
        let before = "{ \"x\": 1 }";
        assert_eq!(edit_config(Some(before), "viboplr", None).unwrap(), before);
    }

    #[test]
    fn test_a_file_we_cannot_parse_is_refused() {
        // Cursor accepts comments in its JSON; we must not "fix" that file.
        let jsonc = "{\n  // mine\n  \"mcpServers\": {}\n}";
        assert!(edit_config(Some(jsonc), "viboplr", Some(&entry())).is_err());
        assert!(edit_config(Some("[1,2]"), "viboplr", Some(&entry())).is_err());
        assert!(edit_config(Some(r#"{"mcpServers": 3}"#), "viboplr", Some(&entry())).is_err());
    }

    #[test]
    fn test_bom_and_empty_files_are_accepted() {
        assert!(edit_config(Some("\u{feff}{}"), "viboplr", Some(&entry())).is_ok());
        assert!(edit_config(Some("  \n"), "viboplr", Some(&entry())).is_ok());
    }

    #[test]
    fn test_state_tells_installed_from_outdated() {
        let e = entry();
        let installed = edit_config(None, "viboplr", Some(&e)).unwrap();
        assert_eq!(entry_state(Some(&installed), "viboplr", Some(&e)).unwrap(), InstallState::Installed);
        let moved = Entry { command: "/usr/local/bin/node".into(), ..e.clone() };
        assert_eq!(entry_state(Some(&installed), "viboplr", Some(&moved)).unwrap(), InstallState::Outdated);
        assert_eq!(entry_state(None, "viboplr", Some(&e)).unwrap(), InstallState::NotInstalled);
        assert_eq!(entry_state(Some("{}"), "viboplr", Some(&e)).unwrap(), InstallState::NotInstalled);
    }

    #[test]
    fn test_named_profiles_get_their_own_key() {
        assert_eq!(server_key(None), "viboplr");
        assert_eq!(server_key(Some("perf")), "viboplr-perf");
    }

    #[test]
    fn test_no_usable_node_means_no_install() {
        let info = McpSetupInfo {
            script_path: Some("/A/viboplr-mcp.mjs".into()),
            node_path: Some("/usr/bin/node".into()),
            node_version: Some("v16.0.0".into()),
            node_ok: false,
            min_node_major: 18,
            profile: None,
        };
        assert!(expected_entry(&info).unwrap_err().contains("v16.0.0"));
        let ok = McpSetupInfo { node_ok: true, profile: Some("perf".into()), ..info };
        assert_eq!(expected_entry(&ok).unwrap().args, vec!["/A/viboplr-mcp.mjs", "--profile=perf"]);
    }

    /// Runs the merge over this machine's real client configs **without
    /// writing anything**, and checks nothing but our key changed. `#[ignore]`d
    /// because it reads the developer's own files.
    ///
    /// Recipe: `cargo test --lib probe_real_client_configs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe_real_client_configs() {
        let home = home_dir().expect("home");
        for c in ALL_CLIENTS {
            let (path, detected) = c.locate(&home);
            let Some(text) = read_optional(&path).unwrap() else {
                println!("{}: no config at {} (detected: {detected})", c.name(), path.display());
                continue;
            };
            let out = match edit_config(Some(&text), "viboplr-probe", Some(&entry())) {
                Ok(o) => o,
                Err(e) => {
                    println!("{}: unreadable ({e})", c.name());
                    continue;
                }
            };
            let before: serde_json::Value = serde_json::from_str(strip_bom(&text)).unwrap();
            let mut after: serde_json::Value = serde_json::from_str(&out).unwrap();
            after["mcpServers"].as_object_mut().unwrap().remove("viboplr-probe");
            let mut before = before;
            if before.get("mcpServers").is_none() {
                before["mcpServers"] = serde_json::json!({});
            }
            assert_eq!(before, after, "{}: something besides our key changed", c.name());
            println!("{}: ok, {} → {} bytes, {}", c.name(), text.len(), out.len(), path.display());
        }
    }

    #[test]
    fn test_write_keeps_a_backup_of_the_previous_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("cfg.json");
        std::fs::write(&path, "{\"a\":1}").unwrap();
        write_with_backup(&path, Some("{\"a\":1}"), "{\"b\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"b\":2}");
        assert_eq!(std::fs::read_to_string(tmp.path().join("cfg.json.viboplr-backup")).unwrap(), "{\"a\":1}");
    }
}
