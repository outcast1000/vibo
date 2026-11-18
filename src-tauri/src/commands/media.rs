// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

/// The error text a killed exec resolves to. The frontend matches on it to tell
/// "the user cancelled" apart from "the tool failed", so don't reword it without
/// updating `isExecCancelled` in `usePlugins.ts`.
pub const EXEC_CANCELLED: &str = "Cancelled";

struct ExecEntry {
    /// Process-group leader pid — `None` between registration and spawn.
    pid: Option<u32>,
    cancelled: bool,
}

/// Live `plugin_exec` runs that carry an `execId`, so a long tool run (a yt-dlp
/// video download can be minutes) can be killed from the UI instead of being
/// abandoned to finish invisibly. Entries are keyed by the frontend's exec id
/// and removed the moment the child is reaped.
pub struct PluginExecRegistry {
    running: Mutex<std::collections::HashMap<String, ExecEntry>>,
}

impl PluginExecRegistry {
    pub fn new() -> Self {
        Self { running: Mutex::new(std::collections::HashMap::new()) }
    }

    /// Claim an id before spawning. Returns false when a cancel for this id
    /// already landed — the cancel invoke can win the race against the exec
    /// invoke it is cancelling, and the child must not outlive that.
    fn claim(&self, id: &str) -> bool {
        let mut map = self.running.lock().unwrap();
        match map.get(id) {
            Some(e) if e.cancelled => false,
            _ => {
                map.insert(id.to_string(), ExecEntry { pid: None, cancelled: false });
                true
            }
        }
    }

    /// Record the spawned pid. Returns false if a cancel landed in the window
    /// between `claim` and the spawn, in which case the caller kills its child.
    fn attach(&self, id: &str, pid: u32) -> bool {
        let mut map = self.running.lock().unwrap();
        match map.get_mut(id) {
            Some(e) if e.cancelled => false,
            Some(e) => { e.pid = Some(pid); true }
            None => false, // cancelled and swept
        }
    }

    fn finish(&self, id: &str) -> bool {
        self.running.lock().unwrap().remove(id).map(|e| e.cancelled).unwrap_or(false)
    }

    /// Mark the id cancelled and kill its child if one is already running.
    /// Records the cancel even for an unknown id so a not-yet-spawned exec is
    /// stopped at `claim` — the two invokes race and the cancel can arrive
    /// first. Cancelling an id that already finished therefore leaves a small
    /// tombstone behind; exec ids are unique per session, so it is inert, and
    /// it only happens when a cancel lands in the instant a run completes.
    fn cancel(&self, id: &str) -> bool {
        let mut map = self.running.lock().unwrap();
        let entry = map.entry(id.to_string())
            .or_insert(ExecEntry { pid: None, cancelled: false });
        entry.cancelled = true;
        match entry.pid {
            Some(pid) => { kill_process_tree(pid); true }
            None => false,
        }
    }
}

/// SIGKILL the whole process group (helper children — yt-dlp spawns ffmpeg, and
/// the PyInstaller build forks a bootstrap pair — must die with it), falling back
/// to the leader alone. Mirrors the probe-timeout kill in `dependencies.rs`.
fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::process::Stdio;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecOutputEvent {
    exec_id: String,
    stream: &'static str,
    line: String,
}

/// Drain a child pipe, forwarding each completed line to `sink` and returning the
/// output **verbatim** (the returned text is the raw bytes, so a caller parsing
/// stdout sees exactly what `Command::output()` would have given it).
///
/// Lines are split on `\r` as well as `\n`: progress-reporting CLIs (yt-dlp
/// without `--newline`, ffmpeg) redraw one line with carriage returns, and a
/// `\n`-only reader would hold the entire run in its buffer — which is precisely
/// the output a caller streaming for progress is asking for.
fn pump_lines<R: std::io::Read>(reader: R, mut sink: impl FnMut(String)) -> String {
    use std::io::Read;
    let mut reader = std::io::BufReader::new(reader);
    let mut all: Vec<u8> = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                all.extend_from_slice(&buf[..n]);
                for &b in &buf[..n] {
                    if b == b'\n' || b == b'\r' {
                        if !line.is_empty() {
                            sink(String::from_utf8_lossy(&line).to_string());
                            line.clear();
                        }
                    } else {
                        line.push(b);
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !line.is_empty() {
        sink(String::from_utf8_lossy(&line).to_string());
    }
    String::from_utf8_lossy(&all).to_string()
}

#[tauri::command]
pub async fn plugin_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    exec_id: Option<String>,
    stream_output: Option<bool>,
) -> Result<ExecResult, String> {
    let allowed = dependencies::allowed_names();
    if !allowed.contains(&program.as_str()) {
        return Err(format!("Program not allowed: {}. Allowed: {:?}", program, allowed));
    }

    let app_dir = state.app_dir.clone();
    let registry = Arc::clone(&state.plugin_execs);

    // No exec id → the original fire-and-wait path, byte for byte. Most plugin
    // execs are short probes that need neither cancellation nor a line stream,
    // and they must not start paying for pipes and threads.
    let Some(exec_id) = exec_id else {
        return run_blocking(move || -> Result<_, String> {
            // A run of the tool: an automatic update waits for it, and it waits
            // for an automatic update already swapping the files.
            let _in_use = crate::tool_auto_update::begin_use(&program);
            let mut cmd = build_plugin_command(&program, &args, cwd, &app_dir);
            let output = cmd.output()
                .map_err(|e| format!("Failed to run {}: {}", program, e))?;
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            crate::dependencies::note_tls_failure(&program, &stderr);
            Ok(ExecResult {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr,
            })
        })
        .await;
    };

    if !registry.claim(&exec_id) {
        registry.finish(&exec_id);
        return Err(EXEC_CANCELLED.to_string());
    }

    let stream = stream_output.unwrap_or(false);
    run_blocking(move || -> Result<_, String> {
        use std::process::Stdio;
        let _in_use = crate::tool_auto_update::begin_use(&program);
        let mut cmd = build_plugin_command(&program, &args, cwd, &app_dir);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            // Own process group so a cancel takes the helper children with it.
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                registry.finish(&exec_id);
                return Err(format!("Failed to run {}: {}", program, e));
            }
        };
        if !registry.attach(&exec_id, child.id()) {
            kill_process_tree(child.id());
            let _ = child.wait();
            registry.finish(&exec_id);
            return Err(EXEC_CANCELLED.to_string());
        }

        // Both pipes must be drained concurrently — a child that fills the one
        // we aren't reading blocks forever, and yt-dlp writes to both.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let emit = |stream_name: &'static str, line: String| {
            if !stream {
                return;
            }
            let _ = app.emit("plugin-exec-output", ExecOutputEvent {
                exec_id: exec_id.clone(), stream: stream_name, line,
            });
        };
        let (out_text, err_text) = std::thread::scope(|scope| {
            let out_handle = scope.spawn(|| {
                stdout.map(|p| pump_lines(p, |l| emit("stdout", l))).unwrap_or_default()
            });
            let err_handle = scope.spawn(|| {
                stderr.map(|p| pump_lines(p, |l| emit("stderr", l))).unwrap_or_default()
            });
            (
                out_handle.join().unwrap_or_default(),
                err_handle.join().unwrap_or_default(),
            )
        });

        let status = child.wait();
        let cancelled = registry.finish(&exec_id);
        if cancelled {
            return Err(EXEC_CANCELLED.to_string());
        }
        let status = status.map_err(|e| format!("Failed to wait for {}: {}", program, e))?;
        crate::dependencies::note_tls_failure(&program, &err_text);
        Ok(ExecResult {
            exit_code: status.code().unwrap_or(-1),
            stdout: out_text,
            stderr: err_text,
        })
    })
    .await
}

