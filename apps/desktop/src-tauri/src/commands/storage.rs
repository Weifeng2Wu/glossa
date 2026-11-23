use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::{io::AsyncWriteExt, process::Command};

async fn prepare_database(app_data_dir: &Path) -> Result<PathBuf, String> {
    let directory = app_data_dir.join("academic-agent");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "Could not prepare application database.".to_string())?;
    Ok(directory.join("glossa.sqlite"))
}

pub async fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "App data unavailable.".to_string())?;
    prepare_database(&app_data_dir).await
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
    async fn prepares_glossa_database_directory() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("com.glossa.app");

        let target = prepare_database(&current).await.unwrap();
        assert_eq!(target, current.join("academic-agent/glossa.sqlite"));
        assert!(tokio::fs::try_exists(current.join("academic-agent")).await.unwrap());
    }
}
