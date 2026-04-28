use prometheus::{HistogramOpts, HistogramVec, IntCounterVec, IntGauge, Registry};

#[derive(Clone)]
pub struct Metrics {
    pub registry: Registry,
    pub tile_requests: IntCounterVec,
    pub tile_cache_hits: IntCounterVec,
    pub tile_cache_misses: IntCounterVec,
    pub tile_generation_seconds: HistogramVec,
    pub raster_requests: IntCounterVec,
    pub raster_cache_hits: IntCounterVec,
    pub raster_cache_misses: IntCounterVec,
    pub raster_generation_seconds: HistogramVec,
    pub import_jobs: IntCounterVec,
    pub import_job_active: IntGauge,
}

impl Metrics {
    pub fn new() -> Result<Self, prometheus::Error> {
        let registry = Registry::new();
        let tile_requests = IntCounterVec::new(
            prometheus::Opts::new("tile_requests_total", "Tile requests by outcome"),
            &["outcome"],
        )?;
        let tile_cache_hits = IntCounterVec::new(
            prometheus::Opts::new("tile_cache_hits_total", "Tile cache hits by zoom"),
            &["z"],
        )?;
        let tile_cache_misses = IntCounterVec::new(
            prometheus::Opts::new("tile_cache_misses_total", "Tile cache misses by zoom"),
            &["z"],
        )?;
        let tile_generation_seconds = HistogramVec::new(
            HistogramOpts::new(
                "tile_generation_seconds",
                "Time spent generating vector tiles",
            ),
            &["z"],
        )?;
        let raster_requests = IntCounterVec::new(
            prometheus::Opts::new("raster_requests_total", "Raster tile requests by outcome"),
            &["outcome"],
        )?;
        let raster_cache_hits = IntCounterVec::new(
            prometheus::Opts::new("raster_cache_hits_total", "Raster cache hits by zoom"),
            &["z"],
        )?;
        let raster_cache_misses = IntCounterVec::new(
            prometheus::Opts::new("raster_cache_misses_total", "Raster cache misses by zoom"),
            &["z"],
        )?;
        let raster_generation_seconds = HistogramVec::new(
            HistogramOpts::new(
                "raster_generation_seconds",
                "Time spent generating raster tiles",
            ),
            &["z"],
        )?;
        let import_jobs = IntCounterVec::new(
            prometheus::Opts::new("import_jobs_total", "Import jobs by terminal state"),
            &["state"],
        )?;
        let import_job_active = IntGauge::new(
            "import_job_active",
            "Whether an import job is currently active",
        )?;

        registry.register(Box::new(tile_requests.clone()))?;
        registry.register(Box::new(tile_cache_hits.clone()))?;
        registry.register(Box::new(tile_cache_misses.clone()))?;
        registry.register(Box::new(tile_generation_seconds.clone()))?;
        registry.register(Box::new(raster_requests.clone()))?;
        registry.register(Box::new(raster_cache_hits.clone()))?;
        registry.register(Box::new(raster_cache_misses.clone()))?;
        registry.register(Box::new(raster_generation_seconds.clone()))?;
        registry.register(Box::new(import_jobs.clone()))?;
        registry.register(Box::new(import_job_active.clone()))?;

        Ok(Self {
            registry,
            tile_requests,
            tile_cache_hits,
            tile_cache_misses,
            tile_generation_seconds,
            raster_requests,
            raster_cache_hits,
            raster_cache_misses,
            raster_generation_seconds,
            import_jobs,
            import_job_active,
        })
    }
}
