use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    host,
    protocol::{HostCommand, HostResult, TaskId},
    resources::{
        CleanupPlan, CleanupReceipt, NativeWorktreeIdentity, ResourceBackend, ResourceRecord,
        ResourceReport, ResourceState, WorktreeAllocation,
    },
};

const OWNER_FILE: &str = "agent-owner";

fn private_file(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0,
        "Resource state must be a private owned regular file"
    );
    ensure!(
        metadata.len() <= maximum,
        "Resource state exceeded its size limit"
    );
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    ensure!(
        u64::try_from(bytes.len())? <= maximum,
        "Resource state exceeded its size limit"
    );
    Ok(bytes)
}

#[derive(Clone, Debug)]
pub struct GitBackend {
    cleanup: Vec<String>,
}

impl Default for GitBackend {
    fn default() -> Self {
        Self {
            cleanup: vec!["git".into(), "cleanup".into()],
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    version: u32,
    host_id: String,
    task_id: TaskId,
    allocation_id: Uuid,
    phase: OwnerPhase,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum OwnerPhase {
    Initializing,
    Ready,
}

/// The installed guarded helper owns this format and performs the deletion.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuardedPlan {
    pub version: u32,
    pub repository: String,
    pub worktree: String,
    pub primary_worktree: String,
    pub branch: Option<String>,
    pub head: String,
    pub remote: String,
    pub remote_identity: String,
    pub base: String,
    pub base_head: String,
    pub local_base_head: String,
    pub evidence: String,
    pub evidence_commit: String,
    pub force: bool,
    pub remove_worktree: bool,
    pub submodule_storage: String,
    pub submodule_fingerprint: String,
    pub build_directories: Vec<String>,
    pub build_symlinks: Vec<String>,
    pub build_bytes: u64,
}

struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

async fn run(program: &str, args: Vec<String>, cwd: &Path) -> Result<Output> {
    match host::execute(HostCommand::Exec {
        program: program.into(),
        args,
        cwd: path_text(cwd)?,
        timeout_seconds: 30,
    })
    .await
    {
        HostResult::Process {
            exit_code,
            stdout,
            stderr,
            truncated,
        } => {
            ensure!(
                !truncated,
                "Command output was incomplete; resource coverage is unknown"
            );
            Ok(Output {
                code: exit_code,
                stdout,
                stderr,
            })
        }
        HostResult::Failed { message } => anyhow::bail!("{message}"),
        _ => anyhow::bail!("Unsupported resource command result"),
    }
}

fn path_text(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .context("Resource path is not valid UTF-8")
}

async fn git(cwd: &Path, args: &[&str]) -> Result<Output> {
    run("git", args.iter().map(|arg| (*arg).into()).collect(), cwd).await
}

async fn value(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = git(cwd, args).await?;
    ensure!(
        output.code == 0,
        "Git resource inspection failed: {}",
        brief(&output.stderr)
    );
    Ok(output.stdout.trim_end_matches(['\n', '\r']).into())
}

fn brief(value: &str) -> String {
    value
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("command refused")
        .chars()
        .take(240)
        .collect()
}

fn held(mut record: ResourceRecord, reason: impl Into<String>) -> ResourceReport {
    let reason = reason.into();
    if let ResourceState::Partial {
        reason: previous, ..
    } = &mut record.state
    {
        *previous = format!("{reason}; previous cleanup remains partial and must not be retried");
        return ResourceReport::Observed {
            record: Box::new(record),
        };
    }
    if matches!(record.state, ResourceState::Removed { .. }) {
        return ResourceReport::Observed {
            record: Box::new(record),
        };
    }
    let identity = record.state.identity().cloned();
    record.state = ResourceState::Held { identity, reason };
    ResourceReport::Observed {
        record: Box::new(record),
    }
}

async fn primary(cwd: &Path) -> Result<PathBuf> {
    let output = value(cwd, &["worktree", "list", "--porcelain", "-z"]).await?;
    let first = output
        .split("\0\0")
        .next()
        .context("Git has no worktree registry")?;
    ensure!(
        !first.split('\0').any(|field| field == "bare"),
        "Bare primary repositories are not collected"
    );
    let path = first
        .split('\0')
        .find_map(|field| field.strip_prefix("worktree "))
        .context("Git has no primary worktree")?;
    fs::canonicalize(path).context("Could not resolve the primary worktree")
}

pub async fn inspect_native(path: &Path) -> Result<NativeWorktreeIdentity> {
    let top = fs::canonicalize(value(path, &["rev-parse", "--show-toplevel"]).await?)?;
    let root = primary(&top).await?;
    let common = fs::canonicalize(
        value(
            &top,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?,
    )?;
    let directory = fs::canonicalize(value(&top, &["rev-parse", "--absolute-git-dir"]).await?)?;
    let branch = value(&top, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    let head = value(&top, &["rev-parse", "--verify", "HEAD^{commit}"]).await?;
    Ok(NativeWorktreeIdentity {
        primary: path_text(&root)?,
        top: path_text(&top)?,
        common_dir: path_text(&common)?,
        git_dir: path_text(&directory)?,
        branch,
        head,
    })
}

async fn planned_path(record: &ResourceRecord) -> Result<(PathBuf, PathBuf)> {
    ensure!(!record.id.is_nil(), "Allocation ID cannot be nil");
    ensure!(
        !record.host_id.is_empty(),
        "Resource host identity is missing"
    );
    let root = primary(Path::new(&record.repository)).await?;
    let check = git(
        &root,
        &["check-ref-format", &format!("refs/heads/{}", record.branch)],
    )
    .await?;
    ensure!(
        check.code == 0 && !record.branch.starts_with('-'),
        "Invalid worktree branch name"
    );
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .context("Primary repository has no name")?;
    let parent = root.parent().context("Primary repository has no parent")?;
    let path = parent.join(format!("{name}-{}", record.branch.replace('/', "-")));
    ensure!(
        path != root,
        "A primary checkout cannot be allocated as a worktree"
    );
    Ok((root, path))
}

fn same_location(left: &NativeWorktreeIdentity, right: &NativeWorktreeIdentity) -> bool {
    left.primary == right.primary
        && left.top == right.top
        && left.common_dir == right.common_dir
        && left.git_dir == right.git_dir
        && left.branch == right.branch
}

async fn owned(record: &ResourceRecord) -> Result<NativeWorktreeIdentity> {
    let (primary, path) = planned_path(record).await?;
    ensure!(
        !fs::symlink_metadata(&path)?.file_type().is_symlink(),
        "Worktree path is a symlink; preserving it"
    );
    let identity = inspect_native(&path).await?;
    ensure!(
        identity.primary == path_text(&primary)?
            && identity.top == path_text(&fs::canonicalize(&path)?)?
            && identity.top != identity.primary
            && identity.git_dir != identity.common_dir
            && identity.branch == record.branch,
        "Worktree topology does not match its allocation"
    );
    if let Some(expected) = record.state.identity() {
        ensure!(
            same_location(expected, &identity),
            "Recorded worktree identity changed; preserving it"
        );
    }
    let marker = Path::new(&identity.git_dir).join(OWNER_FILE);
    let metadata = fs::symlink_metadata(&marker)
        .context("Ownership marker is missing; preserving worktree")?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Ownership marker is not a regular file"
    );
    let owner: Owner = serde_json::from_slice(&private_file(&marker, 8192)?)
        .context("Ownership marker is invalid; preserving worktree")?;
    ensure!(
        owner.version == 1
            && owner.host_id == record.host_id
            && owner.task_id == record.task_id
            && owner.allocation_id == record.id,
        "Worktree belongs to another allocation; preserving it"
    );
    ensure!(
        owner.phase == OwnerPhase::Ready,
        "Worktree initialization is incomplete; preserving it"
    );
    Ok(identity)
}

async fn unused(record: &ResourceRecord, identity: &NativeWorktreeIdentity) -> Result<()> {
    ensure!(
        record.consumers.is_empty(),
        "Resource still has registered consumers"
    );
    let cwd = std::env::current_dir()?;
    ensure!(
        !cwd.starts_with(&identity.top),
        "The collector is still using this worktree as its working directory"
    );
    // Scope the native query: an entire-machine listing can exceed bounded
    // process capture, while +D includes cwd and open files beneath this tree.
    // Package builds of lsof can stall enumerating macOS processes.
    let lsof = if cfg!(target_os = "macos") {
        "/usr/sbin/lsof"
    } else {
        "lsof"
    };
    let output = run(
        lsof,
        vec![
            "-nP".into(),
            "-Fpn".into(),
            "+D".into(),
            identity.top.clone(),
            "+D".into(),
            identity.git_dir.clone(),
        ],
        Path::new(&identity.primary),
    )
    .await?;
    unused_processes(&output, identity)
}

fn unused_processes(output: &Output, identity: &NativeWorktreeIdentity) -> Result<()> {
    // A confirmed consumer holds the tree even when another path was unreadable.
    let mut process = "unknown";
    for line in output.stdout.lines() {
        if let Some(pid) = line.strip_prefix('p') {
            process = pid;
        }
        if let Some(path) = line.strip_prefix('n')
            && (Path::new(path.trim_end_matches(" (deleted)")).starts_with(&identity.top)
                || Path::new(path.trim_end_matches(" (deleted)")).starts_with(&identity.git_dir))
        {
            anyhow::bail!("Worktree is still used by process {process}");
        }
    }
    ensure!(
        (output.code == 0 || output.code == 1) && output.stderr.is_empty(),
        "Could not inspect active resource processes; preserving worktree"
    );
    Ok(())
}

impl GitBackend {
    pub fn new(cleanup: Vec<String>) -> Result<Self> {
        ensure!(
            !cleanup.is_empty()
                && cleanup
                    .iter()
                    .all(|arg| !arg.is_empty() && !arg.contains('\0')),
            "Invalid guarded cleanup command"
        );
        Ok(Self { cleanup })
    }

    async fn helper(&self, cwd: &Path, arguments: &[&str]) -> Result<Output> {
        let (program, prefix) = self
            .cleanup
            .split_first()
            .context("Guarded cleanup helper is missing")?;
        let mut args = prefix.to_vec();
        args.extend(arguments.iter().map(|arg| (*arg).into()));
        run(program, args, cwd)
            .await
            .context("Guarded cleanup helper is unavailable")
    }

    async fn allocate_inner(&self, record: &mut ResourceRecord) -> Result<()> {
        let (root, path) = planned_path(record).await?;
        ensure!(
            !path.try_exists()? && fs::symlink_metadata(&path).is_err(),
            "Allocation path already exists; inspect the original allocation instead of creating or adopting it"
        );
        ensure!(
            git(
                &root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{}", record.branch)
                ]
            )
            .await?
            .code
                == 1,
            "Allocation branch already exists; preserving it"
        );
        value(
            &root,
            &[
                "fetch",
                "--no-tags",
                "--no-prune",
                "--no-recurse-submodules",
                "--refmap=",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
        )
        .await?;
        value(&root, &["rev-parse", "--verify", "origin/main^{commit}"]).await?;
        value(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                &record.branch,
                &path_text(&path)?,
                "origin/main",
            ],
        )
        .await?;
        let identity = inspect_native(&path).await?;
        record.state = ResourceState::Ready {
            identity: identity.clone(),
        };
        let marker = Path::new(&identity.git_dir).join(OWNER_FILE);
        let mut owner = Owner {
            version: 1,
            host_id: record.host_id.clone(),
            task_id: record.task_id.clone(),
            allocation_id: record.id,
            phase: OwnerPhase::Initializing,
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&marker)?;
        file.write_all(&serde_json::to_vec(&owner)?)?;
        file.sync_all()?;
        fs::File::open(&identity.git_dir)?.sync_all()?;
        value(&path, &["submodule", "update", "--init", "--recursive"]).await?;
        owner.phase = OwnerPhase::Ready;
        let ready =
            Path::new(&identity.git_dir).join(format!(".agent-owner-{}.tmp", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&ready)?;
        file.write_all(&serde_json::to_vec(&owner)?)?;
        file.sync_all()?;
        fs::rename(ready, marker)?;
        fs::File::open(&identity.git_dir)?.sync_all()?;
        owned(record).await?;
        Ok(())
    }

    async fn plan_inner(
        &self,
        record: &mut ResourceRecord,
        directory: &str,
    ) -> Result<CleanupPlan> {
        ensure!(
            !matches!(
                record.state,
                ResourceState::Removed { .. } | ResourceState::Partial { .. }
            ),
            "A removed or partially removed resource requires reconciliation, not another cleanup attempt"
        );
        let identity = owned(record).await?;
        unused(record, &identity).await?;
        let result = self.helper(Path::new(&identity.top), &["--plan"]).await?;
        ensure!(
            result.code == 0,
            "Guarded cleanup plan refused: {}",
            brief(&result.stderr)
        );
        let reviewed: GuardedPlan = serde_json::from_str(&result.stdout)
            .context("Guarded cleanup helper returned an unsupported plan")?;
        validate_plan(&reviewed, &identity)?;
        let directory = PathBuf::from(directory);
        ensure!(
            directory.is_absolute(),
            "Cleanup plans require an absolute private state directory"
        );
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)?;
        let directory = fs::canonicalize(directory)?;
        ensure!(
            fs::metadata(&directory)?.permissions().mode() & 0o077 == 0,
            "Cleanup plan directory must be private"
        );
        ensure!(
            !directory.starts_with(&identity.top) && !directory.starts_with(&identity.git_dir),
            "Cleanup plans must be outside the checkout and metadata being removed"
        );
        let id = Uuid::new_v4();
        let path = directory.join(format!("{id}.json"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        file.write_all(result.stdout.as_bytes())?;
        file.sync_all()?;
        fs::File::open(&directory)?.sync_all()?;
        let plan = CleanupPlan {
            id,
            resource_id: record.id,
            identity: identity.clone(),
            path: path_text(&path)?,
            fingerprint: format!("{:x}", Sha256::digest(result.stdout.as_bytes())),
        };
        record.state = ResourceState::Retiring {
            identity,
            plan_id: id,
        };
        Ok(plan)
    }

    async fn collect_inner(
        &self,
        record: &mut ResourceRecord,
        plan: &CleanupPlan,
    ) -> Result<Option<CleanupReceipt>> {
        ensure!(
            record.id == plan.resource_id && !record.id.is_nil(),
            "Cleanup plan belongs to another resource"
        );
        ensure!(
            matches!(&record.state, ResourceState::Retiring { plan_id, .. } if *plan_id == plan.id),
            "Resource must be marked retiring for this exact reviewed plan"
        );
        ensure!(
            record.state.identity() == Some(&plan.identity),
            "Reviewed identity does not match the retirement record"
        );
        let identity = match owned(record).await {
            Ok(identity) => identity,
            Err(error) => {
                // A prior execution may have finished before its reply reached
                // Pi. Reconcile that persisted intent without replaying removal.
                let observed = absence(&plan.identity).await;
                if matches!(observed, Ok((false, false, false))) {
                    return Err(error);
                }
                let absent = observed.unwrap_or((false, false, false));
                record.state = ResourceState::Partial {
                    identity: plan.identity.clone(),
                    path_absent: absent.0,
                    registry_absent: absent.1,
                    branch_absent: absent.2,
                    reason: format!(
                        "Retired resource identity is unavailable: {error}; prior cleanup outcome requires reconciliation, not another removal"
                    ),
                };
                return Ok(None);
            }
        };
        ensure!(
            identity == plan.identity,
            "Worktree changed after review; preserving it"
        );
        unused(record, &identity).await?;
        let metadata = fs::symlink_metadata(&plan.path)?;
        ensure!(
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.permissions().mode() & 0o077 == 0,
            "Reviewed cleanup plan is not a private regular file"
        );
        let bytes = private_file(Path::new(&plan.path), 256 * 1024)?;
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == plan.fingerprint,
            "Reviewed cleanup plan changed; preserving worktree"
        );
        let reviewed: GuardedPlan = serde_json::from_slice(&bytes)?;
        validate_plan(&reviewed, &identity)?;
        // Execution can remove a checkout before failing or losing its receipt.
        // Always reconcile afterwards; an uncertain effect is never retried.
        let execution = self
            .helper(
                Path::new(&identity.primary),
                &[
                    "--execute",
                    &plan.path,
                    "--json",
                    "--no-update-base",
                    "--no-gc",
                ],
            )
            .await;
        let receipt = execution
            .as_ref()
            .ok()
            .and_then(|output| serde_json::from_str::<CleanupReceipt>(&output.stdout).ok());
        let verification = absence(&identity).await;
        let absent = verification
            .as_ref()
            .copied()
            .unwrap_or((false, false, false));
        let verified_receipt = receipt.as_ref().is_some_and(|receipt| {
            receipt.status == "completed"
                && receipt.worktree_removed
                && receipt.primary_worktree.as_deref() == Some(&identity.primary)
                && receipt.branch_deleted.as_deref() == Some(&identity.branch)
        });
        let archive_verified = reviewed.submodule_storage.is_empty()
            || receipt
                .as_ref()
                .and_then(|receipt| receipt.retained_submodules.as_deref())
                .is_some_and(|path| Path::new(path).join("modules").is_dir());
        if execution.as_ref().is_ok_and(|output| output.code == 0)
            && verified_receipt
            && archive_verified
            && absent == (true, true, true)
        {
            record.state = ResourceState::Removed { identity };
        } else if absent.0 || absent.1 || absent.2 || verification.is_err() {
            record.state = ResourceState::Partial { identity, path_absent: absent.0, registry_absent: absent.1,
                branch_absent: absent.2, reason: "Cleanup was partial or its receipt/history retention could not be verified; do not retry the removal".into() };
        } else {
            record.state = ResourceState::Held {
                identity: Some(identity),
                reason: receipt
                    .as_ref()
                    .map(|value| value.summary.clone())
                    .unwrap_or_else(|| match execution {
                        Ok(output) => format!("Guarded cleanup refused: {}", brief(&output.stderr)),
                        Err(error) => format!("Guarded cleanup could not be completed: {error}"),
                    }),
            };
        }
        Ok(receipt)
    }
}

fn validate_plan(plan: &GuardedPlan, identity: &NativeWorktreeIdentity) -> Result<()> {
    ensure!(
        plan.version == 3 && !plan.force && plan.remove_worktree,
        "Only a guarded non-force linked-worktree removal plan is eligible"
    );
    ensure!(
        plan.repository == identity.common_dir
            && plan.worktree == identity.top
            && plan.primary_worktree == identity.primary
            && plan.branch.as_deref() == Some(&identity.branch)
            && plan.head == identity.head
            && plan.worktree != plan.primary_worktree,
        "Guarded cleanup plan does not match the exact owned worktree"
    );
    ensure!(
        matches!(
            plan.evidence.as_str(),
            "ancestor" | "empty-change" | "squash-patch-and-content" | "merged-pull-request"
        ) && !plan.evidence_commit.is_empty(),
        "Worktree merge evidence is unknown or ineligible"
    );
    Ok(())
}

async fn absence(identity: &NativeWorktreeIdentity) -> Result<(bool, bool, bool)> {
    let path_absent = match fs::symlink_metadata(&identity.top) {
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    let listing = value(
        Path::new(&identity.primary),
        &["worktree", "list", "--porcelain", "-z"],
    )
    .await?;
    let registered = listing
        .split('\0')
        .any(|field| field.strip_prefix("worktree ") == Some(&identity.top));
    let branch = git(
        Path::new(&identity.primary),
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", identity.branch),
        ],
    )
    .await?;
    ensure!(
        branch.code == 0 || branch.code == 1,
        "Could not verify branch absence"
    );
    Ok((path_absent, !registered, branch.code == 1))
}

#[async_trait::async_trait]
impl ResourceBackend for GitBackend {
    async fn allocate(&self, request: WorktreeAllocation) -> ResourceReport {
        let mut record = ResourceRecord::allocating(request);
        match self.allocate_inner(&mut record).await {
            Ok(()) => ResourceReport::Observed {
                record: Box::new(record),
            },
            Err(error) => held(record, error.to_string()),
        }
    }

    async fn inspect(&self, mut record: ResourceRecord) -> ResourceReport {
        match owned(&record).await {
            Ok(identity) => {
                if !matches!(
                    record.state,
                    ResourceState::Retiring { .. }
                        | ResourceState::Partial { .. }
                        | ResourceState::Removed { .. }
                ) {
                    record.state = ResourceState::Ready { identity };
                }
                ResourceReport::Observed {
                    record: Box::new(record),
                }
            }
            Err(error) => held(record, error.to_string()),
        }
    }

    async fn plan_cleanup(&self, mut record: ResourceRecord, directory: &str) -> ResourceReport {
        match self.plan_inner(&mut record, directory).await {
            Ok(plan) => ResourceReport::Planned {
                record: Box::new(record),
                plan: Box::new(plan),
            },
            Err(error) => held(record, error.to_string()),
        }
    }

    async fn collect(&self, mut record: ResourceRecord, plan: CleanupPlan) -> ResourceReport {
        match self.collect_inner(&mut record, &plan).await {
            Ok(receipt) => ResourceReport::Collected {
                record: Box::new(record),
                receipt,
            },
            Err(error) => held(record, error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command};

    struct Fixture {
        _directory: tempfile::TempDir,
        root: PathBuf,
        repository: PathBuf,
    }

    fn command(directory: &Path, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(directory)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(directory.path()).unwrap();
            command(
                &root,
                &["init", "--bare", "--initial-branch=main", "origin.git"],
            );
            command(&root, &["init", "--initial-branch=main", "checkout"]);
            let repository = root.join("checkout");
            for (key, value) in [
                ("user.name", "Fixture"),
                ("user.email", "test@example.invalid"),
                ("commit.gpgsign", "false"),
                ("tag.gpgsign", "false"),
                ("protocol.file.allow", "always"),
                ("core.hooksPath", "/nonexistent-agent-fixture-hooks"),
            ] {
                command(&repository, &["config", key, value]);
            }
            fs::write(repository.join("README.md"), "fixture\n").unwrap();
            command(&repository, &["add", "README.md"]);
            command(&repository, &["commit", "-m", "Initial fixture"]);
            command(
                &repository,
                &[
                    "remote",
                    "add",
                    "origin",
                    root.join("origin.git").to_str().unwrap(),
                ],
            );
            command(&repository, &["push", "--set-upstream", "origin", "main"]);
            command(&repository, &["remote", "set-head", "origin", "main"]);
            Self {
                _directory: directory,
                root,
                repository,
            }
        }

        fn request(&self) -> WorktreeAllocation {
            let id = Uuid::new_v4();
            WorktreeAllocation {
                host_id: "fixture-host".into(),
                task_id: TaskId::new(),
                allocation_id: id,
                repository: path_text(&self.repository).unwrap(),
                branch: format!("task/{id}"),
            }
        }

        async fn allocate(&self) -> ResourceRecord {
            let result = record(GitBackend::default().allocate(self.request()).await);
            assert!(
                matches!(result.state, ResourceState::Ready { .. }),
                "{result:?}"
            );
            result
        }

        fn commit_work(&self, resource: &ResourceRecord) {
            let top = Path::new(&resource.state.identity().unwrap().top);
            fs::write(top.join("task.txt"), "completed task\n").unwrap();
            command(top, &["add", "task.txt"]);
            command(top, &["commit", "-m", "Complete task"]);
        }

        fn merge(&self, resource: &ResourceRecord) {
            command(
                &self.repository,
                &["merge", "--no-ff", "--no-edit", &resource.branch],
            );
            command(&self.repository, &["push", "origin", "main"]);
        }

        fn plans(&self) -> String {
            path_text(&self.root.join("plans")).unwrap()
        }
    }

    fn record(report: ResourceReport) -> ResourceRecord {
        match report {
            ResourceReport::Observed { record }
            | ResourceReport::Planned { record, .. }
            | ResourceReport::Collected { record, .. } => *record,
        }
    }

    fn held_reason(report: ResourceReport) -> String {
        let record = record(report);
        match record.state {
            ResourceState::Held { reason, .. } => reason,
            state => panic!("Expected held resource, got {state:?}"),
        }
    }

    fn plan(report: ResourceReport) -> (ResourceRecord, CleanupPlan) {
        match report {
            ResourceReport::Planned { record, plan } => (*record, *plan),
            other => panic!("Expected cleanup plan, got {other:?}"),
        }
    }

    fn installed_helper() -> GitBackend {
        let helper = dirs::home_dir()
            .unwrap()
            .join(".config/git/scripts/git-cleanup");
        assert!(
            helper.is_file(),
            "This test requires the installed guarded git cleanup helper"
        );
        GitBackend::new(vec!["python3".into(), path_text(&helper).unwrap()]).unwrap()
    }

    #[tokio::test]
    async fn allocates_a_native_sibling_worktree_and_refreshes_legitimate_commits() {
        let fixture = Fixture::new();
        let resource = fixture.allocate().await;
        let initial = resource.state.identity().unwrap().clone();
        assert_eq!(
            Path::new(&initial.top).parent(),
            fixture.repository.parent()
        );
        assert_ne!(initial.top, initial.primary);
        assert_ne!(initial.git_dir, initial.common_dir);
        assert_eq!(
            initial.head,
            command(&fixture.repository, &["rev-parse", "origin/main"])
        );
        let marker: Owner = serde_json::from_slice(
            &fs::read(Path::new(&initial.git_dir).join(OWNER_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(marker.allocation_id, resource.id);
        assert_eq!(marker.host_id, resource.host_id);
        fixture.commit_work(&resource);
        let refreshed = record(GitBackend::default().inspect(resource).await);
        let identity = refreshed.state.identity().unwrap();
        assert!(matches!(refreshed.state, ResourceState::Ready { .. }));
        assert!(same_location(&initial, identity));
        assert_ne!(initial.head, identity.head);
        assert_eq!(
            inspect_native(&fixture.repository).await.unwrap().top,
            initial.primary
        );
    }

    #[tokio::test]
    async fn allocation_never_adopts_an_existing_path_or_invalid_branch() {
        let fixture = Fixture::new();
        let request = fixture.request();
        let intent = ResourceRecord::allocating(request.clone());
        let (_, path) = planned_path(&intent).await.unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep.txt"), "preserve").unwrap();
        assert!(
            held_reason(GitBackend::default().allocate(request).await).contains("already exists")
        );
        assert_eq!(
            fs::read_to_string(path.join("keep.txt")).unwrap(),
            "preserve"
        );
        let mut request = fixture.request();
        request.branch = "../invalid".into();
        let before = command(&fixture.repository, &["worktree", "list", "--porcelain"]);
        let reason = held_reason(GitBackend::default().allocate(request).await);
        assert!(
            reason.contains("Invalid worktree branch"),
            "Unexpected allocation refusal: {reason}"
        );
        assert_eq!(
            command(&fixture.repository, &["worktree", "list", "--porcelain"]),
            before
        );
    }

    #[tokio::test]
    async fn changed_owner_host_branch_or_missing_marker_is_held() {
        let fixture = Fixture::new();
        let resource = fixture.allocate().await;
        let identity = resource.state.identity().unwrap().clone();
        let mut wrong_host = resource.clone();
        wrong_host.host_id = "another-host".into();
        assert!(
            held_reason(GitBackend::default().inspect(wrong_host).await)
                .contains("another allocation")
        );
        command(
            Path::new(&identity.top),
            &["switch", "-c", "another-branch"],
        );
        assert!(
            held_reason(GitBackend::default().inspect(resource.clone()).await).contains("topology")
        );
        command(Path::new(&identity.top), &["switch", &resource.branch]);
        fs::remove_file(Path::new(&identity.git_dir).join(OWNER_FILE)).unwrap();
        assert!(
            held_reason(GitBackend::default().inspect(resource).await)
                .contains("marker is missing")
        );
        assert!(Path::new(&identity.top).exists());
        assert!(fixture.repository.exists());
    }

    struct Consumer(Child);
    impl Drop for Consumer {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[tokio::test]
    async fn registered_and_native_cwd_consumers_hold_cleanup() {
        let fixture = Fixture::new();
        let resource = fixture.allocate().await;
        let mut registered = resource.clone();
        registered.consumers.push(TaskId::new());
        assert!(
            held_reason(
                GitBackend::default()
                    .plan_cleanup(registered, &fixture.plans())
                    .await
            )
            .contains("registered consumers")
        );
        let identity = resource.state.identity().unwrap();
        let _consumer = Consumer(
            Command::new("sleep")
                .arg("60")
                .current_dir(&identity.top)
                .spawn()
                .unwrap(),
        );
        let reason = held_reason(
            GitBackend::default()
                .plan_cleanup(resource, &fixture.plans())
                .await,
        );
        assert!(reason.contains("still used by process"), "{reason}");
    }

    #[tokio::test]
    async fn missing_cleanup_helper_reports_its_failure_directly() {
        let directory = tempfile::tempdir().unwrap();
        let backend = GitBackend::new(vec!["/nonexistent-agent-guarded-cleanup".into()]).unwrap();
        let error = backend
            .helper(directory.path(), &["--plan"])
            .await
            .err()
            .unwrap();
        assert!(
            error.to_string().contains("helper is unavailable"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn missing_cleanup_helper_preserves_the_worktree() {
        let fixture = Fixture::new();
        let resource = fixture.allocate().await;
        let identity = resource.state.identity().unwrap().clone();
        let backend = GitBackend::new(vec!["/nonexistent-agent-guarded-cleanup".into()]).unwrap();
        held_reason(backend.plan_cleanup(resource, &fixture.plans()).await);
        assert!(Path::new(&identity.top).exists());
    }

    #[test]
    fn incomplete_process_coverage_keeps_positive_consumers_and_holds_unknowns() {
        let identity = NativeWorktreeIdentity {
            primary: "/fixture/repository".into(),
            top: "/fixture/worktree".into(),
            git_dir: "/fixture/repository/.git/worktrees/task".into(),
            common_dir: "/fixture/repository/.git".into(),
            branch: "task/fixture".into(),
            head: "fixture-head".into(),
        };
        let mut output = Output {
            code: 1,
            stdout: format!("p123\nn{}\n", identity.top),
            stderr: "lsof: WARNING: inaccessible file system; output may be incomplete".into(),
        };
        for path in [&identity.top, &identity.git_dir] {
            output.stdout = format!("p123\nn{path}\n");
            let error = unused_processes(&output, &identity).unwrap_err();
            assert_eq!(error.to_string(), "Worktree is still used by process 123");
        }
        output.stdout = "p456\nn/fixture/worktree-other\n".into();
        let error = unused_processes(&output, &identity).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Could not inspect active resource processes; preserving worktree"
        );
        output.stdout.clear();
        assert!(unused_processes(&output, &identity).is_err());
        output.stderr.clear();
        assert!(unused_processes(&output, &identity).is_ok());
    }

    #[tokio::test]
    async fn failed_submodule_initialization_stays_held_after_inspection() {
        let fixture = Fixture::new();
        command(
            &fixture.root,
            &["init", "--initial-branch=main", "component"],
        );
        let component = fixture.root.join("component");
        command(&component, &["config", "user.name", "Fixture"]);
        command(
            &component,
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(component.join("component.txt"), "component\n").unwrap();
        command(&component, &["add", "component.txt"]);
        command(&component, &["commit", "-m", "Initial component"]);
        command(
            &fixture.repository,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                component.to_str().unwrap(),
                "component",
            ],
        );
        command(
            &fixture.repository,
            &[
                "config",
                "-f",
                ".gitmodules",
                "submodule.component.url",
                fixture.root.join("missing-component").to_str().unwrap(),
            ],
        );
        command(&fixture.repository, &["add", ".gitmodules", "component"]);
        command(
            &fixture.repository,
            &["commit", "-m", "Unavailable component fixture"],
        );
        command(&fixture.repository, &["push", "origin", "main"]);
        let resource = record(GitBackend::default().allocate(fixture.request()).await);
        assert!(
            matches!(resource.state, ResourceState::Held { .. }),
            "{resource:?}"
        );
        assert!(Path::new(&resource.state.identity().unwrap().top).is_dir());
        assert!(
            held_reason(GitBackend::default().inspect(resource).await)
                .contains("initialization is incomplete")
        );
    }

    #[tokio::test]
    #[ignore = "requires the installed guarded git cleanup helper"]
    async fn guarded_helper_collects_only_the_exact_merged_owned_worktree() {
        let fixture = Fixture::new();
        let backend = installed_helper();
        let resource = fixture.allocate().await;
        fixture.commit_work(&resource);
        fixture.merge(&resource);
        let resource = record(backend.inspect(resource).await);
        let identity = resource.state.identity().unwrap().clone();
        let (resource, reviewed) = plan(backend.plan_cleanup(resource, &fixture.plans()).await);
        assert!(!Path::new(&reviewed.path).starts_with(&identity.top));
        let result = backend.collect(resource, reviewed.clone()).await;
        let ResourceReport::Collected {
            record,
            receipt: Some(receipt),
        } = result
        else {
            panic!("{result:?}")
        };
        assert!(
            matches!(record.state, ResourceState::Removed { .. }),
            "{record:?}"
        );
        assert_eq!(receipt.status, "completed");
        assert_eq!(absence(&identity).await.unwrap(), (true, true, true));
        assert!(fixture.repository.join("task.txt").is_file());
        assert!(Path::new(&reviewed.path).is_file());
    }

    #[tokio::test]
    #[ignore = "requires the installed guarded git cleanup helper"]
    async fn helper_refuses_dirt_and_unmerged_history_and_rechecks_after_review() {
        let fixture = Fixture::new();
        let backend = installed_helper();
        let resource = fixture.allocate().await;
        fixture.commit_work(&resource);
        let resource = record(backend.inspect(resource).await);
        let identity = resource.state.identity().unwrap().clone();
        let reason = held_reason(
            backend
                .plan_cleanup(resource.clone(), &fixture.plans())
                .await,
        );
        assert!(reason.contains("Guarded cleanup plan refused"), "{reason}");
        fixture.merge(&resource);
        fs::write(Path::new(&identity.top).join("untracked.txt"), "keep this").unwrap();
        assert!(
            held_reason(
                backend
                    .plan_cleanup(resource.clone(), &fixture.plans())
                    .await
            )
            .contains("Guarded cleanup plan refused")
        );
        fs::remove_file(Path::new(&identity.top).join("untracked.txt")).unwrap();
        let (resource, reviewed) = plan(backend.plan_cleanup(resource, &fixture.plans()).await);
        fs::write(
            Path::new(&identity.top).join("task.txt"),
            "changed after review\n",
        )
        .unwrap();
        let result = backend.collect(resource, reviewed).await;
        let reason = held_reason(result);
        assert!(reason.contains("Guarded cleanup refused"), "{reason}");
        assert_eq!(absence(&identity).await.unwrap(), (false, false, false));
    }

    #[tokio::test]
    #[ignore = "requires the installed guarded git cleanup helper"]
    async fn a_native_branch_delete_refusal_is_reported_as_partial_without_retry() {
        let fixture = Fixture::new();
        let backend = installed_helper();
        let resource = fixture.allocate().await;
        fixture.commit_work(&resource);
        fixture.merge(&resource);
        let resource = record(backend.inspect(resource).await);
        let identity = resource.state.identity().unwrap().clone();
        let (resource, reviewed) = plan(backend.plan_cleanup(resource, &fixture.plans()).await);
        let lock =
            Path::new(&identity.common_dir).join(format!("refs/heads/{}.lock", resource.branch));
        fs::write(&lock, "native ref lock fixture").unwrap();
        let result = record(backend.collect(resource, reviewed.clone()).await);
        assert!(
            matches!(
                result.state,
                ResourceState::Partial {
                    path_absent: true,
                    registry_absent: true,
                    branch_absent: false,
                    ..
                }
            ),
            "{result:?}"
        );
        let again = record(backend.collect(result, reviewed).await);
        assert!(matches!(again.state, ResourceState::Partial { .. }));
        assert_eq!(absence(&identity).await.unwrap(), (true, true, false));
        assert!(fixture.repository.exists());
    }

    #[tokio::test]
    #[ignore = "requires the installed guarded git cleanup helper"]
    async fn lost_cleanup_reply_reconciles_retiring_intent_without_replaying_removal() {
        let fixture = Fixture::new();
        let backend = installed_helper();
        let resource = fixture.allocate().await;
        fixture.commit_work(&resource);
        fixture.merge(&resource);
        let resource = record(backend.inspect(resource).await);
        let (retiring, reviewed) = plan(backend.plan_cleanup(resource, &fixture.plans()).await);
        let completed = record(backend.collect(retiring.clone(), reviewed.clone()).await);
        assert!(
            matches!(completed.state, ResourceState::Removed { .. }),
            "{completed:?}"
        );
        // The successful host reply was lost; Pi still has its prior intent.
        let recovered = record(backend.collect(retiring, reviewed).await);
        assert!(
            matches!(
                recovered.state,
                ResourceState::Partial {
                    path_absent: true,
                    registry_absent: true,
                    branch_absent: true,
                    ..
                }
            ),
            "{recovered:?}"
        );
        assert!(fixture.repository.join("task.txt").exists());
    }

    #[tokio::test]
    #[ignore = "requires the installed guarded git cleanup helper"]
    async fn initialized_submodule_history_is_retained_by_the_native_helper() {
        let fixture = Fixture::new();
        let backend = installed_helper();
        command(
            &fixture.root,
            &["init", "--initial-branch=main", "component"],
        );
        let component = fixture.root.join("component");
        command(&component, &["config", "user.name", "Fixture"]);
        command(
            &component,
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(component.join("component.txt"), "component\n").unwrap();
        command(&component, &["add", "component.txt"]);
        command(&component, &["commit", "-m", "Initial component"]);
        let resource = fixture.allocate().await;
        let worktree = Path::new(&resource.state.identity().unwrap().top);
        command(
            worktree,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                component.to_str().unwrap(),
                "component",
            ],
        );
        command(worktree, &["commit", "-m", "Add component"]);
        fixture.commit_work(&resource);
        fixture.merge(&resource);
        command(
            &fixture.repository,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "update",
                "--init",
            ],
        );
        let resource = record(backend.inspect(resource).await);
        let (resource, reviewed) = plan(backend.plan_cleanup(resource, &fixture.plans()).await);
        let result = backend.collect(resource, reviewed).await;
        let ResourceReport::Collected {
            record,
            receipt: Some(receipt),
        } = result
        else {
            panic!("{result:?}")
        };
        assert!(
            matches!(record.state, ResourceState::Removed { .. }),
            "{record:?}"
        );
        let archive = PathBuf::from(
            receipt
                .retained_submodules
                .expect("Initialized submodule store must be retained"),
        );
        assert!(
            archive.join("modules/component/HEAD").is_file(),
            "{archive:?}"
        );
        assert!(fixture.repository.join("component/component.txt").is_file());
    }
}
