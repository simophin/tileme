import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { render } from 'solid-js/web';
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
  const [jobs, setJobs] = createSignal<ImportJob[]>([]);
  const [jobsError, setJobsError] = createSignal<string | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [sourceKind, setSourceKind] = createSignal<'local_path' | 'url'>('local_path');
  const [sourceValue, setSourceValue] = createSignal('');
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [isImportPanelOpen, setIsImportPanelOpen] = createSignal(false);

  const activeJob = createMemo(
    () => jobs().find((job) => job.state === 'running' || job.state === 'queued') ?? null,
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

  onMount(() => {
    void loadJobs();
    const interval = window.setInterval(() => void loadJobs(), 3000);
    onCleanup(() => window.clearInterval(interval));
  });

  async function submitImport(event: SubmitEvent) {
    event.preventDefault();
    setSubmitError(null);
    setIsSubmitting(true);

    const value = sourceValue().trim();
    const source =
      sourceKind() === 'url'
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
    <main class="shell">
      <section class="mapPane" aria-label="Map">
        <TileMap />
      </section>

      <button
        class="importHandle"
        type="button"
        aria-controls="import-panel"
        aria-expanded={isImportPanelOpen()}
        onClick={() => setIsImportPanelOpen((open) => !open)}
      >
        {isImportPanelOpen() ? 'Close imports' : 'Imports'}
      </button>

      <aside
        id="import-panel"
        class="sidePanel"
        classList={{ open: isImportPanelOpen() }}
        aria-label="Import controls"
      >
        <div class="brand">
          <h1>tileme</h1>
          <div class="brandActions">
            <StatusPill job={activeJob()} />
            <button class="iconButton" type="button" onClick={() => setIsImportPanelOpen(false)}>
              Close
            </button>
          </div>
        </div>

        <form class="importForm" onSubmit={submitImport}>
          <div class="segmented" role="radiogroup" aria-label="Import source type">
            <button
              type="button"
              classList={{ selected: sourceKind() === 'local_path' }}
              onClick={() => setSourceKind('local_path')}
            >
              File path
            </button>
            <button
              type="button"
              classList={{ selected: sourceKind() === 'url' }}
              onClick={() => setSourceKind('url')}
            >
              URL
            </button>
          </div>

          <label class="field">
            <span>{sourceKind() === 'url' ? 'OSM PBF URL' : 'Server file path'}</span>
            <input
              value={sourceValue()}
              onInput={(event) => setSourceValue(event.currentTarget.value)}
              placeholder={
                sourceKind() === 'url'
                  ? 'https://download.geofabrik.de/.../latest.osm.pbf'
                  : '/data/osm/australia-latest.osm.pbf'
              }
              required
            />
          </label>

          <Show when={submitError()}>
            {(error) => <p class="errorText">{error()}</p>}
          </Show>

          <button class="primaryButton" type="submit" disabled={isSubmitting()}>
            {isSubmitting() ? 'Starting import' : 'Start import'}
          </button>
        </form>

        <div class="jobsHeader">
          <h2>Import jobs</h2>
          <button type="button" onClick={() => void loadJobs()}>
            Refresh
          </button>
        </div>

        <Show when={jobsError()}>
          {(error) => <p class="errorText">{error()}</p>}
        </Show>

        <div class="jobList">
          <Show
            when={jobs().length > 0}
            fallback={<p class="emptyState">No imports yet.</p>}
          >
            <For each={jobs()}>{(job) => <JobRow job={job} onCancel={cancelJob} />}</For>
          </Show>
        </div>
      </aside>
    </main>
  );
}

function TileMap() {
  let containerRef!: HTMLDivElement;
  let map: Map | null = null;
  const [mapError, setMapError] = createSignal<string | null>(null);

  onMount(() => {
    const tileUrlTemplate = `${window.location.origin}/raster/{z}/{x}/{y}.png`;

    map = new maplibregl.Map({
      container: containerRef,
      style: {
        version: 8,
        sources: {
          tileme: {
            type: 'raster',
            tiles: [tileUrlTemplate],
            minzoom: 0,
            maxzoom: 16,
            scheme: 'xyz',
            tileSize: 256,
          },
        },
        layers: [
          {
            id: 'tileme-raster',
            type: 'raster',
            source: 'tileme',
          },
        ],
      },
      center: [133.7751, -25.2744],
      zoom: 3,
      maxZoom: 16,
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

    onCleanup(() => {
      map?.remove();
      map = null;
    });
  });

  return (
    <>
      <div ref={containerRef} class="map" />
      <Show when={mapError()}>{(error) => <div class="mapError">{error()}</div>}</Show>
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
];

function JobRow(props: { job: ImportJob; onCancel: (id: string) => Promise<void> }) {
  const canCancel = createMemo(() => props.job.state === 'queued' || props.job.state === 'running');
  const message = createMemo(() => props.job.error_message ?? props.job.progress_message ?? props.job.log_tail);

  return (
    <article class="jobRow">
      <div class="jobTop">
        <span class={`stateBadge ${props.job.state}`}>{props.job.state}</span>
        <time>{formatDate(props.job.created_at)}</time>
      </div>
      <p class="sourceValue" title={props.job.source_value}>
        {props.job.source_value}
      </p>
      <Show when={message()}>
        {(text) => <p class={props.job.error_message ? 'jobError' : 'jobMessage'}>{text()}</p>}
      </Show>
      <div class="jobActions">
        <span>{props.job.source_type === 'url' ? 'URL' : 'Path'}</span>
        <Show when={canCancel()}>
          <button
            type="button"
            onClick={() => void props.onCancel(props.job.id)}
            disabled={props.job.cancel_requested}
          >
            {props.job.cancel_requested ? 'Cancel pending' : 'Cancel'}
          </button>
        </Show>
      </div>
    </article>
  );
}

function StatusPill(props: { job: ImportJob | null }) {
  return (
    <Show
      when={props.job}
      fallback={<span class="statusPill idle">Idle</span>}
    >
      {(job) => <span class={`statusPill ${job().state}`}>{job().state}</span>}
    </Show>
  );
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

render(() => <App />, document.getElementById('root')!);