fn build_plugin_command(
    program: &str,
    args: &[String],
    cwd: Option<String>,
    app_dir: &std::path::Path,
) -> std::process::Command {
    let mut cmd = command_with_path(program);
    cmd.args(args);
    match cwd {
        Some(dir) => { cmd.current_dir(dir); }
        None => { cmd.current_dir(app_dir); }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Kill a running `plugin_exec` by its exec id. Returns true when a live child
/// was signalled; false when the id is unknown or hasn't spawned yet (the cancel
/// is still recorded, so the exec dies as it starts).
#[tauri::command]
pub async fn plugin_exec_cancel(
    state: State<'_, AppState>,
    exec_id: String,
) -> Result<bool, String> {
    Ok(state.plugin_execs.cancel(&exec_id))
}

#[tauri::command]
pub async fn check_dependencies(
    state: State<'_, AppState>,
    names: Option<Vec<String>>,
    plugin_deps: Option<Vec<PluginDepDeclaration>>,
    force_refresh: bool,
) -> Result<Vec<dependencies::DependencyInfo>, String> {
    let cache = Arc::clone(&state.dep_cache);
    let plugin_deps = plugin_deps.unwrap_or_default();

    run_blocking(move || -> Result<_, std::convert::Infallible> {
        if force_refresh {
            cache.clear();
        }

        let all = dependencies::all_defs();
        let defs_to_check: Vec<&dependencies::DependencyDef> = match &names {
            Some(names) => all.into_iter().filter(|d| names.iter().any(|n| n == d.name)).collect(),
            None => all,
        };

        Ok(defs_to_check
            .iter()
            .map(|def| {
                let status = dependencies::check_single(def.name, &cache);
                let plugin_consumers: Vec<dependencies::ConsumerInfo> = plugin_deps
                    .iter()
                    .filter(|pd| pd.name == def.name)
                    .map(|pd| dependencies::ConsumerInfo {
                        name: pd.plugin_name.clone(),
                        reason: pd.reason.clone(),
                        required: pd.required,
                    })
                    .collect();

                dependencies::DependencyInfo {
                    name: def.name.to_string(),
                    description: def.description.to_string(),
                    status,
                    internal_consumers: def.internal_consumers.iter().map(|(n, r)| {
                        // Internal (host) consumers always need the dependency.
                        dependencies::ConsumerInfo { name: n.to_string(), reason: r.to_string(), required: true }
                    }).collect(),
                    plugin_consumers,
                    install: def.install.clone(),
                    managed_available: def
                        .managed
                        .as_ref()
                        .is_some_and(|m| m.platform_asset().is_some()),
                    // Cache-only — this command must stay fast and offline.
                    latest_version: cache.get_latest(def.name).flatten(),
                    managed_repo: def.managed.as_ref().map(|m| m.repo.to_string()),
                    declared_by: crate::dependency_registry::declared_by(def.name),
                    signed_definition: crate::dependency_registry::signed_definition(def.name),
                    verified: def
                        .managed
                        .as_ref()
                        .is_none_or(|m| m.checksum != dependencies::Checksum::Unverified),
                    source_mismatch: dependencies::source_mismatch(def.name),
                }
            })
            .collect())
    })
    .await
}

/// Install (or update — same code path, the download URL always points at the
/// latest release) the app-managed copy of a dependency. Only ever the user's
/// click (Tools, the update notice, an install dialog): nothing updates a tool
/// silently.
///
/// A copy running as a plugin's background program in this profile is stopped
/// first (SIGTERM, then a kill after the grace) and started again afterwards
/// with the arguments its plugin registered — after a failed install too, so an
/// update attempt never leaves it stopped. A start a plugin asks for in between
/// is refused (`plugin_programs::begin_update`), and so is a second install of
/// the same tool while one runs; if one copy won't stop, nothing installs and
/// the ones already stopped start again. A copy running from another profile
/// isn't seen (the bin dir is shared): on Windows the swap then fails with "is
/// it running?"; on macOS that copy keeps its open files until it restarts.
///
/// A service that doesn't start again after a successful install is not an
/// install failure: the new copy is in place, so it comes back in
/// `restartErrors` beside the version instead of as an `Err` (which would have
/// the caller offer the same install again).
#[tauri::command]
pub async fn dependency_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    confirmed_unverified: Option<bool>,
) -> Result<DependencyInstallOutcome, String> {
    let cache = Arc::clone(&state.dep_cache);
    let app_dir = state.app_dir.clone();
    let confirmed = confirmed_unverified.unwrap_or(false);
    run_blocking(move || install_dependency(&app, &app_dir, &cache, &name, confirmed, || Ok(()))).await
}

/// The one install path, shared by the user's click (`dependency_install`)
/// and an opted-in automatic update (`dependency_auto_install`). Blocking.
/// `before_swap` runs once the download is verified, before anything is
/// replaced (`dependencies::install_managed_gated`); the click passes a no-op.
fn install_dependency<G>(
    app: &tauri::AppHandle,
    app_dir: &std::path::Path,
    cache: &dependencies::DepCache,
    name: &str,
    confirmed: bool,
    before_swap: impl FnOnce() -> Result<G, String>,
) -> Result<DependencyInstallOutcome, String> {
    // The guard first, then the list: a start arriving after the guard is
    // refused, and one already past its check holds the store lock until
    // its pid is stamped, so waiting for that lock puts it in the list.
    let updating = crate::plugin_programs::begin_update(name)?;
    drop(crate::plugin_programs::approved::store_lock());
    let running = crate::plugin_programs::running_for_dependency(app_dir, name);
    let mut stopped = Vec::new();
    let mut stop_error = None;
    for reg in &running {
        log::info!("Stopping {}:{} to update {}", reg.plugin_id, reg.name, name);
        match crate::plugin_programs::stop(app_dir, &reg.plugin_id, &reg.name, SERVICE_UPDATE_GRACE) {
            Ok(_) => stopped.push(reg.clone()),
            Err(e) => {
                stop_error = Some(format!("Couldn't stop {} to update {}: {}", reg.name, name, e));
                break;
            }
        }
    }
    // One still running would be swapped from under (and restarted as a
    // second copy), so nothing installs; the ones already stopped start again.
    let result = match &stop_error {
        Some(e) => Err(e.clone()),
        None => dependencies::install_managed_gated(
            name,
            cache,
            confirmed,
            |downloaded, total| {
                let _ = app.emit(
                    "dependency-install-progress",
                    serde_json::json!({ "name": name, "downloaded": downloaded, "total": total }),
                );
            },
            before_swap,
        ),
    };
    drop(updating);
    let mut restart_errors = Vec::new();
    for reg in &stopped {
        match crate::plugin_programs::restart(app_dir, reg) {
            Ok(()) => {
                let _ = app.emit(
                    "program-restarted",
                    serde_json::json!({ "pluginId": reg.plugin_id, "name": reg.name }),
                );
            }
            Err(e) => {
                log::warn!("{}:{} didn't start again after the update: {}", reg.plugin_id, reg.name, e);
                restart_errors.push(format!("{} didn't start again: {}", reg.name, e));
            }
        }
    }
    let version = result.map_err(|e| match restart_errors.is_empty() {
        true => e,
        false => format!("{e}\n{}", restart_errors.join("\n")),
    })?;
    let _ = app.emit(
        "dependency-installed",
        serde_json::json!({ "name": name, "version": version }),
    );
    log::info!("Installed managed {} {}", name, version);
    Ok(DependencyInstallOutcome { version, restart_errors })
}

/// One tool's auto-update state, for the Tools row and the update notice.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAutoUpdateState {
    name: String,
    #[serde(flatten)]
    prefs: crate::tool_auto_update::ToolPrefs,
    /// Why it can't be switched on, when it can't (guardrails 1–4).
    ineligible: Option<crate::tool_auto_update::Ineligible>,
    ineligible_message: Option<String>,
}

