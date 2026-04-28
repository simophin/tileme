use anyhow::Result;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect_and_migrate(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

pub async fn current_tile_version(pool: &PgPool) -> Result<i64> {
    let row = sqlx::query("SELECT version FROM tile_versions WHERE id = true")
        .fetch_one(pool)
        .await?;
    Ok(row.try_get("version")?)
}

pub async fn bump_tile_version(pool: &PgPool) -> Result<i64> {
    let row = sqlx::query(
        "UPDATE tile_versions SET version = version + 1, updated_at = now() WHERE id = true RETURNING version",
    )
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("version")?)
}
