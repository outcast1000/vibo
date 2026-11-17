//! Opt-in automatic updates for managed tools (owner decision, 2026-11-17,
//! revising "nothing installs itself" of 2026-10-20 for this one case).
//!
//! yt-dlp follows its nightly channel, which publishes almost every night, so
//! the update notice announced it daily. The user may now let Vibo install a
//! tool's updates itself — **per tool, off by default, only after the user
//! turned it on** — and only inside the guardrails below, every one of which is
//! checked here, in Rust, before an automatic install:
//!
//! 1. **Managed copies only** — a copy from a package manager is never touched.
//! 2. **Verified sources only** — a `Checksum::Unverified` download needs the
//!    user's confirmation every time, so it can't be switched on.
//! 3. **Same source only** — a copy whose source moved (`source_mismatch`)
//!    needs the user's Reinstall.
//! 4. **One-shot tools only** — a tool any plugin in **any profile** registered
//!    as a background program (slskd) would be stopped mid-use; it stays
//!    click-only. The bin dir is shared, so one profile's check must see the
//!    others' registrations ([`profile_dirs`]).
//! 5. **Never while it runs** — the download and checksum check happen with
//!    nothing held; only then is the gate taken, around the swap alone
//!    (`dependencies::install_managed_gated`). It is refused while a
//!    `plugin_exec` of the tool is running or a service runs it in any
//!    profile — the verified download is thrown away and the attempt becomes
//!    a skip ([`SWAP_IN_USE`]) — and an exec that starts during the swap waits
//!    for it ([`begin_use`]), so a running copy is never swapped from under
//!    (on Windows the swap of a running `.exe` fails outright) and a search
//!    waits seconds, not for a whole download.
//! 6. **At most one attempt a day per tool** ([`MIN_ATTEMPT_INTERVAL_SECS`]).
//! 7. **Failures switch it off** — two failed automatic installs in a row turn
//!    the tool's auto-update off, and its updates go back to the notice.
//!
//! The preferences live in the shared bin dir (`.auto-update.json`, beside
//! `.sources.json`): the bin dir is shared across profiles, so is the copy an
//! update replaces, so is the choice. Only the commands in `commands/media.rs`
//! write it — the webview store never holds it, so the frontend's copy can't
//! turn an update on. (Main-realm plugin code can invoke commands at all; that
//! is the same accepted boundary as the AI-control scopes.)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::dependencies::{self, Checksum, DependencyDef};

/// Failed automatic installs in a row before auto-update switches itself off.
pub const MAX_CONSECUTIVE_FAILURES: u32 = 2;

/// The shortest gap between two automatic attempts for one tool. Under a day
/// on purpose: the frontend checks daily, and a check landing a few minutes
/// early must not slip the update by a whole extra day.
pub const MIN_ATTEMPT_INTERVAL_SECS: u64 = 20 * 60 * 60;

/// How long an exec waits for an automatic install's swap to finish before it
/// runs anyway. The gate is held only from the verified download to the
/// version check after the swap (seconds — the probe of a fresh PyInstaller
/// build is the slow part), so this is a backstop against a stuck swap, never
/// the normal path.
const USE_WAIT_LIMIT: Duration = Duration::from_secs(180);

const PREFS_FILE: &str = ".auto-update.json";

/// One tool's stored choice and history.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolPrefs {
    pub enabled: bool,
    /// The user answered "No thanks" to the update notice's offer.
    pub offer_declined: bool,
    /// Unix seconds of the last automatic attempt (success or failure).
    pub last_attempt_at: Option<u64>,
    pub consecutive_failures: u32,
    /// The last automatic install that landed.
    pub last_install: Option<AutoInstall>,
    /// The last automatic install that failed, cleared by the next success.
    pub last_error: Option<String>,
    /// Auto-update was switched off by [`MAX_CONSECUTIVE_FAILURES`], not by
    /// the user — the Tools row says so.
    pub disabled_by_failures: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoInstall {
    pub from: Option<String>,
    pub to: String,
    pub at: u64,
}

pub type Prefs = HashMap<String, ToolPrefs>;

/// Why a tool can't be updated automatically (guardrails 1–4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Ineligible {
    /// No definition in force, or no managed source for this platform.
    NotManaged,
    /// The copy in use isn't Vibo's (missing, or a package manager's).
    NotVibosCopy,
    Unverified,
    SourceMismatch,
    Service,
}