fn auto_update_state(
    app_dir: &std::path::Path,
    name: &str,
    prefs: crate::tool_auto_update::ToolPrefs,
) -> ToolAutoUpdateState {
    let facts = crate::tool_auto_update::facts_for(app_dir, name);
    let ineligible = crate::tool_auto_update::eligibility(&facts).err();
    ToolAutoUpdateState {
        name: name.to_string(),
        prefs,
        ineligible,
        ineligible_message: ineligible.map(|i| i.message(name)),
    }
}

/// Every managed tool's auto-update state. Reads files only — it never runs a
/// tool (`facts_for`), so it is safe on the startup path.
#[tauri::command]
pub async fn tool_auto_update_get(state: State<'_, AppState>) -> Result<Vec<ToolAutoUpdateState>, String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || {
        let prefs = crate::tool_auto_update::read_prefs();
        Ok::<_, std::convert::Infallible>(
            dependencies::all_defs()
                .into_iter()
                .filter(|def| def.managed.as_ref().is_some_and(|m| m.platform_asset().is_some()))
                .map(|def| {
                    let entry = prefs.get(def.name).cloned().unwrap_or_default();
                    auto_update_state(&app_dir, def.name, entry)
                })
                .collect(),
        )
    })
    .await
}

/// The user's switch on the Tools row or the update notice's offer. Turning it
/// on is refused for a tool outside the guardrails; turning it off never is.
#[tauri::command]
pub async fn tool_auto_update_set(
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> Result<ToolAutoUpdateState, String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || -> Result<_, String> {
        if enabled {
            let facts = crate::tool_auto_update::facts_for(&app_dir, &name);
            if let Err(why) = crate::tool_auto_update::eligibility(&facts) {
                return Err(why.message(&name));
            }
        }
        let prefs = crate::tool_auto_update::update_prefs(&name, |e| {
            crate::tool_auto_update::apply_user_choice(e, enabled)
        })?;
        log::info!("Automatic updates for {} turned {}", name, if enabled { "on" } else { "off" });
        Ok(auto_update_state(&app_dir, &name, prefs))
    })
    .await
}

/// "No thanks" on the update notice's offer: it isn't asked again.
#[tauri::command]
pub async fn tool_auto_update_decline_offer(name: String) -> Result<(), String> {
    run_blocking(move || {
        crate::tool_auto_update::update_prefs(&name, |e| e.offer_declined = true).map(|_| ())
    })
    .await
}

/// What an automatic update attempt did. `rename_all_fields` is load-bearing:
/// on an enum `rename_all` renames only the variants, so without it the
/// frontend got `restart_errors` / `switched_off` / `retry_later`, threw on
/// `restartErrors.length`, and never cleared the tool's Update button.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum AutoInstallOutcome {
    Installed { from: Option<String>, to: String, restart_errors: Vec<String> },
    /// Nothing was installed; `reason` is a kebab-case code (`in-use` is the
    /// only one that downloaded first — see `autoAttemptDownloaded`), and
    /// `retry_later` says the frontend may ask again soon.
    Skipped { reason: String, retry_later: bool },
    Failed { error: String, switched_off: bool },
}

