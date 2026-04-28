import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { Map } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

type ImportState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

type ImportJob = {
  id: string;
  source_type: 'local_path' | 'url';
  source_value: string;
  mode: string;
  state: ImportState;
  progress_message: string | null;
  log_tail: string;
  error_message: string | null;
  cancel_requested: boolean;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

type ApiError = {
  error?: string;
};

function App() {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sourceKind, setSourceKind] = useState<'local_path' | 'url'>('local_path');
  const [sourceValue, setSourceValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const activeJob = useMemo(
    () => jobs.find((job) => job.state === 'running' || job.state === 'queued') ?? null,
    [jobs],
  );

  async function loadJobs() {
    try {
      const response = await fetch('/imports');
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      setJobs(await response.json());
      setJobsError(null);
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : 'Unable to load import jobs');
    }
  }

  useEffect(() => {
    void loadJobs();
    const interval = window.setInterval(() => void loadJobs(), 3000);
    return () => window.clearInterval(interval);
  }, []);

  async function submitImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    setIsSubmitting(true);

    const value = sourceValue.trim();
    const source =
      sourceKind === 'url'
        ? { type: 'url', url: value }
        : { type: 'local_path', path: value };

    try {
      const response = await fetch('/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, mode: 'replace' }),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      setSourceValue('');
      await loadJobs();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to create import job');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function cancelJob(id: string) {
    try {
      const response = await fetch(`/imports/${id}/cancel`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      await loadJobs();
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : 'Unable to cancel import');
    }
  }

  return (
    <main className="shell">
      <section className="mapPane" aria-label="Map">
        <TileMap />
      </section>

      <aside className="sidePanel" aria-label="Import controls">
        <div className="brand">
          <h1>tileme</h1>
          <StatusPill job={activeJob} />
        </div>

        <form className="importForm" onSubmit={submitImport}>
          <div className="segmented" role="radiogroup" aria-label="Import source type">
            <button
              type="button"
              className={sourceKind === 'local_path' ? 'selected' : ''}
              onClick={() => setSourceKind('local_path')}
            >
              File path
            </button>
            <button
              type="button"
              className={sourceKind === 'url' ? 'selected' : ''}
              onClick={() => setSourceKind('url')}
            >
              URL
            </button>
          </div>

          <label className="field">
            <span>{sourceKind === 'url' ? 'OSM PBF URL' : 'Server file path'}</span>
            <input
              value={sourceValue}
              onChange={(event) => setSourceValue(event.target.value)}
              placeholder={
                sourceKind === 'url'
                  ? 'https://download.geofabrik.de/.../latest.osm.pbf'
                  : '/data/osm/australia-latest.osm.pbf'
              }
              required
            />
          </label>

          {submitError && <p className="errorText">{submitError}</p>}

          <button className="primaryButton" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Starting import' : 'Start import'}
          </button>
        </form>

        <div className="jobsHeader">
          <h2>Import jobs</h2>
          <button type="button" onClick={() => void loadJobs()}>
            Refresh
          </button>
        </div>

        {jobsError && <p className="errorText">{jobsError}</p>}

        <div className="jobList">
          {jobs.length === 0 ? (
            <p className="emptyState">No imports yet.</p>
          ) : (
            jobs.map((job) => <JobRow key={job.id} job={job} onCancel={cancelJob} />)
          )}
        </div>
      </aside>
    </main>
  );
}

function TileMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          tileme: {
            type: 'vector',
            url: '/tiles.json',
          },
        },
        layers: mapLayers,
      },
      center: [133.7751, -25.2744],
      zoom: 3,
      maxZoom: 14,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('error', (event) => {
      const message = event.error?.message;
      if (message) {
        setMapError(message);
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <>
      <div ref={containerRef} className="map" />
      {mapError && <div className="mapError">{mapError}</div>}
    </>
  );
}

const mapLayers: maplibregl.LayerSpecification[] = [
  {
    id: 'background',
    type: 'background',
    paint: { 'background-color': '#edf0e7' },
  },
  {
    id: 'water',
    type: 'fill',
    source: 'tileme',
    'source-layer': 'water',
    paint: { 'fill-color': '#8fb9d4', 'fill-opacity': 0.92 },
  },
  {
    id: 'landuse',
    type: 'fill',
    source: 'tileme',
    'source-layer': 'landuse',
    minzoom: 8,
    paint: { 'fill-color': '#bfd4ad', 'fill-opacity': 0.5 },
  },
  {
    id: 'boundaries',
    type: 'line',
    source: 'tileme',
    'source-layer': 'boundaries',
    paint: {
      'line-color': ['case', ['<=', ['coalesce', ['get', 'admin_level'], 99], 4], '#6f5f53', '#9a8b7b'],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.55, 8, 0.85, 12, 0.65],
      'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.7, 7, 1.4, 12, 2.2],
    },
  },
  {
    id: 'roads-casing',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 5,
    paint: {
      'line-color': '#b8afa4',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 10, 0.75, 14, 0.9],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 10, 2.1, 14, 6.5],
    },
  },
  {
    id: 'roads',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 5,
    paint: {
      'line-color': ['case', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]], '#f1b35f', '#fff8ea'],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.72, 10, 0.9, 14, 1],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.45, 10, 1.35, 14, 4.6],
    },
  },
  {
    id: 'buildings',
    type: 'fill',
    source: 'tileme',
    'source-layer': 'buildings',
    minzoom: 14,
    paint: { 'fill-color': '#c6a889', 'fill-opacity': 0.76 },
  },
  {
    id: 'places',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'places',
    minzoom: 2,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 8, 14],
      'text-anchor': 'center',
    },
    paint: {
      'text-color': '#1f2d33',
      'text-halo-color': '#f5f4ef',
      'text-halo-width': 1.5,
    },
  },
];

function JobRow({ job, onCancel }: { job: ImportJob; onCancel: (id: string) => Promise<void> }) {
  const canCancel = job.state === 'queued' || job.state === 'running';
  const message = job.error_message ?? job.progress_message ?? job.log_tail;

  return (
    <article className="jobRow">
      <div className="jobTop">
        <span className={`stateBadge ${job.state}`}>{job.state}</span>
        <time>{formatDate(job.created_at)}</time>
      </div>
      <p className="sourceValue" title={job.source_value}>
        {job.source_value}
      </p>
      {message && <p className={job.error_message ? 'jobError' : 'jobMessage'}>{message}</p>}
      <div className="jobActions">
        <span>{job.source_type === 'url' ? 'URL' : 'Path'}</span>
        {canCancel && (
          <button type="button" onClick={() => void onCancel(job.id)} disabled={job.cancel_requested}>
            {job.cancel_requested ? 'Cancel pending' : 'Cancel'}
          </button>
        )}
      </div>
    </article>
  );
}

function StatusPill({ job }: { job: ImportJob | null }) {
  if (!job) {
    return <span className="statusPill idle">Idle</span>;
  }
  return <span className={`statusPill ${job.state}`}>{job.state}</span>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

async function readApiError(response: Response) {
  try {
    const body = (await response.json()) as ApiError;
    return body.error ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
