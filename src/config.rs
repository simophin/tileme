use std::path::PathBuf;

use clap::Parser;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub listen_addr: String,
    pub public_base_url: Option<String>,
    pub import_dir: PathBuf,
    pub osm2pgsql_bin: String,
    pub osm2pgsql_flex_path: PathBuf,
    pub osm2pgsql_cache_mb: u32,
    pub cache_max_zoom: u8,
    pub raster_cache_max_bytes: i64,
    pub raster_cache_touch_interval_seconds: i64,
    pub raster_style_version: i32,
    pub log_json: bool,
    #[cfg(debug_assertions)]
    pub debug_vite_origin: String,
}

impl Config {
    pub fn from_args() -> Self {
        Cli::parse().into()
    }
}

#[derive(Debug, Parser)]
#[command(author, version, about = "Self-hosted OSM vector tile server")]
struct Cli {
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,

    #[arg(long, env = "TILEME_LISTEN_ADDR", default_value = "127.0.0.1:3000")]
    listen_addr: String,

    #[arg(long, env = "TILEME_PUBLIC_BASE_URL")]
    public_base_url: Option<String>,

    #[arg(long, env = "TILEME_IMPORT_DIR", default_value = "/tmp/tileme-imports")]
    import_dir: PathBuf,

    #[arg(long, env = "TILEME_OSM2PGSQL_BIN", default_value = "osm2pgsql")]
    osm2pgsql_bin: String,

    #[arg(
        long,
        env = "TILEME_OSM2PGSQL_FLEX",
        default_value = "osm2pgsql/flex.lua"
    )]
    osm2pgsql_flex_path: PathBuf,

    #[arg(long, env = "TILEME_OSM2PGSQL_CACHE_MB", default_value_t = 1024)]
    osm2pgsql_cache_mb: u32,

    #[arg(long, env = "TILEME_CACHE_MAX_ZOOM", default_value_t = 8)]
    cache_max_zoom: u8,

    #[arg(
        long,
        env = "TILEME_RASTER_CACHE_MAX_BYTES",
        default_value_t = 512 * 1024 * 1024
    )]
    raster_cache_max_bytes: i64,

    #[arg(
        long,
        env = "TILEME_RASTER_CACHE_TOUCH_INTERVAL_SECONDS",
        default_value_t = 300
    )]
    raster_cache_touch_interval_seconds: i64,

    #[arg(long, env = "TILEME_RASTER_STYLE_VERSION", default_value_t = 3)]
    raster_style_version: i32,

    #[arg(long, env = "TILEME_LOG_JSON", default_value_t = false)]
    log_json: bool,

    #[cfg(debug_assertions)]
    #[arg(
        long,
        env = "TILEME_DEBUG_VITE_ORIGIN",
        default_value = "http://127.0.0.1:4000"
    )]
    debug_vite_origin: String,
}

impl From<Cli> for Config {
    fn from(cli: Cli) -> Self {
        Self {
            database_url: cli.database_url,
            listen_addr: cli.listen_addr,
            public_base_url: cli.public_base_url,
            import_dir: cli.import_dir,
            osm2pgsql_bin: cli.osm2pgsql_bin,
            osm2pgsql_flex_path: cli.osm2pgsql_flex_path,
            osm2pgsql_cache_mb: cli.osm2pgsql_cache_mb,
            cache_max_zoom: cli.cache_max_zoom,
            raster_cache_max_bytes: cli.raster_cache_max_bytes,
            raster_cache_touch_interval_seconds: cli.raster_cache_touch_interval_seconds,
            raster_style_version: cli.raster_style_version,
            log_json: cli.log_json,
            #[cfg(debug_assertions)]
            debug_vite_origin: cli.debug_vite_origin,
        }
    }
}