impl Ineligible {
    pub fn message(self, name: &str) -> String {
        match self {
            Ineligible::NotManaged => format!("Vibo doesn't install {name}"),
            Ineligible::NotVibosCopy => format!("The {name} in use isn't Vibo's copy"),
            Ineligible::Unverified => {
                format!("{name}'s downloads can't be verified, so each one needs your confirmation")
            }
            Ineligible::SourceMismatch => format!("{name} now comes from a different source — reinstall it first"),
            Ineligible::Service => {
                format!("{name} runs as a background program, and an update would stop it")
            }
        }
    }
}

/// The facts eligibility is decided from, gathered by the caller.
pub struct ToolFacts {
    pub managed: bool,
    pub checksum: Option<Checksum>,
    pub vibos_copy: bool,
    pub source_mismatch: bool,
    /// Any plugin in this profile registered the tool as a background program.
    pub registered_as_service: bool,
}

/// Guardrails 1–4. Pure.
pub fn eligibility(facts: &ToolFacts) -> Result<(), Ineligible> {
    if !facts.managed {
        return Err(Ineligible::NotManaged);
    }
    if facts.checksum == Some(Checksum::Unverified) {
        return Err(Ineligible::Unverified);
    }
    if facts.registered_as_service {
        return Err(Ineligible::Service);
    }
    if !facts.vibos_copy {
        return Err(Ineligible::NotVibosCopy);
    }
    if facts.source_mismatch {
        return Err(Ineligible::SourceMismatch);
    }
    Ok(())
}

/// The facts for `name` as they stand now. Reads files only — never runs the
/// tool — so listing every tool's state is free at any time. `vibos_copy` is
/// "Vibo's copy is on disk": a managed copy always wins resolution (the bin dir
/// is prepended to PATH), and the automatic install re-reads the real origin
/// with the version probe before it acts.
pub fn facts_for(app_dir: &Path, name: &str) -> ToolFacts {
    let def: Option<&'static DependencyDef> = dependencies::get_def(name);
    let managed = def
        .and_then(|d| d.managed.as_ref())
        .filter(|m| m.platform_asset().is_some());
    ToolFacts {
        managed: managed.is_some(),
        checksum: managed.map(|m| m.checksum),
        vibos_copy: dependencies::managed_binary_path(name).is_some(),
        source_mismatch: dependencies::source_mismatch(name),
        registered_as_service: profile_dirs(app_dir)
            .iter()
            .any(|dir| !crate::plugin_programs::services_for_dependency(dir, name).is_empty()),
    }
}

