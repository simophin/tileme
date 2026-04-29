use std::path::PathBuf;

use clap::Parser;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub listen_addr: String,
    pub import_dir: PathBuf,
    pub osm2pgsql_bin: String,
    pub osm2pgsql_cache_mb: u32,
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

    #[arg(long, env = "TILEME_IMPORT_DIR", default_value = "/tmp/tileme-imports")]
    import_dir: PathBuf,

    #[arg(long, env = "TILEME_OSM2PGSQL_BIN", default_value = "osm2pgsql")]
    osm2pgsql_bin: String,

    #[arg(long, env = "TILEME_OSM2PGSQL_CACHE_MB", default_value_t = 1024)]
    osm2pgsql_cache_mb: u32,

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
            import_dir: cli.import_dir,
            osm2pgsql_bin: cli.osm2pgsql_bin,
            osm2pgsql_cache_mb: cli.osm2pgsql_cache_mb,
            log_json: cli.log_json,
            #[cfg(debug_assertions)]
            debug_vite_origin: cli.debug_vite_origin,
        }
    }
}
