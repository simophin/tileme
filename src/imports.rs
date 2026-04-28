use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{Path as AxumPath, State};
use axum::routing::{get, post};
use axum::Json;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgListener;
use sqlx::{PgPool, Row};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::app::AppState;
use crate::db;
use crate::error::AppError;

const IMPORT_JOB_CHANNEL: &str = "tileme_import_jobs";
const JOB_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const JOB_COLUMNS: &str = "id, source_type::text AS source_type, source_value, mode::text AS mode, state::text AS state, progress_message, log_tail, error_message, cancel_requested, started_at, finished_at, heartbeat_at, created_at, updated_at";

pub fn router() -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/imports", post(create_import).get(list_imports))
        .route("/imports/:id", get(get_import))
        .route("/imports/:id/cancel", post(cancel_import))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ImportSource {
    LocalPath { path: String },
    Url { url: String },
}

#[derive(Debug, Deserialize)]
pub struct CreateImportRequest {
    pub source: ImportSource,
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_mode() -> String {
    "replace".into()
}

#[derive(Debug, Serialize)]
pub struct ImportJob {
    pub id: Uuid,
    pub source_type: String,
    pub source_value: String,
    pub mode: String,
    pub state: String,
    pub progress_message: Option<String>,
    pub log_tail: String,
    pub error_message: Option<String>,
    pub cancel_requested: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub async fn mark_interrupted_jobs_failed(pool: &PgPool) -> Result<()> {
    sqlx::query(
        "UPDATE import_jobs
         SET state = 'failed',
             error_message = 'server stopped during import',
             finished_at = now(),
             updated_at = now()
         WHERE state = 'running'",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn create_import(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateImportRequest>,
) -> Result<Json<ImportJob>, AppError> {
    if request.mode != "replace" {
        return Err(AppError::BadRequest(
            "only replace imports are currently supported".into(),
        ));
    }

    let (source_type, source_value) = match request.source {
        ImportSource::LocalPath { path } => ("local_path", path),
        ImportSource::Url { url } => ("url", url),
    };

    let row = sqlx::query(
        "WITH created AS (
            INSERT INTO import_jobs (source_type, source_value, mode)
            VALUES ($1::import_source_type, $2, $3::import_mode)
            RETURNING id, source_type::text AS source_type, source_value, mode::text AS mode, state::text AS state, progress_message, log_tail, error_message, cancel_requested, started_at, finished_at, heartbeat_at, created_at, updated_at
         ), notified AS (
            SELECT pg_notify('tileme_import_jobs', id::text) FROM created
         )
         SELECT created.* FROM created, notified",
    )
    .bind(source_type)
    .bind(source_value)
    .bind(request.mode)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(row_to_job(row)?))
}

async fn list_imports(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ImportJob>>, AppError> {
    let rows = sqlx::query(&format!(
        "SELECT {JOB_COLUMNS} FROM import_jobs ORDER BY created_at DESC LIMIT 100"
    ))
    .fetch_all(&state.pool)
    .await?;
    rows.into_iter()
        .map(row_to_job)
        .collect::<Result<Vec<_>>>()
        .map(Json)
        .map_err(AppError::from)
}

async fn get_import(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<ImportJob>, AppError> {
    let row = sqlx::query(&format!(
        "SELECT {JOB_COLUMNS} FROM import_jobs WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(row_to_job(row)?))
}

async fn cancel_import(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<ImportJob>, AppError> {
    let row = sqlx::query(
        "UPDATE import_jobs
         SET cancel_requested = true, updated_at = now()
         WHERE id = $1 AND state IN ('queued', 'running')
         RETURNING id, source_type::text AS source_type, source_value, mode::text AS mode, state::text AS state, progress_message, log_tail, error_message, cancel_requested, started_at, finished_at, heartbeat_at, created_at, updated_at",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(row_to_job(row)?))
}

pub async fn worker_loop(state: Arc<AppState>) {
    let mut listener = match PgListener::connect_with(&state.pool).await {
        Ok(mut listener) => {
            if let Err(err) = listener.listen(IMPORT_JOB_CHANNEL).await {
                error!(error = %err, channel = IMPORT_JOB_CHANNEL, "failed to listen for import job notifications");
                None
            } else {
                info!(
                    channel = IMPORT_JOB_CHANNEL,
                    "listening for import job notifications"
                );
                Some(listener)
            }
        }
        Err(err) => {
            error!(error = %err, "failed to create Postgres import job listener");
            None
        }
    };

    loop {
        drain_queued_jobs(&state).await;

        let mut listener_failed = false;

        if let Some(pg_listener) = listener.as_mut() {
            tokio::select! {
                notification = pg_listener.recv() => {
                    match notification {
                        Ok(notification) => {
                            info!(
                                channel = notification.channel(),
                                payload = notification.payload(),
                                "received import job notification"
                            );
                        }
                        Err(err) => {
                            error!(error = %err, "import job listener failed; falling back to periodic sweeps");
                            listener_failed = true;
                        }
                    }
                }
                _ = sleep(JOB_SWEEP_INTERVAL) => {}
            }
        } else {
            sleep(JOB_SWEEP_INTERVAL).await;
        }

        if listener_failed {
            listener = None;
        }
    }
}

async fn drain_queued_jobs(state: &Arc<AppState>) {
    loop {
        match run_one_queued_job(state).await {
            Ok(true) => {}
            Ok(false) => break,
            Err(err) => {
                error!(error = %err, "import worker iteration failed");
                break;
            }
        }
    }
}

async fn run_one_queued_job(state: &Arc<AppState>) -> Result<bool> {
    let Some(job) = claim_job(&state.pool).await? else {
        return Ok(false);
    };

    let job_id = job.id;
    state.metrics.import_job_active.set(1);
    info!(%job_id, source_type = %job.source_type, "claimed import job");

    let result = run_import_job(state, &job).await;
    state.metrics.import_job_active.set(0);

    match result {
        Ok(()) => {
            sqlx::query(
                "UPDATE import_jobs
                 SET state = 'succeeded',
                     progress_message = 'import completed',
                     finished_at = now(),
                     updated_at = now()
                 WHERE id = $1",
            )
            .bind(job_id)
            .execute(&state.pool)
            .await?;
            state
                .metrics
                .import_jobs
                .with_label_values(&["succeeded"])
                .inc();
            info!(%job_id, "import job succeeded");
        }
        Err(err) => {
            let state_name = if is_cancel_requested(&state.pool, job_id)
                .await
                .unwrap_or(false)
            {
                "cancelled"
            } else {
                "failed"
            };
            sqlx::query(
                "UPDATE import_jobs
                 SET state = $2::import_job_state,
                     error_message = $3,
                     finished_at = now(),
                     updated_at = now()
                 WHERE id = $1",
            )
            .bind(job_id)
            .bind(state_name)
            .bind(err.to_string())
            .execute(&state.pool)
            .await?;
            state
                .metrics
                .import_jobs
                .with_label_values(&[state_name])
                .inc();
            warn!(%job_id, state = state_name, error = %err, "import job ended");
        }
    }

    Ok(true)
}

async fn claim_job(pool: &PgPool) -> Result<Option<ImportJob>> {
    let row = sqlx::query(
        "UPDATE import_jobs
         SET state = 'running',
             started_at = now(),
             heartbeat_at = now(),
             progress_message = 'starting import',
             updated_at = now()
         WHERE id = (
             SELECT id FROM import_jobs
             WHERE state = 'queued' AND cancel_requested = false
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
         )
         RETURNING id, source_type::text AS source_type, source_value, mode::text AS mode, state::text AS state, progress_message, log_tail, error_message, cancel_requested, started_at, finished_at, heartbeat_at, created_at, updated_at",
    )
    .fetch_optional(pool)
    .await?;
    row.map(row_to_job).transpose()
}

async fn run_import_job(state: &Arc<AppState>, job: &ImportJob) -> Result<()> {
    let input_path = prepare_source(state, job).await?;
    update_progress(&state.pool, job.id, "preparing database").await?;
    prepare_database_for_replace(&state.pool).await?;

    update_progress(&state.pool, job.id, "running osm2pgsql").await?;
    run_osm2pgsql(state, job.id, &input_path).await?;

    update_progress(
        &state.pool,
        job.id,
        "creating indexes and generalized tables",
    )
    .await?;
    post_import_database_setup(&state.pool).await?;

    update_progress(&state.pool, job.id, "bumping tile version").await?;
    let version = db::bump_tile_version(&state.pool).await?;
    sqlx::query("DELETE FROM tile_cache WHERE version < $1")
        .bind(version)
        .execute(&state.pool)
        .await?;
    Ok(())
}

async fn prepare_source(state: &Arc<AppState>, job: &ImportJob) -> Result<PathBuf> {
    match job.source_type.as_str() {
        "local_path" => {
            let path = PathBuf::from(&job.source_value);
            if !path.exists() {
                anyhow::bail!("local import path does not exist: {}", path.display());
            }
            Ok(path)
        }
        "url" => download_source(state, job).await,
        other => anyhow::bail!("unsupported source type: {other}"),
    }
}

async fn download_source(state: &Arc<AppState>, job: &ImportJob) -> Result<PathBuf> {
    tokio::fs::create_dir_all(&state.config.import_dir).await?;
    let target = state.config.import_dir.join(format!("{}.osm.pbf", job.id));
    update_progress(&state.pool, job.id, "downloading source").await?;

    let response = reqwest::get(&job.source_value).await?.error_for_status()?;
    let mut file = tokio::fs::File::create(&target).await?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if is_cancel_requested(&state.pool, job.id).await? {
            anyhow::bail!("import cancelled");
        }
        file.write_all(&chunk?).await?;
    }

    Ok(target)
}

async fn run_osm2pgsql(state: &Arc<AppState>, job_id: Uuid, input_path: &Path) -> Result<()> {
    let mut child = Command::new(&state.config.osm2pgsql_bin)
        .arg("--create")
        .arg("--slim")
        .arg("--output")
        .arg("flex")
        .arg("--style")
        .arg(&state.config.osm2pgsql_flex_path)
        .arg("--database")
        .arg(&state.config.database_url)
        .arg("--cache")
        .arg(state.config.osm2pgsql_cache_mb.to_string())
        .arg("--number-processes")
        .arg("1")
        .arg(input_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to start {}", state.config.osm2pgsql_bin))?;

    let stdout = child.stdout.take().context("missing osm2pgsql stdout")?;
    let stderr = child.stderr.take().context("missing osm2pgsql stderr")?;
    let (tx, mut rx) = mpsc::channel::<String>(128);
    spawn_reader(stdout, tx.clone());
    spawn_reader(stderr, tx);

    let mut tail = LogTail::default();
    loop {
        tokio::select! {
            Some(line) = rx.recv() => {
                tail.push(line);
                update_log_tail(&state.pool, job_id, tail.as_str()).await?;
            }
            _ = sleep(Duration::from_secs(2)) => {
                sqlx::query("UPDATE import_jobs SET heartbeat_at = now(), updated_at = now() WHERE id = $1")
                    .bind(job_id)
                    .execute(&state.pool)
                    .await?;
                if is_cancel_requested(&state.pool, job_id).await? {
                    let _ = child.kill().await;
                    anyhow::bail!("import cancelled");
                }
                if let Some(status) = child.try_wait()? {
                    if status.success() {
                        return Ok(());
                    }
                    anyhow::bail!("osm2pgsql exited with status {status}");
                }
            }
        }
    }
}

fn spawn_reader<R>(reader: R, tx: mpsc::Sender<String>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });
}

#[derive(Default)]
struct LogTail {
    lines: Vec<String>,
}

impl LogTail {
    fn push(&mut self, line: String) {
        self.lines.push(line);
        if self.lines.len() > 80 {
            let excess = self.lines.len() - 80;
            self.lines.drain(0..excess);
        }
    }

    fn as_str(&self) -> String {
        self.lines.join("\n")
    }
}

async fn prepare_database_for_replace(pool: &PgPool) -> Result<()> {
    sqlx::query("DROP MATERIALIZED VIEW IF EXISTS gen_water_z0_5")
        .execute(pool)
        .await?;
    sqlx::query("DROP MATERIALIZED VIEW IF EXISTS gen_water_z6_8")
        .execute(pool)
        .await?;
    sqlx::query("DROP TABLE IF EXISTS osm_roads, osm_water, osm_landuse, osm_buildings, osm_places, osm_boundaries CASCADE")
        .execute(pool)
        .await?;
    Ok(())
}

async fn post_import_database_setup(pool: &PgPool) -> Result<()> {
    let statements = [
        "CREATE INDEX IF NOT EXISTS osm_roads_geom_idx ON osm_roads USING gist (geom)",
        "CREATE INDEX IF NOT EXISTS osm_roads_class_idx ON osm_roads (class)",
        "CREATE INDEX IF NOT EXISTS osm_water_geom_idx ON osm_water USING gist (geom)",
        "CREATE INDEX IF NOT EXISTS osm_landuse_geom_idx ON osm_landuse USING gist (geom)",
        "CREATE INDEX IF NOT EXISTS osm_landuse_class_idx ON osm_landuse (class)",
        "CREATE INDEX IF NOT EXISTS osm_buildings_geom_idx ON osm_buildings USING gist (geom)",
        "CREATE INDEX IF NOT EXISTS osm_places_geom_idx ON osm_places USING gist (geom)",
        "CREATE INDEX IF NOT EXISTS osm_places_class_idx ON osm_places (class)",
        "CREATE INDEX IF NOT EXISTS osm_boundaries_geom_idx ON osm_boundaries USING gist (geom)",
        "CREATE MATERIALIZED VIEW gen_water_z0_5 AS SELECT osm_id, class, name, ST_Multi(ST_SimplifyPreserveTopology(geom, 8000))::geometry(MultiPolygon, 3857) AS geom FROM osm_water WHERE ST_Area(geom) > 10000000",
        "CREATE INDEX gen_water_z0_5_geom_idx ON gen_water_z0_5 USING gist (geom)",
        "CREATE MATERIALIZED VIEW gen_water_z6_8 AS SELECT osm_id, class, name, ST_Multi(ST_SimplifyPreserveTopology(geom, 1500))::geometry(MultiPolygon, 3857) AS geom FROM osm_water WHERE ST_Area(geom) > 1000000",
        "CREATE INDEX gen_water_z6_8_geom_idx ON gen_water_z6_8 USING gist (geom)",
    ];

    for statement in statements {
        sqlx::query(statement).execute(pool).await?;
    }

    Ok(())
}

async fn update_progress(pool: &PgPool, id: Uuid, message: &str) -> Result<()> {
    sqlx::query(
        "UPDATE import_jobs
         SET progress_message = $2, heartbeat_at = now(), updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(message)
    .execute(pool)
    .await?;
    Ok(())
}

async fn update_log_tail(pool: &PgPool, id: Uuid, log_tail: String) -> Result<()> {
    sqlx::query("UPDATE import_jobs SET log_tail = $2, heartbeat_at = now(), updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(log_tail)
        .execute(pool)
        .await?;
    Ok(())
}

async fn is_cancel_requested(pool: &PgPool, id: Uuid) -> Result<bool> {
    let row = sqlx::query("SELECT cancel_requested FROM import_jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(row.try_get("cancel_requested")?)
}

fn row_to_job(row: sqlx::postgres::PgRow) -> Result<ImportJob> {
    Ok(ImportJob {
        id: row.try_get("id")?,
        source_type: row.try_get::<String, _>("source_type")?,
        source_value: row.try_get("source_value")?,
        mode: row.try_get::<String, _>("mode")?,
        state: row.try_get::<String, _>("state")?,
        progress_message: row.try_get("progress_message")?,
        log_tail: row.try_get("log_tail")?,
        error_message: row.try_get("error_message")?,
        cancel_requested: row.try_get("cancel_requested")?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
        heartbeat_at: row.try_get("heartbeat_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}
