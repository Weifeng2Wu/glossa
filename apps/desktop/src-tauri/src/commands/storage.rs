use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::{io::AsyncWriteExt, process::Command};

pub const LEGACY_APP_IDENTIFIER: &str = "com.inkwell.app";

pub fn legacy_app_data_dir(current: &Path) -> Option<PathBuf> {
    let parent = current.parent()?;
    let candidate = parent.join(LEGACY_APP_IDENTIFIER);
    if candidate == current {
        None
    } else {
        Some(candidate)
    }
}

async fn migrate_database_if_needed(app_data_dir: &Path) -> Result<PathBuf, String> {
    let directory = app_data_dir.join("academic-agent");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "Could not prepare application database.".to_string())?;
    let target = directory.join("glossa.sqlite");
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Ok(target);
    }

    let mut candidates = vec![directory.join("inkwell.sqlite")];
    if let Some(legacy_root) = legacy_app_data_dir(app_data_dir) {
        let legacy_agent = legacy_root.join("academic-agent");
        candidates.push(legacy_agent.join("glossa.sqlite"));
        candidates.push(legacy_agent.join("inkwell.sqlite"));
    }

    for source in candidates {
        if !tokio::fs::try_exists(&source).await.unwrap_or(false) {
            continue;
        }
        if tokio::fs::copy(&source, &target).await.is_ok() {
            for suffix in ["-wal", "-shm"] {
                let sidecar = PathBuf::from(format!("{}{suffix}", source.to_string_lossy()));
                if tokio::fs::try_exists(&sidecar).await.unwrap_or(false) {
                    let dest_sidecar =
                        PathBuf::from(format!("{}{suffix}", target.to_string_lossy()));
                    let _ = tokio::fs::copy(&sidecar, &dest_sidecar).await;
                }
            }
            if let Some(source_dir) = source.parent() {
                let legacy_registry = source_dir.join("skills/registry.json");
                let target_registry = directory.join("skills/registry.json");
                if tokio::fs::try_exists(&legacy_registry).await.unwrap_or(false)
                    && !tokio::fs::try_exists(&target_registry).await.unwrap_or(false)
                {
                    let _ = tokio::fs::create_dir_all(directory.join("skills")).await;
                    let _ = tokio::fs::copy(&legacy_registry, &target_registry).await;
                }
            }
            break;
        }
    }

    Ok(target)
}

pub async fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "App data unavailable.".to_string())?;
    migrate_database_if_needed(&app_data_dir).await
}

#[derive(Default)]
pub struct StorageState {
    access: tokio::sync::Mutex<()>,
}

#[tauri::command]
pub async fn app_storage_request(
    app: AppHandle,
    state: tauri::State<'_, StorageState>,
    request: Value,
) -> Result<Value, String> {
    let operation = request.get("type").and_then(Value::as_str).unwrap_or("");
    if !matches!(operation, "bootstrap" | "settings_write" | "conversation_list" | "conversation_read" | "conversation_save" | "conversation_rename" | "conversation_delete") {
        return Err("Unsupported application storage operation.".into());
    }
    execute(&app, &state, request).await
}

pub async fn internal_request(app: &AppHandle, request: Value) -> Result<Value, String> {
    let state = app.state::<StorageState>();
    execute(app, &state, request).await
}

async fn execute(app: &AppHandle, state: &StorageState, request: Value) -> Result<Value, String> {
    let _guard = state.access.lock().await;
    let database = database_path(app).await?;
    let directory = database
        .parent()
        .ok_or("Could not prepare application database.")?;
    tokio::fs::write(directory.join("storage.mjs"), include_str!("../../../../../packages/academic-agent/src/storage.mjs"))
        .await.map_err(|_| "Could not prepare SQLite service.")?;
    let bytes = serde_json::to_vec(&request).map_err(|_| "Invalid database request.")?;
    if bytes.len() > 64 * 1024 * 1024 { return Err("Database request too large.".into()); }
    let mut command = Command::new(super::agent_runtime::node_binary()?);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let mut child = command.arg(directory.join("storage.mjs")).arg(&database)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true)
        .spawn().map_err(|_| "Could not start SQLite storage. Glossa requires Node.js 24 or newer.")?;
    let mut stdin = child.stdin.take().ok_or("Database service unavailable.")?;
    tokio::time::timeout(Duration::from_secs(30), stdin.write_all(&bytes)).await
        .map_err(|_| "Database write timed out.")?.map_err(|_| "Could not send database request.")?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await
        .map_err(|_| "Database request timed out.")?.map_err(|_| "Database service failed.")?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).chars().take(1200).collect());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Invalid database response.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrates_legacy_inkwell_database_and_skills_registry() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("com.inkwell.app");
        let current = root.path().join("com.glossa.app");
        tokio::fs::create_dir_all(legacy.join("academic-agent/skills"))
            .await
            .unwrap();
        tokio::fs::write(legacy.join("academic-agent/inkwell.sqlite"), b"sqlite-data")
            .await
            .unwrap();
        tokio::fs::write(
            legacy.join("academic-agent/skills/registry.json"),
            b"{\"schemaVersion\":1,\"skills\":[{\"id\":\"demo\"}]}",
        )
        .await
        .unwrap();

        let target = migrate_database_if_needed(&current).await.unwrap();
        assert_eq!(target, current.join("academic-agent/glossa.sqlite"));
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"sqlite-data");
        assert_eq!(
            tokio::fs::read(current.join("academic-agent/skills/registry.json"))
                .await
                .unwrap(),
            b"{\"schemaVersion\":1,\"skills\":[{\"id\":\"demo\"}]}"
        );
    }
}
