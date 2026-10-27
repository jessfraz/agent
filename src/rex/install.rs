//! Install the Messages actions without replacing the user's Rex configuration.

use std::{
    env, fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::SystemTime,
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::rex::{RexClient, read_failure};

const BEGIN: &[u8] = b"-- BEGIN agent Messages (managed by agent rex install)";
const END: &[u8] = b"-- END agent Messages";
const LOADER: &[u8] = b"\n-- BEGIN agent Messages (managed by agent rex install)\nrequire('agent_messages')\n-- END agent Messages\n";

#[derive(Debug, Deserialize, Serialize)]
pub struct InstallOutcome {
    pub changed: bool,
    pub config_path: PathBuf,
    pub module_path: PathBuf,
}

pub async fn install(module_source: &str) -> Result<InstallOutcome> {
    let config_path = config_path(
        env::var_os("REX_CONFIG").map(PathBuf::from),
        env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        dirs::home_dir(),
    )?;
    install_at(&config_path, module_source, &RexClient::new(None)).await
}

fn config_path(
    explicit: Option<PathBuf>,
    xdg: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf> {
    let path = explicit.filter(|path| !path.as_os_str().is_empty());
    let path = match path {
        Some(path) => path,
        None => xdg
            .filter(|path| !path.as_os_str().is_empty())
            .or_else(|| home.map(|path| path.join(".config")))
            .context("Rex configuration directory is unavailable; set REX_CONFIG")?
            .join("rex/init.lua"),
    };
    std::path::absolute(path).context("Could not resolve the Rex configuration path")
}

async fn install_at(
    config_path: &Path,
    module_source: &str,
    client: &RexClient,
) -> Result<InstallOutcome> {
    let identity = format!("{:x}", Sha256::digest(module_source.as_bytes()));
    let module_source = format!(
        "{module_source}\nrex.action {{\n  name = 'agent_messages_identity',\n  title = 'Agent: Messages module identity',\n  run = function() return {{ sha256 = '{identity}' }} end,\n}}\n"
    );
    let directory = config_path
        .parent()
        .context("Rex config has no directory")?;
    let module_path = directory.join("agent_messages.lua");
    ensure!(
        config_path != module_path,
        "REX_CONFIG cannot be agent_messages.lua"
    );
    let config = snapshot(config_path)?;
    let module = snapshot(&module_path)?;
    let original = config
        .as_ref()
        .map_or(&[][..], |file| file.bytes.as_slice());
    let has_loader = count(original, LOADER) != 0;
    ensure!(
        count(original, BEGIN) == usize::from(has_loader)
            && count(original, END) == usize::from(has_loader),
        "The managed Rex Messages loader was edited or duplicated; review {} before installing",
        config_path.display()
    );
    ensure!(
        module.is_none()
            || has_loader
            || module
                .as_ref()
                .is_some_and(|file| file.bytes == module_source.as_bytes()),
        "{} already exists without an agent-managed loader; preserve or rename it before installing",
        module_path.display()
    );
    if has_loader
        && module
            .as_ref()
            .is_some_and(|file| file.bytes == module_source.as_bytes())
        && verify_actions(client, &identity).await.is_ok()
    {
        return Ok(InstallOutcome {
            changed: false,
            config_path: config_path.into(),
            module_path,
        });
    }
    fs::create_dir_all(directory).context("Could not create the Rex configuration directory")?;
    let mut desired = original.to_vec();
    if !has_loader {
        desired.extend_from_slice(LOADER);
    }
    let mut changes = Vec::new();
    let result = async {
        if module
            .as_ref()
            .is_none_or(|file| file.bytes != module_source.as_bytes())
        {
            changes.push(replace(&module_path, &module, module_source.as_bytes())?);
        }
        // A same-directory candidate retains Rex's native sibling-module lookup.
        // Its module is restored if validation or the final reload fails.
        let candidate = temporary(directory, &desired, 0o600)?;
        client
            .run(vec![
                "config".into(),
                "check".into(),
                candidate
                    .path
                    .to_str()
                    .context("Rex config path is not UTF-8")?
                    .into(),
                "--json".into(),
            ])
            .await
            .map_err(read_failure)
            .context(
                "Rex rejected the candidate configuration; inspect it with rex config check",
            )?;
        if !has_loader {
            changes.push(replace(config_path, &config, &desired)?);
        } else {
            ensure!(
                snapshot(config_path)? == config,
                "Rex config changed during installation"
            );
        }
        for change in &changes {
            ensure!(
                snapshot(&change.path)? == change.installed,
                "Rex config changed during installation"
            );
        }
        client
            .run(vec!["config".into(), "reload".into(), "--json".into()])
            .await
            .map_err(read_failure)
            .context(
                "Rex could not reload its local configuration; ensure the local server is running",
            )?;
        verify_actions(client, &identity).await?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let mut conflicts = Vec::new();
        for change in changes.iter().rev() {
            if let Err(rollback) = change.restore() {
                conflicts.push(rollback.to_string());
            }
        }
        if conflicts.is_empty() {
            return Err(error.context("Rex installation failed; its file changes were restored"));
        }
        return Err(error.context(format!(
            "Rex installation failed; concurrent edits were preserved: {}",
            conflicts.join("; ")
        )));
    }
    Ok(InstallOutcome {
        changed: true,
        config_path: config_path.into(),
        module_path,
    })
}

async fn verify_actions(client: &RexClient, expected_identity: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Catalog {
        actions: Vec<Action>,
    }
    #[derive(Deserialize)]
    struct Action {
        name: String,
    }
    #[derive(Deserialize)]
    struct Identity {
        sha256: String,
    }
    let output = client
        .run(vec!["actions".into(), "--json".into()])
        .await
        .map_err(read_failure)
        .context("Could not verify the local Rex Messages actions")?;
    let catalog: Catalog =
        serde_json::from_slice(&output).context("Rex returned an invalid action catalog")?;
    for expected in [
        "agent_messages_start",
        "agent_messages_read",
        "agent_messages_cancel",
    ] {
        ensure!(
            catalog.actions.iter().any(|action| action.name == expected),
            "Rex did not load the Messages actions; its running server may use another config file. Add require('agent_messages') in that file and run rex config reload"
        );
    }
    let output = client
        .run(vec![
            "do".into(),
            "agent_messages_identity".into(),
            "--json".into(),
        ])
        .await
        .map_err(read_failure)
        .context("Could not verify the loaded Rex Messages module identity")?;
    let identity: Identity = serde_json::from_slice(&output)
        .context("Rex returned an invalid Messages module identity")?;
    ensure!(
        identity.sha256 == expected_identity,
        "Rex loaded another Messages module; its running server may use another config file. Add require('agent_messages') in that file and run rex config reload"
    );
    Ok(())
}

fn count(bytes: &[u8], needle: &[u8]) -> usize {
    bytes
        .windows(needle.len())
        .filter(|part| *part == needle)
        .count()
}

#[derive(Clone, PartialEq)]
struct Snapshot {
    bytes: Vec<u8>,
    device: u64,
    inode: u64,
    modified: SystemTime,
    mode: u32,
}

fn snapshot(path: &Path) -> Result<Option<Snapshot>> {
    if let Some(existing) = path.ancestors().find(|ancestor| ancestor.exists()) {
        ensure!(
            !fs::canonicalize(existing)?.starts_with("/nix/store"),
            "{} is managed by Nix; add require('agent_messages') in its owning configuration instead",
            path.display()
        );
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Could not inspect Rex configuration"),
    };
    ensure!(
        metadata.is_file(),
        "{} is managed or is not a regular file; add require('agent_messages') in its owning configuration instead",
        path.display()
    );
    Ok(Some(Snapshot {
        bytes: fs::read(path).context("Could not read Rex configuration")?,
        device: metadata.dev(),
        inode: metadata.ino(),
        modified: metadata.modified()?,
        mode: metadata.permissions().mode(),
    }))
}

struct Temporary {
    path: PathBuf,
}

impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn temporary(directory: &Path, bytes: &[u8], mode: u32) -> Result<Temporary> {
    let temporary = Temporary {
        path: directory.join(format!(".agent-messages-{}.lua", uuid::Uuid::new_v4())),
    };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary.path)
        .context("Could not prepare Rex configuration")?;
    file.write_all(bytes)?;
    file.set_permissions(fs::Permissions::from_mode(mode))?;
    file.sync_all()?;
    Ok(temporary)
}

struct Change {
    path: PathBuf,
    previous: Option<Snapshot>,
    installed: Option<Snapshot>,
}

fn replace(path: &Path, previous: &Option<Snapshot>, bytes: &[u8]) -> Result<Change> {
    let directory = path.parent().context("Rex config has no directory")?;
    let candidate = temporary(
        directory,
        bytes,
        previous.as_ref().map_or(0o600, |file| file.mode),
    )?;
    ensure!(
        snapshot(path)? == *previous,
        "Rex configuration changed while preparing installation"
    );
    // Record the inode being installed, rather than claiming a later user edit
    // if the destination changes immediately after the rename.
    let installed = snapshot(&candidate.path)?;
    fs::rename(&candidate.path, path).context("Could not replace Rex configuration")?;
    Ok(Change {
        path: path.into(),
        previous: previous.clone(),
        installed,
    })
}

impl Change {
    fn restore(&self) -> Result<()> {
        ensure!(
            snapshot(&self.path)? == self.installed,
            "{} changed; left untouched",
            self.path.display()
        );
        match &self.previous {
            Some(previous) => {
                replace(&self.path, &self.installed, &previous.bytes)?;
            }
            None => fs::remove_file(&self.path)?,
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::symlink, path::PathBuf};

    use crate::rex::{
        RexClient,
        install::{config_path, install_at, replace, snapshot},
    };

    #[test]
    fn native_config_path_precedence() {
        let home = Some(PathBuf::from("/example/home"));
        let xdg = Some(PathBuf::from("/example/config"));
        assert_eq!(
            config_path(
                Some("/example/custom.lua".into()),
                xdg.clone(),
                home.clone()
            )
            .unwrap(),
            PathBuf::from("/example/custom.lua")
        );
        assert_eq!(
            config_path(None, xdg, home.clone()).unwrap(),
            PathBuf::from("/example/config/rex/init.lua")
        );
        assert_eq!(
            config_path(None, None, home).unwrap(),
            PathBuf::from("/example/home/.config/rex/init.lua")
        );
    }

    #[tokio::test]
    async fn managed_config_and_unowned_module_are_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("init.lua");
        let owned = directory.path().join("owned.lua");
        fs::write(&owned, "return {}\n").unwrap();
        symlink(&owned, &path).unwrap();
        let client = RexClient::new(None);
        assert!(install_at(&path, "return {}\n", &client).await.is_err());
        assert!(fs::symlink_metadata(&path).unwrap().is_symlink());
        fs::remove_file(&path).unwrap();
        fs::write(&path, "-- user configuration\n").unwrap();
        let module = directory.path().join("agent_messages.lua");
        fs::write(&module, "-- unrelated module\n").unwrap();
        assert!(install_at(&path, "return {}\n", &client).await.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"-- user configuration\n");
        assert_eq!(fs::read(&module).unwrap(), b"-- unrelated module\n");
    }

    #[test]
    fn rollback_leaves_concurrent_user_edits() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("init.lua");
        fs::write(&path, "original\n").unwrap();
        let previous = snapshot(&path).unwrap();
        let change = replace(&path, &previous, b"installed\n").unwrap();
        fs::write(&path, "user edit\n").unwrap();
        assert!(change.restore().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"user edit\n");
    }

    #[tokio::test]
    #[ignore = "requires the installed native Rex CLI"]
    async fn native_validation_and_reload_failures_restore_the_original_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("init.lua");
        let original = b"-- existing configuration\n";
        fs::write(&path, original).unwrap();
        let client = RexClient::new(Some(format!(
            "unix://{}",
            directory.path().join("offline.sock").display()
        )));
        for (module, context) in [
            (
                "this is not valid Lua",
                "Rex rejected the candidate configuration; inspect it with rex config check",
            ),
            (
                include_str!("source.lua"),
                "Rex could not reload its local configuration; ensure the local server is running",
            ),
        ] {
            let error = install_at(&path, module, &client).await.unwrap_err();
            assert!(error.chain().any(|cause| cause.to_string() == context));
            assert_eq!(fs::read(&path).unwrap(), original);
            assert!(!directory.path().join("agent_messages.lua").exists());
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[tokio::test]
    #[ignore = "requires the installed native Rex CLI and an isolated native server"]
    async fn native_install_preserves_actions_and_repeated_install_is_a_true_noop() {
        use std::process::{Command, Stdio};

        use serde::Deserialize;

        struct Server(String);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = Command::new("rex")
                    .args([
                        "--autostart=false",
                        "--timeout",
                        "2s",
                        "--server",
                        &self.0,
                        "server",
                        "stop",
                    ])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        #[derive(Deserialize)]
        struct Status {
            config: Generation,
        }
        #[derive(Deserialize)]
        struct Generation {
            generation: u64,
        }
        #[derive(Deserialize)]
        struct Preserved {
            preserved: bool,
        }
        async fn generation(client: &RexClient) -> u64 {
            let output = client
                .run(vec![
                    "api".into(),
                    "call".into(),
                    "server.status".into(),
                    "{}".into(),
                ])
                .await
                .unwrap();
            serde_json::from_slice::<Status>(&output)
                .unwrap()
                .config
                .generation
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("init.lua");
        let original = b"-- keep this comment\nrex.action { name='existing_action', title='Existing action', run=function() return { preserved=true } end }";
        fs::write(&path, original).unwrap();
        let endpoint = format!("unix://{}", directory.path().join("rex.sock").display());
        let server = Server(endpoint.clone());
        let started = Command::new("rex")
            .args([
                "--autostart=false",
                "--server",
                &endpoint,
                "server",
                "start",
                "--config",
            ])
            .arg(&path)
            .arg("--state-dir")
            .arg(directory.path().join("state"))
            .arg("--json")
            .output()
            .unwrap();
        assert!(
            started.status.success(),
            "{}",
            String::from_utf8_lossy(&started.stderr)
        );
        let client = RexClient::new(Some(endpoint));
        let other_directory = directory.path().join("other-config");
        fs::create_dir(&other_directory).unwrap();
        let other_path = other_directory.join("init.lua");
        fs::write(&other_path, original).unwrap();
        assert!(
            install_at(&other_path, include_str!("source.lua"), &client)
                .await
                .is_err()
        );
        assert_eq!(fs::read(&other_path).unwrap(), original);
        assert!(!other_directory.join("agent_messages.lua").exists());
        let installed = install_at(&path, include_str!("source.lua"), &client)
            .await
            .unwrap();
        assert!(installed.changed);
        assert!(fs::read(&path).unwrap().starts_with(original));
        let newer_source = format!(
            "{}\n-- Updated module revision.\n",
            include_str!("source.lua")
        );
        assert!(
            install_at(&other_path, &newer_source, &client)
                .await
                .is_err(),
            "Loading the old action names must not verify a newer module in an unused config"
        );
        assert_eq!(fs::read(&other_path).unwrap(), original);
        assert!(!other_directory.join("agent_messages.lua").exists());
        let preserved = client
            .run(vec!["do".into(), "existing_action".into(), "--json".into()])
            .await
            .unwrap();
        assert!(
            serde_json::from_slice::<Preserved>(&preserved)
                .unwrap()
                .preserved
        );
        let config_before = snapshot(&path).unwrap();
        let module_before = snapshot(&installed.module_path).unwrap();
        let generation_before = generation(&client).await;
        let repeated = install_at(&path, include_str!("source.lua"), &client)
            .await
            .unwrap();
        assert!(!repeated.changed);
        assert!(snapshot(&path).unwrap() == config_before);
        assert!(snapshot(&installed.module_path).unwrap() == module_before);
        assert_eq!(generation(&client).await, generation_before);

        // An interrupted setup can leave current bytes on disk while Rex still
        // runs the previous module. Reconcile it once without rewriting files.
        let old_module = fs::read(&installed.module_path).unwrap();
        assert!(
            install_at(&path, &newer_source, &client)
                .await
                .unwrap()
                .changed
        );
        let current_module = fs::read(&installed.module_path).unwrap();
        fs::write(&installed.module_path, old_module).unwrap();
        client
            .run(vec!["config".into(), "reload".into(), "--json".into()])
            .await
            .unwrap();
        fs::write(&installed.module_path, current_module).unwrap();
        let interrupted_module = snapshot(&installed.module_path).unwrap();
        let interrupted_generation = generation(&client).await;
        let recovered = install_at(&path, &newer_source, &client).await.unwrap();
        assert!(recovered.changed);
        assert!(snapshot(&path).unwrap() == config_before);
        assert!(snapshot(&installed.module_path).unwrap() == interrupted_module);
        assert_eq!(generation(&client).await, interrupted_generation + 1);
        let current_generation = generation(&client).await;
        assert!(
            !install_at(&path, &newer_source, &client)
                .await
                .unwrap()
                .changed
        );
        assert!(snapshot(&path).unwrap() == config_before);
        assert!(snapshot(&installed.module_path).unwrap() == interrupted_module);
        assert_eq!(generation(&client).await, current_generation);
        drop(server);
    }
}