/// Every profile's directory. The bin dir — and so the copy an update
/// replaces — is shared by all of them, so a background program registered in
/// any profile counts, not only in the one this window runs. Falls back to
/// `app_dir` alone when it isn't under a `profiles/` folder (tests).
pub fn profile_dirs(app_dir: &Path) -> Vec<PathBuf> {
    let Some(parent) = app_dir.parent().filter(|p| p.file_name().is_some_and(|n| n == "profiles")) else {
        return vec![app_dir.to_path_buf()];
    };
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(parent)
        .map(|it| it.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    if !dirs.iter().any(|d| d == app_dir) {
        dirs.push(app_dir.to_path_buf());
    }
    dirs
}

/// A background program in any profile is running the tool right now.
pub fn running_as_service_anywhere(app_dir: &Path, name: &str) -> bool {
    profile_dirs(app_dir)
        .iter()
        .any(|dir| !crate::plugin_programs::running_for_dependency(dir, name).is_empty())
}

/// The error an automatic install's pre-swap hook returns when the tool is in
/// use: the download is thrown away and the attempt is a skip, not a failure.
pub const SWAP_IN_USE: &str = "The tool was in use when its update was ready";

// --- Preferences file ---

fn prefs_path() -> Option<PathBuf> {
    dependencies::managed_bin_dir().map(|d| d.join(PREFS_FILE))
}

/// Serializes read-modify-write of the file within this process.
static PREFS_LOCK: Mutex<()> = Mutex::new(());

pub fn read_prefs_at(file: &Path) -> Prefs {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_prefs_at(file: &Path, prefs: &Prefs) -> Result<(), String> {
    let json = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Couldn't save the auto-update setting: {e}"))?;
    std::fs::rename(&tmp, file).map_err(|e| format!("Couldn't save the auto-update setting: {e}"))
}

pub fn read_prefs() -> Prefs {
    let _guard = PREFS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    prefs_path().map(|p| read_prefs_at(&p)).unwrap_or_default()
}

/// Apply `change` to `name`'s entry and save. Returns the entry after it.
pub fn update_prefs(name: &str, change: impl FnOnce(&mut ToolPrefs)) -> Result<ToolPrefs, String> {
    let _guard = PREFS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = prefs_path().ok_or("The tools folder isn't available")?;
    let mut prefs = read_prefs_at(&file);
    let entry = prefs.entry(name.to_string()).or_default();
    change(entry);
    let out = entry.clone();
    write_prefs_at(&file, &prefs)?;
    Ok(out)
}

/// The user's switch. Turning it on clears the failure history, so a tool
/// switched off by failures gets a fresh start.
pub fn apply_user_choice(entry: &mut ToolPrefs, enabled: bool) {
    entry.enabled = enabled;
    entry.disabled_by_failures = false;
    if enabled {
        entry.consecutive_failures = 0;
        entry.last_error = None;
    }
}

/// Guardrail 6. Pure.
pub fn attempted_recently(entry: &ToolPrefs, now: u64) -> bool {
    entry
        .last_attempt_at
        .is_some_and(|at| now.saturating_sub(at) < MIN_ATTEMPT_INTERVAL_SECS)
}

/// Record a landed automatic install. Pure.
pub fn record_success(entry: &mut ToolPrefs, from: Option<String>, to: String, now: u64) {
    entry.last_attempt_at = Some(now);
    entry.consecutive_failures = 0;
    entry.last_error = None;
    entry.last_install = Some(AutoInstall { from, to, at: now });
}

/// Record a failed automatic install; guardrail 7. Returns true when this
/// failure switched auto-update off. Pure.
pub fn record_failure(entry: &mut ToolPrefs, error: String, now: u64) -> bool {
    entry.last_attempt_at = Some(now);
    entry.consecutive_failures += 1;
    entry.last_error = Some(error);
    if entry.consecutive_failures >= MAX_CONSECUTIVE_FAILURES && entry.enabled {
        entry.enabled = false;
        entry.disabled_by_failures = true;
        return true;
    }
    false
}

// --- In-use gate (guardrail 5) ---

#[derive(Default)]
struct UseState {
    running: HashMap<String, usize>,
    installing: HashSet<String>,
}

static USE_STATE: Mutex<Option<UseState>> = Mutex::new(None);
static USE_CHANGED: Condvar = Condvar::new();

fn with_state<T>(f: impl FnOnce(&mut UseState) -> T) -> T {
    let mut guard = USE_STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(UseState::default))
}

/// Held for the length of one run of a tool (a `plugin_exec`).
pub struct UseGuard(String);

impl Drop for UseGuard {
    fn drop(&mut self) {
        with_state(|s| {
            if let Some(n) = s.running.get_mut(&self.0) {
                *n -= 1;
                if *n == 0 {
                    s.running.remove(&self.0);
                }
            }
        });
        USE_CHANGED.notify_all();
    }
}

/// Mark a run of `name` as started. Waits (up to [`USE_WAIT_LIMIT`]) while an
/// automatic install of it is swapping the files, then runs either way.
pub fn begin_use(name: &str) -> UseGuard {
    let deadline = std::time::Instant::now() + USE_WAIT_LIMIT;
    let mut guard = USE_STATE.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let state = guard.get_or_insert_with(UseState::default);
        let now = std::time::Instant::now();
        if !state.installing.contains(name) || now >= deadline {
            *state.running.entry(name.to_string()).or_insert(0) += 1;
            return UseGuard(name.to_string());
        }
        guard = USE_CHANGED
            .wait_timeout(guard, deadline - now)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

/// Held by an automatic install from the in-use check until it is done.
pub struct InstallGuard(String);

impl Drop for InstallGuard {
    fn drop(&mut self) {
        with_state(|s| s.installing.remove(&self.0));
        USE_CHANGED.notify_all();
    }
}

/// Start an automatic install of `name`: refused while a run of it is going.
/// In the same lock as [`begin_use`], so no run can start between the check
/// and the install.
pub fn begin_auto_install(name: &str) -> Option<InstallGuard> {
    with_state(|s| {
        if s.running.get(name).copied().unwrap_or(0) > 0 || s.installing.contains(name) {
            return None;
        }
        s.installing.insert(name.to_string());
        Some(InstallGuard(name.to_string()))
    })
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eligible_facts() -> ToolFacts {
        ToolFacts {
            managed: true,
            checksum: Some(Checksum::File("SHA2-256SUMS")),
            vibos_copy: true,
            source_mismatch: false,
            registered_as_service: false,
        }
    }

    #[test]
    fn test_a_verified_one_shot_managed_copy_is_eligible() {
        assert_eq!(eligibility(&eligible_facts()), Ok(()));
        let digest = ToolFacts { checksum: Some(Checksum::GitHubDigest), ..eligible_facts() };
        assert_eq!(eligibility(&digest), Ok(()));
    }

    #[test]
    fn test_each_guardrail_refuses() {
        assert_eq!(eligibility(&ToolFacts { managed: false, ..eligible_facts() }), Err(Ineligible::NotManaged));
        assert_eq!(
            eligibility(&ToolFacts { checksum: Some(Checksum::Unverified), ..eligible_facts() }),
            Err(Ineligible::Unverified)
        );
        assert_eq!(
            eligibility(&ToolFacts { registered_as_service: true, ..eligible_facts() }),
            Err(Ineligible::Service)
        );
        assert_eq!(eligibility(&ToolFacts { vibos_copy: false, ..eligible_facts() }), Err(Ineligible::NotVibosCopy));
        assert_eq!(
            eligibility(&ToolFacts { source_mismatch: true, ..eligible_facts() }),
            Err(Ineligible::SourceMismatch)
        );
    }

    #[test]
    fn test_one_attempt_a_day() {
        let now = 1_000_000;
        let mut entry = ToolPrefs::default();
        assert!(!attempted_recently(&entry, now));
        entry.last_attempt_at = Some(now - 60);
        assert!(attempted_recently(&entry, now));
        entry.last_attempt_at = Some(now - MIN_ATTEMPT_INTERVAL_SECS);
        assert!(!attempted_recently(&entry, now));
    }

    #[test]
    fn test_two_failures_in_a_row_switch_it_off() {
        let mut entry = ToolPrefs { enabled: true, ..Default::default() };
        assert!(!record_failure(&mut entry, "boom".into(), 10));
        assert!(entry.enabled);
        assert!(record_failure(&mut entry, "boom again".into(), 20));
        assert!(!entry.enabled);
        assert!(entry.disabled_by_failures);
        assert_eq!(entry.last_error.as_deref(), Some("boom again"));
    }

    #[test]
    fn test_a_success_resets_the_failure_count() {
        let mut entry = ToolPrefs { enabled: true, ..Default::default() };
        record_failure(&mut entry, "boom".into(), 10);
        record_success(&mut entry, Some("1".into()), "2".into(), 20);
        assert_eq!(entry.consecutive_failures, 0);
        assert!(entry.last_error.is_none());
        assert!(!record_failure(&mut entry, "boom".into(), 30));
        assert!(entry.enabled);
    }

    #[test]
    fn test_turning_it_back_on_starts_fresh() {
        let mut entry = ToolPrefs { enabled: true, ..Default::default() };
        record_failure(&mut entry, "a".into(), 1);
        record_failure(&mut entry, "b".into(), 2);
        apply_user_choice(&mut entry, true);
        assert!(entry.enabled && !entry.disabled_by_failures);
        assert_eq!(entry.consecutive_failures, 0);
        assert!(entry.last_error.is_none());
    }

    #[test]
    fn test_prefs_round_trip_and_missing_file_reads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(PREFS_FILE);
        assert!(read_prefs_at(&file).is_empty());
        let mut prefs = Prefs::new();
        prefs.insert("yt-dlp".into(), ToolPrefs { enabled: true, ..Default::default() });
        write_prefs_at(&file, &prefs).unwrap();
        assert_eq!(read_prefs_at(&file), prefs);
        // A damaged file reads as "nothing on" — never as a switch left on.
        std::fs::write(&file, "{not json").unwrap();
        assert!(read_prefs_at(&file).is_empty());
    }

    #[test]
    fn test_every_profile_is_checked_not_only_this_one() {
        let root = tempfile::tempdir().unwrap();
        let profiles = root.path().join("profiles");
        for p in ["default", "work", "perf"] {
            std::fs::create_dir_all(profiles.join(p)).unwrap();
        }
        std::fs::write(profiles.join("stray-file"), "").unwrap();
        let mut dirs = profile_dirs(&profiles.join("work"));
        dirs.sort();
        let names: Vec<_> = dirs.iter().map(|d| d.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(names, ["default", "perf", "work"]);
        // Not under a `profiles/` folder: just itself.
        let lone = root.path().join("elsewhere");
        assert_eq!(profile_dirs(&lone), vec![lone.clone()]);
    }

    #[test]
    fn test_no_install_while_a_run_is_going_and_runs_wait_for_an_install() {
        // A name no other test uses: the gate is process-global.
        let name = "gate-test-tool";
        let run = begin_use(name);
        assert!(begin_auto_install(name).is_none(), "refused while running");
        drop(run);
        let install = begin_auto_install(name).expect("free once the run ended");
        assert!(begin_auto_install(name).is_none(), "one install at a time");

        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let _g = begin_use(name);
            tx.send(()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "the run waits for the install");
        drop(install);
        rx.recv_timeout(Duration::from_secs(5)).expect("the run starts once the install is done");
        waiter.join().unwrap();
    }
}