/// Install an update of `name` because the user turned its automatic updates
/// on — never otherwise. Every guardrail is re-checked here, whatever the
/// frontend believed (see `tool_auto_update.rs`).
#[tauri::command]
pub async fn dependency_auto_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<AutoInstallOutcome, String> {
    use crate::tool_auto_update as auto;
    let cache = Arc::clone(&state.dep_cache);
    let app_dir = state.app_dir.clone();
    run_blocking(move || -> Result<_, String> {
        let skip = |reason: &str, retry_later: bool| {
            Ok(AutoInstallOutcome::Skipped { reason: reason.to_string(), retry_later })
        };
        let prefs = auto::read_prefs().get(&name).cloned().unwrap_or_default();
        if !prefs.enabled {
            return skip("off", false);
        }
        if let Err(why) = auto::eligibility(&auto::facts_for(&app_dir, &name)) {
            log::info!("Not updating {} automatically: {}", name, why.message(&name));
            return skip("ineligible", false);
        }
        let now = auto::now_secs();
        if auto::attempted_recently(&prefs, now) {
            return skip("too-soon", false);
        }
        // The real origin, from the version probe: the file being on disk
        // (what `facts_for` reads) isn't proof it's the copy in use.
        let installed = match dependencies::check_single(&name, &cache) {
            dependencies::DepStatus::Installed { version, origin: dependencies::DepOrigin::Managed } => version,
            _ => return skip("ineligible", false),
        };
        let latest = match dependencies::latest_version(&name, &cache) {
            Ok(v) => v,
            Err(_) => return skip("no-answer", false),
        };
        if !dependencies::version_lt(&installed, &latest) {
            return skip("up-to-date", false);
        }
        // The user's own install of it is running: theirs wins, ask again later.
        if crate::plugin_programs::is_updating(&name) {
            return skip("busy", true);
        }
        // Guardrail 5, around the swap alone: the download and its checksum
        // check run with nothing held, so a search waits seconds, not for the
        // whole download. Busy at that moment, the verified download is
        // discarded and this is a skip, not a failure.
        let gate_name = name.clone();
        let gate_dir = app_dir.clone();
        let before_swap = move || -> Result<auto::InstallGuard, String> {
            let guard = auto::begin_auto_install(&gate_name).ok_or_else(|| auto::SWAP_IN_USE.to_string())?;
            // A background program (any profile) would be swapped from under.
            if auto::running_as_service_anywhere(&gate_dir, &gate_name) {
                return Err(auto::SWAP_IN_USE.to_string());
            }
            Ok(guard)
        };
        match install_dependency(&app, &app_dir, &cache, &name, false, before_swap) {
            Ok(outcome) => {
                auto::update_prefs(&name, |e| {
                    auto::record_success(e, Some(installed.clone()), outcome.version.clone(), now)
                })?;
                log::info!("Auto-updated {} {} → {}", name, installed, outcome.version);
                Ok(AutoInstallOutcome::Installed {
                    from: Some(installed),
                    to: outcome.version,
                    restart_errors: outcome.restart_errors,
                })
            }
            // Not failures of the update, so neither counts toward switching it
            // off. `in-use`: verified, then the tool was busy at swap time (the
            // download is gone). `busy`: the user's own install of it started
            // in between and refused this one (`begin_update`) before any
            // download — the progress on screen is theirs.
            Err(error) if error == auto::SWAP_IN_USE => {
                log::info!("Automatic update of {} postponed: {}", name, error);
                skip("in-use", true)
            }
            Err(error) if error == format!("{name} is already being updated") => skip("busy", true),
            Err(error) => {
                let mut switched_off = false;
                auto::update_prefs(&name, |e| switched_off = auto::record_failure(e, error.clone(), now))?;
                log::warn!(
                    "Automatic update of {} failed: {}{}",
                    name,
                    error,
                    if switched_off { " — automatic updates for it are now off" } else { "" }
                );
                Ok(AutoInstallOutcome::Failed { error, switched_off })
            }
        }
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInstallOutcome {
    version: String,
    /// Services that didn't start again on the new copy, one line each.
    restart_errors: Vec<String>,
}

/// How long a service gets to shut down cleanly before an update kills it.
const SERVICE_UPDATE_GRACE: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyService {
    plugin_id: String,
    name: String,
    running: bool,
    started_at: Option<u64>,
}

/// The background programs of this profile that run Vibo's copy of `name`
/// (the Tools row's status line). Read-only: starting and stopping is the
/// plugin's.
#[tauri::command]
pub async fn dependency_services(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<DependencyService>, String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || {
        Ok::<_, std::convert::Infallible>(
            crate::plugin_programs::services_for_dependency(&app_dir, &name)
                .into_iter()
                .map(|(reg, running)| DependencyService {
                    plugin_id: reg.plugin_id,
                    name: reg.name,
                    running,
                    started_at: if running { reg.started_at } else { None },
                })
                .collect(),
        )
    })
    .await
}

/// Remove the app-managed copy of a dependency, falling back to any system
/// copy on PATH. Returns the new origin ("system") or null if nothing remains.
#[tauri::command]
pub async fn dependency_uninstall_managed(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<String>, String> {
    let cache = Arc::clone(&state.dep_cache);
    let app_dir = state.app_dir.clone();
    run_blocking(move || -> Result<_, String> {
        // Starting and stopping a service is its plugin's; removal doesn't pull
        // the files out from under one.
        if let Some(reg) = crate::plugin_programs::running_for_dependency(&app_dir, &name).first() {
            return Err(format!("{} is running (started by {}); stop it there first", name, reg.plugin_id));
        }
        let status = dependencies::uninstall_managed(&name, &cache)?;
        log::info!("Removed managed copy of {}", name);
        Ok(match status {
            dependencies::DepStatus::Installed { origin, .. } => Some(
                match origin {
                    dependencies::DepOrigin::Managed => "managed",
                    dependencies::DepOrigin::System => "system",
                }
                .to_string(),
            ),
            _ => None,
        })
    })
    .await
}

/// Latest-vs-installed comparison for every managed dependency. One
/// `releases/latest` redirect probe per dep per 24h (TTL-cached, failures
/// included) — never the rate-limited GitHub API; see `latest_version`.
/// `force` (Extensions → Tools → Refresh) drops that cache first, so a
/// release published since the last lookup shows up now, not tomorrow.
#[tauri::command]
pub async fn dependency_check_updates(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<Vec<dependencies::DepUpdateInfo>, String> {
    let cache = Arc::clone(&state.dep_cache);
    if force.unwrap_or(false) {
        cache.clear_latest();
    }
    run_blocking(move || -> Result<_, std::convert::Infallible> {
        Ok(dependencies::all_defs()
            .into_iter()
            .filter(|def| def.managed.as_ref().is_some_and(|m| m.platform_asset().is_some()))
            .map(|def| {
                let (installed, origin) = match dependencies::check_single(def.name, &cache) {
                    dependencies::DepStatus::Installed { version, origin } => {
                        (Some(version), Some(origin))
                    }
                    _ => (None, None),
                };
                let latest = dependencies::latest_version(def.name, &cache).ok();
                let outdated = match (&installed, &latest) {
                    (Some(i), Some(l)) => dependencies::version_lt(i, l),
                    _ => false,
                };
                dependencies::DepUpdateInfo {
                    name: def.name.to_string(),
                    installed,
                    latest,
                    outdated,
                    origin,
                    source_mismatch: dependencies::source_mismatch(def.name),
                    verified: def
                        .managed
                        .as_ref()
                        .is_none_or(|m| m.checksum != dependencies::Checksum::Unverified),
                }
            })
            .collect())
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyRegistryStatus {
    #[serde(flatten)]
    registry: crate::dependency_registry::RegistryStatus,
    /// Managed copies no definition in force claims.
    unused: Vec<String>,
}

/// What the plugin-declared tools are waiting on: unsigned definitions awaiting
/// consent, conflicts, refused definitions, and unused managed copies.
#[tauri::command]
pub async fn dependency_registry_status() -> Result<DependencyRegistryStatus, String> {
    run_blocking(|| {
        Ok::<_, std::convert::Infallible>(DependencyRegistryStatus {
            registry: crate::dependency_registry::status(),
            unused: dependencies::unused_managed(),
        })
    })
    .await
}

/// Where tool `name` stands for plugin `plugin_id` — in force, waiting for
/// consent, refused or undefined.
/// Read when a plugin asks for the tool, so the answer is the registry's now,
/// not a copy the webview fetched earlier.
#[tauri::command]
pub async fn dependency_definition_state(
    plugin_id: String,
    name: String,
) -> Result<DefinitionStateReply, String> {
    run_blocking(move || {
        let state = crate::dependency_registry::definition_state(&plugin_id, &name);
        // Without a definition in force a copy already here still can't be
        // used, but the user should hear that it's there rather than "couldn't
        // install" about a tool they have.
        let present = !matches!(state, crate::dependency_registry::DefinitionState::Active)
            && dependencies::found_on_machine(&name);
        Ok::<_, std::convert::Infallible>(DefinitionStateReply { state, present })
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionStateReply {
    #[serde(flatten)]
    state: crate::dependency_registry::DefinitionState,
    /// No definition in force, yet a copy of the tool is on this machine.
    present: bool,
}

/// The user agreed, in the host's warning dialog, to let an unsigned plugin's
/// definitions be used. Only fingerprints the plugin is waiting on are taken.
#[tauri::command]
pub async fn dependency_definitions_consent(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    fingerprints: Vec<String>,
) -> Result<(), String> {
    let profile = state.app_dir.clone();
    let cache = Arc::clone(&state.dep_cache);
    run_blocking(move || -> Result<(), String> {
        crate::dependency_registry::grant_consent(&profile, &plugin_id, &fingerprints)?;
        cache.clear();
        let _ = app.emit("dependencies-changed", ());
        Ok(())
    })
    .await
}

/// Take back the consents an unsigned plugin's definitions ran under.
#[tauri::command]
pub async fn dependency_definitions_revoke(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<(), String> {
    let profile = state.app_dir.clone();
    let cache = Arc::clone(&state.dep_cache);
    run_blocking(move || -> Result<(), String> {
        crate::dependency_registry::revoke_consent(&profile, &plugin_id)?;
        cache.clear();
        let _ = app.emit("dependencies-changed", ());
        Ok(())
    })
    .await
}

/// Delete a managed copy that no definition claims any more.
#[tauri::command]
pub async fn dependency_remove_unused(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || {
        // Same rule as dependency_uninstall_managed: a service whose definition
        // left force can still be running from the folder.
        if let Some(reg) = crate::plugin_programs::running_for_dependency(&app_dir, &name).first() {
            return Err(format!("{} is running (started by {}); stop it there first", name, reg.plugin_id));
        }
        dependencies::remove_unused(&name)
    })
    .await
}

#[tauri::command]
pub fn get_video_frames(
    state: State<'_, AppState>,
    track_id: i64,
) -> Option<VideoFrameResult> {
    let app_dir = &state.app_dir;
    crate::video_frames::get_cached_frames(app_dir, track_id).map(|cached| VideoFrameResult {
        status: "ok".to_string(),
        paths: Some(cached.paths),
        timestamps: if cached.timestamps.is_empty() { None } else { Some(cached.timestamps) },
    })
}

#[tauri::command]
pub async fn extract_video_frames(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<VideoFrameResult, String> {
    let app_dir = state.app_dir.clone();
    with_db(&state, move |db| -> Result<_, String> {
        if !crate::video_frames::is_ffmpeg_available() {
            return Ok(VideoFrameResult { status: "unavailable".to_string(), paths: None, timestamps: None });
        }

        if let Some(cached) = crate::video_frames::get_cached_frames(&app_dir, track_id) {
            return Ok(VideoFrameResult {
                status: "ok".to_string(),
                paths: Some(cached.paths),
                timestamps: if cached.timestamps.is_empty() { None } else { Some(cached.timestamps) },
            });
        }

        let track = db.get_track_by_id(track_id)
            .map_err(|e| format!("DB error: {}", e))?;

        if track.is_remote() {
            return Err("Cannot extract frames from remote tracks".to_string());
        }

        let fs_path = track.filesystem_path()
            .ok_or_else(|| "Track has no local file path".to_string())?;

        let video_path = std::path::Path::new(fs_path);
        if !video_path.exists() {
            return Err(format!("Video file not found: {}", fs_path));
        }

        let is_video = video_path.extension()
            .and_then(|e| e.to_str())
            .map(|e| crate::scanner::VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_video {
            return Err(format!("Track is not a supported video file: {}", fs_path));
        }

        let (paths, timestamps) = crate::video_frames::extract_frames(&app_dir, track_id, video_path)?;

        Ok(VideoFrameResult {
            status: "ok".to_string(),
            paths: Some(paths),
            timestamps: Some(timestamps),
        })
    })
    .await
}

#[tauri::command]
pub fn get_track_audio_properties(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<AudioProperties, String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;
    let bare_path = track.filesystem_path()
        .ok_or("Track has no local file path")?
        .to_string();

    use lofty::prelude::*;

    let tagged_file = crate::tag_writer::read_tagged_file(&bare_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let props = tagged_file.properties();

    Ok(AudioProperties {
        sample_rate: props.sample_rate(),
        bit_depth: props.bit_depth(),
        channels: props.channels(),
        bitrate: props.overall_bitrate(),
        duration_secs: Some(props.duration().as_secs_f64()).filter(|d| *d > 0.0),
    })
}

/// `async` + `spawn_blocking` like `read_file_tags`: a non-async command runs
/// inline on the main thread, and the now-playing source panel asks this on
/// every local track change. A lofty parse on a busy disk (a library rescan of
/// the same drive) froze the whole window for ~30s on the first video played.
#[tauri::command]
pub async fn get_audio_properties_by_path(
    path: String,
) -> Result<AudioProperties, String> {
    run_blocking(move || -> Result<AudioProperties, String> {
        let bare_path = path.strip_prefix("file://").unwrap_or(&path);

        use lofty::prelude::*;

        let tagged_file = crate::tag_writer::read_tagged_file(bare_path)
            .map_err(|e| format!("Failed to read file: {}", e))?;

        let props = tagged_file.properties();

        Ok(AudioProperties {
            sample_rate: props.sample_rate(),
            bit_depth: props.bit_depth(),
            channels: props.channels(),
            bitrate: props.overall_bitrate(),
            duration_secs: Some(props.duration().as_secs_f64()).filter(|d| *d > 0.0),
        })
    })
    .await
}

/// Local lyrics for a track (issue #131): embedded tag lyrics, a sidecar
/// `.lrc`/`.txt` named like the audio file, or the same inside a `Lyrics/`
/// subfolder — in that order; a synced hit beats a plain one, here and across
/// the candidate files below (`local_lyrics::prefer_synced`).
///
/// `path` (when the caller holds one — the playing queue entry, the selected
/// library row) comes first; after it, every **local** library copy of the
/// metadata match, so a queue entry playing a remote copy still finds the
/// lyrics sitting next to the user's own file. Metadata candidates are kept
/// only when their artist matches the asked-for artist: the lookup's
/// title-only fallback tier can land on a different artist's song of the same
/// name, and silently wrong lyrics are worse than none.
///
/// **A library track is answered from what the scan stored** (`track_lyrics`,
/// read only when a scan reads the file's tags — new or changed file, or a
/// Full Rescan), so showing lyrics doesn't touch the disk. The files are read
/// here only for a track the scan hasn't probed yet (a library scanned before
/// lyrics were stored, until its next Full Rescan) and for a file outside the
/// library (dropped into the queue).
///
/// `async` + `spawn_blocking`: a non-async command runs inline on the main
/// thread, and the fallback touches disk (possibly a network mount).
#[tauri::command]
pub async fn get_local_lyrics(
    state: State<'_, AppState>,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
    path: Option<String>,
) -> Result<Option<crate::local_lyrics::LocalLyrics>, String> {
    with_db(&state, move |db| -> Result<_, std::convert::Infallible> {
        let candidates = local_lyrics_candidates(db, &title, artist_name.as_deref(), album_name.as_deref(), path.as_deref());
        Ok(crate::local_lyrics::prefer_synced(candidates.into_iter().filter_map(|(audio, track_id)| {
            match track_id.and_then(|id| db.get_track_lyrics(id).ok().flatten()) {
                Some(stored) => stored
                    .text
                    .map(|text| crate::local_lyrics::from_stored(audio, text, stored.source.as_deref())),
                None => crate::local_lyrics::probe_local_lyrics(&audio),
            }
        })))
    })
    .await
}

/// The files a song's local lyrics may sit beside, each with its library
/// track id when it has one: the caller's path first, then every local library
/// copy of the metadata match whose artist matches (see `get_local_lyrics` for
/// why the artist check).
fn local_lyrics_candidates(
    db: &crate::db::Database,
    title: &str,
    artist_name: Option<&str>,
    album_name: Option<&str>,
    path: Option<&str>,
) -> Vec<(std::path::PathBuf, Option<i64>)> {
    let mut candidates: Vec<(std::path::PathBuf, Option<i64>)> = Vec::new();
    if let Ok(tracks) = db.find_tracks_by_metadata(title, artist_name, album_name) {
        let wanted_artist = artist_name.map(|a| crate::db::likes::norm_segment(Some(a)));
        for t in tracks {
            if let Some(wanted) = &wanted_artist {
                if &crate::db::likes::norm_segment(t.artist_name.as_deref()) != wanted {
                    continue;
                }
            }
            if let Some(bare) = t.path.strip_prefix("file://") {
                let pb = std::path::PathBuf::from(bare);
                if !candidates.iter().any(|(p, _)| p == &pb) {
                    candidates.push((pb, Some(t.id)));
                }
            }
        }
    }
    // The caller's path goes first. Usually it is one of the metadata matches
    // already, whose id is reused; only a path they don't cover (edited queue
    // metadata, a file outside the library) costs the by-path lookup, which
    // can't use an index.
    if let Some(uri) = path.filter(|p| p.starts_with("file://")) {
        let pb = std::path::PathBuf::from(&uri["file://".len()..]);
        let entry = match candidates.iter().position(|(p, _)| p == &pb) {
            Some(i) => candidates.remove(i),
            None => (pb, db.find_track_id_by_path(uri).ok().flatten()),
        };
        candidates.insert(0, entry);
    }
    candidates
}


/// The in-app lyrics editor saving lyrics that came from the track's own
/// files. Runs the same lookup as `get_local_lyrics` and saves into the source
/// that answered — the tag and key that held embedded lyrics, or the sidecar /
/// `Lyrics/` folder file (`local_lyrics::save_and_verify`; a replaced file's
/// previous version goes to the Trash). Answers with the lyrics as that audio
/// file now reads, for the caller to put in the cache — or an error when the
/// edit was saved but something else for that file still outranks it.
///
/// **Only lyrics of a library or queue file are written.** The lookup's
/// candidates are library rows, plus the caller's `path` hint; a hint that is
/// neither a library file nor in the saved queue (`main_playlist::track_paths`)
/// is refused, so webview code can't point this at an arbitrary file on disk.
/// The same gate as `trash_queue_files` — and, as there, it bounds accidents
/// and casual misuse rather than being a security boundary, since
/// `main_playlist_write` is itself webview-callable.
///
/// `async` + `run_blocking`: disk I/O and a tag write, possibly on a network
/// mount.
#[tauri::command]
pub async fn save_local_lyrics(
    state: State<'_, AppState>,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
    path: Option<String>,
    text: String,
) -> Result<crate::local_lyrics::LocalLyrics, String> {
    let db = state.db.clone();
    let app_dir = state.app_dir.clone();
    run_blocking(move || -> Result<_, String> {
        let candidates =
            local_lyrics_candidates(&db, &title, artist_name.as_deref(), album_name.as_deref(), path.as_deref());
        let on_disk: Vec<_> = candidates
            .iter()
            .map(|(audio, id)| (*id, crate::local_lyrics::probe_local_lyrics(audio)))
            .collect();
        // What the editor showed came from the last scan. If a library copy's
        // files say something else now (a .lrc deleted or changed since), the
        // edit would land somewhere the user didn't see: record what the files
        // say and stop, so the page shows the current lyrics first.
        let mut changed_since_scan = false;
        for (id, now) in &on_disk {
            let Some(id) = id else { continue };
            let Ok(Some(stored)) = db.get_track_lyrics(*id) else { continue };
            if stored.text.as_deref() != now.as_ref().map(|l| l.text.as_str()) {
                if let Err(e) = db.set_track_lyrics(*id, now.as_ref().map(|l| (l.text.as_str(), l.source))) {
                    log::warn!("Couldn't record the current lyrics of track {}: {}", id, e);
                }
                changed_since_scan = true;
            }
        }
        if changed_since_scan {
            return Err(
                "These lyrics changed in the track's files since the last scan. Close the editor to see what's there now, then edit again"
                    .to_string(),
            );
        }
        let found = crate::local_lyrics::prefer_synced(on_disk.into_iter().filter_map(|(_, l)| l)).ok_or_else(|| {
            "The track's lyrics are gone from its files, so there is nothing to save into. Reopen the track to see what it has now"
                .to_string()
        })?;
        if !crate::scanner::is_media_file(&found.audio) {
            return Err(format!("{} isn't a music or video file", found.audio.display()));
        }
        let uri = format!("file://{}", found.audio.to_string_lossy());
        let in_library = db.library_paths_among(std::slice::from_ref(&uri)).map_err(|e| e.to_string())?;
        if !in_library.contains(&uri) && !crate::main_playlist::track_paths(&app_dir).contains(&uri) {
            return Err("Only lyrics of a file in your library or your queue can be edited".to_string());
        }
        let saved = crate::local_lyrics::save_and_verify(&found, &text, &crate::local_lyrics::displace_lyrics_file);
        // Keep what the scan stored in step with the files — also when the
        // save errored after writing (an edit something else outranks), so
        // the stored row is what the files say either way.
        if let Ok(Some(track_id)) = db.find_track_id_by_path(&uri) {
            let now = match &saved {
                Ok(now) => Some(now.clone()),
                Err(_) => crate::local_lyrics::probe_local_lyrics(&found.audio),
            };
            if let Err(e) = db.set_track_lyrics(track_id, now.as_ref().map(|l| (l.text.as_str(), l.source))) {
                log::warn!("Saved lyrics for {} but couldn't record them: {}", found.audio.display(), e);
            }
        }
        let now = saved?;
        log::info!("Saved edited lyrics for {} ({})", found.audio.display(), found.source);
        Ok(now)
    })
    .await
}

/// Read embedded tags for a batch of local files — one result per input path, in
/// order, `None` for anything unreadable (missing file, or a container lofty
/// can't parse).
///
/// **Batched** because the caller is typically queueing a whole release at once
/// (a plugin turning a finished torrent into queue entries), and one invoke per
/// file would be N IPC round trips for a single user action.
///
/// **`async` + `spawn_blocking`** because a non-async command runs inline on the
/// main thread: probing forty files on a network mount would otherwise freeze the
/// webview for the duration.
///
/// **No filename fallback, deliberately** — unlike `scanner::read_tags`, which
/// falls through to its own regexes when a tag is missing. A caller reaching for
/// this holds context those patterns don't (a torrent name, a release folder, its
/// own parse), so an absent tag is reported as `None` and the caller's own guess
/// stands. The one thing still worth returning from an untagged file is its
/// duration: a queue entry with no length shows no seek bar and never scrobbles.
#[tauri::command]
pub async fn read_file_tags(paths: Vec<String>) -> Result<Vec<Option<FileTags>>, String> {
    run_blocking(move || {
        Ok::<_, std::convert::Infallible>(paths.iter().map(|p| read_one_file_tags(p)).collect())
    })
    .await
}

fn read_one_file_tags(path: &str) -> Option<FileTags> {
    use lofty::prelude::*;

    let bare_path = path.strip_prefix("file://").unwrap_or(path);
    let tagged_file = crate::tag_writer::read_tagged_file(bare_path).ok()?;

    let duration = tagged_file.properties().duration();
    let duration_secs = Some(duration.as_secs_f64()).filter(|&d| d > 0.0);

    let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) else {
        return Some(FileTags { duration_secs, ..Default::default() });
    };

    // Same Latin-1 / codepage repair the scanner applies, for the same reason:
    // ID3v1 and Latin-1-declared ID3v2 frames arrive garbled otherwise, and files
    // carrying them are exactly the ones a caller reaches for tags to fix.
    let text = |s: Option<std::borrow::Cow<'_, str>>| -> Option<String> {
        s.map(|v| crate::scanner::fix_encoding(&v))
            .filter(|v| !v.trim().is_empty())
    };

    Some(FileTags {
        title: text(tag.title()),
        artist: text(tag.artist()),
        album_artist: tag
            .get_string(lofty::tag::ItemKey::AlbumArtist)
            .map(crate::scanner::fix_encoding)
            .filter(|v| !v.trim().is_empty()),
        album: text(tag.album()),
        track_number: tag.track(),
        disc_number: tag.disk(),
        year: tag.date().map(|d| d.year as i32),
        genre: text(tag.genre()),
        duration_secs,
    })
}

/// Cache-only storyboard lookup, keyed by the track's scheme-prefixed path. Never
/// generates, so the seek bar can ask on every track change for free.
#[tauri::command]
pub fn get_storyboard(
    state: State<'_, AppState>,
    path: String,
) -> Option<crate::storyboard::Storyboard> {
    crate::storyboard::get_cached(&state.app_dir, &path)
}

/// Frames extracted so far while a storyboard generates, so the filmstrip can fill
/// in progressively instead of sitting on placeholders. `path` is the track's
/// scheme-prefixed path — the same key the requesting frontend holds — and
/// `frame_paths` is cumulative, in time order.
///
/// `start_index` is the tile the FIRST frame depicts, so frame i covers
/// `(start_index + i) * interval_secs`. It is 0 for a fresh pass and non-zero when
/// resuming one that was cancelled part-way, where the frames on disk begin
/// mid-video — read positionally they would be captioned with the wrong timestamps.
///
/// `tile_w`/`tile_h` are the pixel size of the extracted frames — i.e. the movie's
/// display aspect, which the frontend cannot know until the finished sheet arrives.
/// Without them the progressive board had to assume 16:9 and stretched every 4:3,
/// scope or portrait video. `None` when the first frame's header can't be read yet.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardPartial {
    pub path: String,
    pub frame_paths: Vec<String>,
    pub start_index: usize,
    pub interval_secs: f64,
    pub count: usize,
    pub tile_w: Option<u32>,
    pub tile_h: Option<u32>,
}

/// Generate the storyboard for a local video if it isn't cached yet. One ffmpeg pass;
/// see `storyboard.rs`. Returns a status rather than erroring for the expected
/// "can't do this" cases, so the frontend can stay quiet about them. While ffmpeg
/// runs, `storyboard-partial` events stream the frames extracted so far.
///
/// `request_id` is the caller's own token: it registers this surface's interest in
/// the sheet (generation is single-flight but several surfaces want the same one),
/// and passing it to `cancel_storyboard` withdraws that interest. The pass is killed
/// once every interested caller has withdrawn — see `storyboard::Runs`.
#[tauri::command]
pub async fn extract_storyboard(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    request_id: String,
) -> Result<StoryboardResult, String> {
    let app_dir = state.app_dir.clone();

    run_blocking(move || -> Result<_, String> {
        // False = the cancel raced ahead of this invoke; don't start at all.
        if !crate::storyboard::begin_request(&path, &request_id) {
            return Ok(StoryboardResult { status: "cancelled".to_string(), storyboard: None });
        }
        let _interest = InterestGuard(path.clone(), request_id.clone());
        if let Some(cached) = crate::storyboard::get_cached(&app_dir, &path) {
            return Ok(StoryboardResult { status: "ok".to_string(), storyboard: Some(cached) });
        }
        // Local files only: ffmpeg needs a real file, and re-streaming a remote source
        // per video would cost bandwidth. Plugin sources supply their own storyboards.
        let Some(bare) = path.strip_prefix("file://") else {
            return Ok(StoryboardResult { status: "unsupported".to_string(), storyboard: None });
        };
        if !crate::video_frames::is_ffmpeg_available() {
            return Ok(StoryboardResult { status: "unavailable".to_string(), storyboard: None });
        }
        let video_path = std::path::Path::new(bare);
        let duration = crate::video_frames::get_video_duration(video_path)?;
        if !crate::storyboard::worth_generating(duration) {
            // Under a minute: scrubbed by eye, so no pass. The seek bar keeps its
            // plain surface, as for any video without a storyboard.
            return Ok(StoryboardResult { status: "unsupported".to_string(), storyboard: None });
        }
        let g = crate::storyboard::geometry(duration);
        // Every frame is scaled to the same size, so read it once (header only).
        let mut tile_dims: Option<(u32, u32)> = None;
        let board = match crate::storyboard::generate_with_progress(
            &app_dir,
            &path,
            video_path,
            duration,
            Some(&request_id),
            |start_index, frames| {
                if tile_dims.is_none() {
                    tile_dims = frames.first().and_then(|f| image::image_dimensions(f).ok());
                }
                let _ = app.emit("storyboard-partial", StoryboardPartial {
                    path: path.clone(),
                    frame_paths: frames.to_vec(),
                    start_index,
                    interval_secs: g.interval_secs,
                    count: g.count,
                    tile_w: tile_dims.map(|d| d.0),
                    tile_h: tile_dims.map(|d| d.1),
                });
            },
        ) {
            Ok(board) => board,
            // A cancelled pass is not a failure: the caller already stopped caring,
            // so it gets a status instead of an error to log.
            Err(e) if e == crate::storyboard::CANCELLED => {
                return Ok(StoryboardResult { status: "cancelled".to_string(), storyboard: None });
            }
            Err(e) => return Err(e),
        };
        Ok(StoryboardResult { status: "ok".to_string(), storyboard: Some(board) })
    })
    .await
}

/// Drops the caller's interest however `extract_storyboard` returns, so a request
/// can never leak and pin a pass alive.
struct InterestGuard(String, String);

impl Drop for InterestGuard {
    fn drop(&mut self) {
        crate::storyboard::end_request(&self.0, &self.1);
    }
}

/// Withdraw a surface's interest in a storyboard it asked for (`request_id` is the
/// one it passed to `extract_storyboard`). The ffmpeg pass stops within ~80 ms once
/// nobody is left waiting for it; a still-interested surface keeps it running.
/// Idempotent, and safe to call before the extract invoke has even landed.
#[tauri::command]
pub fn cancel_storyboard(path: String, request_id: String) {
    crate::storyboard::cancel_request(&path, &request_id);
}

/// Byte size of a local file. A plain `stat` — much cheaper than
/// `get_audio_properties_by_path`, which reads tags. `None` when the path isn't
/// a local file or can't be stat'd, so callers can treat "unknown" as distinct
/// from zero rather than inferring a size.
#[tauri::command]
pub fn get_file_size(path: String) -> Option<u64> {
    let bare_path = path.strip_prefix("file://").unwrap_or(&path);
    std::fs::metadata(bare_path).ok().map(|m| m.len())
}

/// The size a queue row shows: the library row's — which also covers Subsonic,
/// whose size the server reported at sync — then, for a local file the library
/// doesn't hold, the file on disk. Queue entries carry no size of their own,
/// so this is the one answer. `None` = unknown (a stream, a missing file).
///
/// The disk read runs after the database work, on its own blocking task: a
/// file on an offline network share can take seconds to stat, and must not
/// hold the database closure (and the commands queued behind it) meanwhile.
#[tauri::command]
pub async fn queue_entry_file_size(state: State<'_, AppState>, path: String) -> Result<Option<u64>, String> {
    let lookup = path.clone();
    let stored = with_db(&state, move |db| db.library_file_size(&lookup)).await?;
    if let Some(size) = stored.filter(|s| *s >= 0) {
        return Ok(Some(size as u64));
    }
    if !path.starts_with("file://") {
        return Ok(None);
    }
    run_blocking(move || Ok::<_, String>(get_file_size(path))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend reads these fields in camelCase (`AutoInstallOutcome` in
    /// `utils/toolAutoUpdate.ts`); `rename_all` alone left them snake_case.
    #[test]
    fn test_auto_install_outcome_fields_are_camel_case() {
        let installed = serde_json::to_value(AutoInstallOutcome::Installed {
            from: Some("1".into()),
            to: "2".into(),
            restart_errors: vec![],
        })
        .unwrap();
        assert_eq!(installed["status"], "installed");
        assert!(installed["restartErrors"].is_array());
        let skipped =
            serde_json::to_value(AutoInstallOutcome::Skipped { reason: "in-use".into(), retry_later: true }).unwrap();
        assert_eq!(skipped["retryLater"], true);
        let failed =
            serde_json::to_value(AutoInstallOutcome::Failed { error: "x".into(), switched_off: true }).unwrap();
        assert_eq!(failed["switchedOff"], true);
    }

    /// A real, playable 1-second silent WAV. Written by hand because the repo
    /// carries no audio fixtures, and lofty can only tag a file it can parse.
    fn write_silent_wav(path: &std::path::Path) {
        let sample_bytes: u32 = 44100 * 2; // 1s of 16-bit mono silence
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + sample_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // PCM header size
        wav.extend_from_slice(&1u16.to_le_bytes()); // format: PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // channels
        wav.extend_from_slice(&44100u32.to_le_bytes()); // sample rate
        wav.extend_from_slice(&88200u32.to_le_bytes()); // byte rate
        wav.extend_from_slice(&2u16.to_le_bytes()); // block align
        wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&sample_bytes.to_le_bytes());
        wav.extend(std::iter::repeat(0u8).take(sample_bytes as usize));
        std::fs::write(path, wav).unwrap();
    }

    #[test]
    fn read_file_tags_reads_what_the_file_says() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("03 - whatever the filename says.wav");
        write_silent_wav(&path);
        crate::tag_writer::write_tags(
            &path,
            &crate::tag_writer::TagUpdates {
                title: Some("Nude".into()),
                track_number: crate::models::FieldUpdate::Set(3),
                artist: crate::models::FieldUpdate::Set("Radiohead".into()),
                album_artist: crate::models::FieldUpdate::Set("Radiohead AA".into()),
                album: crate::models::FieldUpdate::Set("In Rainbows".into()),
                year: crate::models::FieldUpdate::Set(2007),
                genre: Some("Alternative".into()),
            },
        )
        .unwrap();

        let tags = read_one_file_tags(path.to_str().unwrap()).expect("tagged file reads");
        assert_eq!(tags.title.as_deref(), Some("Nude"));
        assert_eq!(tags.artist.as_deref(), Some("Radiohead"));
        assert_eq!(tags.album_artist.as_deref(), Some("Radiohead AA"));
        assert_eq!(tags.album.as_deref(), Some("In Rainbows"));
        assert_eq!(tags.track_number, Some(3));
        assert_eq!(tags.year, Some(2007));
        assert!(tags.duration_secs.unwrap() > 0.9);
    }

    // An untagged file must still report its duration: a queue entry with no
    // length shows no seek bar and never scrobbles, and the caller's own
    // filename parse can't supply one.
    #[test]
    fn read_file_tags_still_reports_duration_for_an_untagged_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("untagged.wav");
        write_silent_wav(&path);

        let tags = read_one_file_tags(path.to_str().unwrap()).expect("untagged file still reads");
        assert!(tags.title.is_none(), "no title invented from the filename");
        assert!(tags.artist.is_none());
        assert!(tags.duration_secs.unwrap() > 0.9);
    }

    // Callers zip the results against the paths they sent, so a file that can't
    // be read has to hold its place rather than shorten the list.
    #[test]
    fn read_file_tags_results_line_up_with_the_paths_sent() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good.wav");
        write_silent_wav(&good);
        let missing = dir.path().join("gone.wav");
        let junk = dir.path().join("notaudio.wav");
        std::fs::write(&junk, b"this is not a wav").unwrap();

        let out = tauri::async_runtime::block_on(read_file_tags(vec![
            missing.to_string_lossy().into_owned(),
            good.to_string_lossy().into_owned(),
            junk.to_string_lossy().into_owned(),
        ]))
        .unwrap();

        assert_eq!(out.len(), 3);
        assert!(out[0].is_none(), "missing file");
        assert!(out[1].is_some(), "real file keeps its slot");
        assert!(out[2].is_none(), "unparseable file");
    }

    fn lines_of(input: &[u8]) -> (Vec<String>, String) {
        let mut seen = Vec::new();
        let text = pump_lines(input, |l| seen.push(l));
        (seen, text)
    }

    // A progress-reporting CLI redraws one line with carriage returns, so a
    // `\n`-only reader emits nothing until the process exits — which is exactly
    // the output the caller wanted live.
    #[test]
    fn pump_lines_splits_on_carriage_returns_too() {
        let (seen, _) = lines_of(b"10%\r50%\r100%\ndone\n");
        assert_eq!(seen, vec!["10%", "50%", "100%", "done"]);
    }

    // The returned text is what a plugin parses as stdout, so it must match what
    // `Command::output()` would have produced byte for byte — blank lines and
    // all. Rebuilding it from the emitted lines would quietly drop them.
    #[test]
    fn pump_lines_returns_output_verbatim() {
        let raw = "first\n\nsecond\n";
        let (seen, text) = lines_of(raw.as_bytes());
        assert_eq!(text, raw, "blank line preserved in the returned text");
        assert_eq!(seen, vec!["first", "second"], "but not emitted as a line");
    }

    #[test]
    fn pump_lines_emits_a_trailing_unterminated_line() {
        let (seen, text) = lines_of(b"/tmp/dl.0.mp4");
        assert_eq!(seen, vec!["/tmp/dl.0.mp4"]);
        assert_eq!(text, "/tmp/dl.0.mp4");
    }

    // The cancel invoke can beat the exec invoke it is cancelling to the
    // backend — two separate IPC calls, no ordering guarantee. If `claim`
    // ignored a cancel that arrived first, that exec would spawn anyway and run
    // to completion with nobody left to receive it.
    #[test]
    fn cancel_before_claim_stops_the_exec_from_starting() {
        let reg = PluginExecRegistry::new();
        assert!(!reg.cancel("e1"), "no child to signal yet");
        assert!(!reg.claim("e1"), "claim refuses an already-cancelled id");
    }

    #[test]
    fn cancel_between_claim_and_spawn_is_not_lost() {
        let reg = PluginExecRegistry::new();
        assert!(reg.claim("e1"));
        assert!(!reg.cancel("e1"), "cancel lands before a pid is known");
        assert!(!reg.attach("e1", 424242), "caller is told to kill its child");
    }

    // The streaming path must drain stdout and stderr *concurrently*: a child
    // that fills the pipe nobody is reading blocks forever, and yt-dlp writes
    // to both (progress on stdout, postprocessor lines on stderr). Reading them
    // in sequence deadlocks as soon as the idle pipe passes ~64 KB, which a
    // long download comfortably does — so this drives a real child past that.
    #[cfg(unix)]
    #[test]
    fn both_pipes_drain_concurrently_past_the_buffer_size() {
        use std::process::Stdio;
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            // stderr first and larger than the pipe buffer: a sequential reader
            // starting on stdout would wedge here.
            // ~8000 × ~15 bytes ≈ 120 KB, comfortably past Linux's 64 KB pipe
            // buffer as well as macOS's smaller default.
            .arg("i=0; while [ $i -lt 8000 ]; do echo \"err line $i\" >&2; i=$((i+1)); done; \
                  printf 'progress\\rprogress2\\nfinal/path.mp4\\n'")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn /bin/sh");

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (out_lines, out_text, err_lines) = std::thread::scope(|scope| {
            let o = scope.spawn(|| {
                let mut lines = Vec::new();
                let text = stdout.map(|p| pump_lines(p, |l| lines.push(l))).unwrap_or_default();
                (lines, text)
            });
            let e = scope.spawn(|| {
                let mut n = 0usize;
                stderr.map(|p| pump_lines(p, |_| n += 1));
                n
            });
            let (ol, ot) = o.join().unwrap();
            (ol, ot, e.join().unwrap())
        });

        let status = child.wait().expect("child exits");
        assert!(status.success());
        assert_eq!(err_lines, 8000, "the whole stderr stream was read");
        assert_eq!(out_lines, vec!["progress", "progress2", "final/path.mp4"]);
        assert_eq!(out_text, "progress\rprogress2\nfinal/path.mp4\n", "stdout is verbatim");
    }

    #[test]
    fn a_clean_run_is_not_reported_as_cancelled() {
        let reg = PluginExecRegistry::new();
        assert!(reg.claim("e1"));
        assert!(reg.attach("e1", 424242));
        assert!(!reg.finish("e1"));
        // Finished ids are swept, so a late cancel can't kill a recycled pid.
        assert!(!reg.cancel("e1"));
    }
}
