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

type IdentifiedFeature = {
  layer: string;
  osm_id: number;
  source: string | null;
  class: string | null;
  name: string;
  distance_meters: number;
  lat: number | null;
  lon: number | null;
};

type IdentifyResponse = {
  lat: number;
  lon: number;
  radius_meters: number;
  features: IdentifiedFeature[];
};

const VECTOR_MIN_ZOOM = 14;
const MAX_MAP_ZOOM = 18;
const MAP_VIEW_STORAGE_KEY = 'tileme.map.view.v1';

type StoredMapView = {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

const DEFAULT_MAP_VIEW: StoredMapView = {
  lng: 133.7751,
  lat: -25.2744,
  zoom: 3,
  bearing: 0,
  pitch: 0,
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
  let identifyMarker: maplibregl.Marker | null = null;
  let identifyAbort: AbortController | null = null;
  const [mapError, setMapError] = createSignal<string | null>(null);
  const [identifyResult, setIdentifyResult] = createSignal<IdentifyResponse | null>(null);
  const [identifyError, setIdentifyError] = createSignal<string | null>(null);
  const [isIdentifying, setIsIdentifying] = createSignal(false);

  onMount(() => {
    const rasterTileUrlTemplate = `${window.location.origin}/raster/{z}/{x}/{y}.png`;
    const vectorTileUrlTemplate = `${window.location.origin}/tiles/{z}/{x}/{y}.pbf`;
    const initialView = loadStoredMapView();

    map = new maplibregl.Map({
      container: containerRef,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'tileme-raster': {
            type: 'raster',
            tiles: [rasterTileUrlTemplate],
            minzoom: 0,
            maxzoom: VECTOR_MIN_ZOOM,
            scheme: 'xyz',
            tileSize: 256,
          },
          tileme: {
            type: 'vector',
            tiles: [vectorTileUrlTemplate],
            minzoom: VECTOR_MIN_ZOOM,
            maxzoom: MAX_MAP_ZOOM,
            scheme: 'xyz',
          },
        },
        layers: [
          {
            id: 'tileme-raster',
            type: 'raster',
            source: 'tileme-raster',
            maxzoom: VECTOR_MIN_ZOOM,
          },
          ...mapLayers,
        ],
      },
      center: [initialView.lng, initialView.lat],
      zoom: initialView.zoom,
      bearing: initialView.bearing,
      pitch: initialView.pitch,
      maxZoom: MAX_MAP_ZOOM,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('click', (event) => {
      void identifyPoint(event.lngLat.lat, event.lngLat.lng);
    });
    map.on('error', (event) => {
      const message = event.error?.message;
      if (message) {
        setMapError(message);
      }
    });
    map.on('moveend', persistCurrentMapView);
    window.addEventListener('beforeunload', persistCurrentMapView);

    onCleanup(() => {
      identifyAbort?.abort();
      identifyMarker?.remove();
      persistCurrentMapView();
      window.removeEventListener('beforeunload', persistCurrentMapView);
      map?.remove();
      identifyAbort = null;
      identifyMarker = null;
      map = null;
    });
  });

  function persistCurrentMapView() {
    if (!map) {
      return;
    }

    saveStoredMapView({
      lng: map.getCenter().lng,
      lat: map.getCenter().lat,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    });
  }

  async function identifyPoint(lat: number, lon: number) {
    if (!map) {
      return;
    }

    identifyAbort?.abort();
    const controller = new AbortController();
    identifyAbort = controller;

    identifyMarker?.remove();
    identifyMarker = new maplibregl.Marker({ color: '#2f6f88' }).setLngLat([lon, lat]).addTo(map);

    setIdentifyResult({
      lat,
      lon,
      radius_meters: identifyRadiusMeters(map.getZoom()),
      features: [],
    });
    setIdentifyError(null);
    setIsIdentifying(true);

    const params = new URLSearchParams({
      lat: lat.toFixed(7),
      lon: lon.toFixed(7),
      radius_meters: identifyRadiusMeters(map.getZoom()).toFixed(0),
    });

    try {
      const response = await fetch(`/identify?${params}`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      setIdentifyResult((await response.json()) as IdentifyResponse);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setIdentifyError(error instanceof Error ? error.message : 'Unable to identify this point');
    } finally {
      if (identifyAbort === controller) {
        setIsIdentifying(false);
      }
    }
  }

  function clearIdentify() {
    identifyAbort?.abort();
    identifyAbort = null;
    identifyMarker?.remove();
    identifyMarker = null;
    setIdentifyResult(null);
    setIdentifyError(null);
    setIsIdentifying(false);
  }

  return (
    <>
      <div ref={containerRef} class="map" />
      <Show when={mapError()}>{(error) => <div class="mapError">{error()}</div>}</Show>
      <Show when={identifyResult()}>
        {(result) => (
          <section class="identifyPanel" aria-label="Clicked point details">
            <div class="identifyHeader">
              <div>
                <h2>Point</h2>
                <p>{formatCoordinate(result().lat, result().lon)}</p>
              </div>
              <button type="button" class="iconButton" onClick={clearIdentify}>
                Close
              </button>
            </div>

            <Show when={isIdentifying()}>
              <p class="identifyStatus">Looking up nearby names</p>
            </Show>

            <Show when={identifyError()}>
              {(error) => <p class="errorText">{error()}</p>}
            </Show>

            <Show
              when={!isIdentifying() && !identifyError() && result().features.length > 0}
              fallback={
                <Show when={!isIdentifying() && !identifyError()}>
                  <p class="emptyState">No named POIs found within {formatMeters(result().radius_meters)}.</p>
                </Show>
              }
            >
              <div class="identifyList">
                <For each={result().features}>
                  {(feature) => (
                    <article class="identifyItem">
                      <div>
                        <strong>{feature.name}</strong>
                        <span>{featureLabel(feature)}</span>
                      </div>
                      <small>{formatMeters(feature.distance_meters)}</small>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </section>
        )}
      </Show>
    </>
  );
}

function identifyRadiusMeters(zoom: number) {
  if (zoom >= 17) {
    return 25;
  }
  if (zoom >= 15) {
    return 45;
  }
  if (zoom >= 12) {
    return 85;
  }
  return 150;
}

function loadStoredMapView(): StoredMapView {
  try {
    const rawValue = window.localStorage.getItem(MAP_VIEW_STORAGE_KEY);
    if (!rawValue) {
      return DEFAULT_MAP_VIEW;
    }

    const storedView = JSON.parse(rawValue) as Partial<StoredMapView>;
    if (!isValidStoredMapView(storedView)) {
      return DEFAULT_MAP_VIEW;
    }

    return storedView;
  } catch {
    return DEFAULT_MAP_VIEW;
  }
}

function saveStoredMapView(view: StoredMapView) {
  try {
    window.localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Browsers can reject localStorage writes in private mode or when storage is full.
  }
}

function isValidStoredMapView(view: Partial<StoredMapView>): view is StoredMapView {
  return (
    isFiniteNumber(view.lng) &&
    isFiniteNumber(view.lat) &&
    isFiniteNumber(view.zoom) &&
    isFiniteNumber(view.bearing) &&
    isFiniteNumber(view.pitch) &&
    view.lng >= -180 &&
    view.lng <= 180 &&
    view.lat >= -90 &&
    view.lat <= 90 &&
    view.zoom >= 0 &&
    view.zoom <= MAX_MAP_ZOOM &&
    view.pitch >= 0 &&
    view.pitch <= 85
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatCoordinate(lat: number, lon: number) {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

function featureLabel(feature: IdentifiedFeature) {
  return [feature.layer, feature.source, feature.class].filter(Boolean).join(' / ');
}

function formatMeters(value: number) {
  if (value < 1) {
    return 'at point';
  }
  return `${Math.round(value)} m`;
}

const mapLayers: maplibregl.LayerSpecification[] = [
  {
    id: 'background',
    type: 'background',
    minzoom: VECTOR_MIN_ZOOM,
    paint: { 'background-color': '#edf0e7' },
  },
  {
    id: 'water',
    type: 'fill',
    source: 'tileme',
    'source-layer': 'water',
    minzoom: VECTOR_MIN_ZOOM,
    paint: { 'fill-color': '#8fb9d4', 'fill-opacity': 0.92 },
  },
  {
    id: 'landuse',
    type: 'fill',
    source: 'tileme',
    'source-layer': 'landuse',
    minzoom: VECTOR_MIN_ZOOM,
    paint: { 'fill-color': '#bfd4ad', 'fill-opacity': 0.5 },
  },
  {
    id: 'boundaries',
    type: 'line',
    source: 'tileme',
    'source-layer': 'boundaries',
    minzoom: VECTOR_MIN_ZOOM,
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
    minzoom: VECTOR_MIN_ZOOM,
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
    minzoom: VECTOR_MIN_ZOOM,
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
    minzoom: VECTOR_MIN_ZOOM,
    paint: { 'fill-color': '#c6a889', 'fill-opacity': 0.76 },
  },
  {
    id: 'water-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'water',
    minzoom: VECTOR_MIN_ZOOM,
    filter: ['has', 'name'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 13],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#31677f',
      'text-halo-color': '#d9edf5',
      'text-halo-width': 1.1,
    },
  },
  {
    id: 'landuse-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'landuse',
    minzoom: VECTOR_MIN_ZOOM,
    filter: [
      'all',
      ['has', 'name'],
      ['in', ['get', 'class'], ['literal', ['park', 'wood', 'forest', 'nature_reserve', 'recreation_ground', 'grass']]],
    ],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 12],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#4f7447',
      'text-halo-color': '#eff6e8',
      'text-halo-width': 1.1,
    },
  },
  {
    id: 'road-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: VECTOR_MIN_ZOOM,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['coalesce', ['get', 'name'], ['get', 'ref']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 12],
      'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 14, 280, 18, 220],
    },
    paint: {
      'text-color': '#5c554c',
      'text-halo-color': '#fff8ea',
      'text-halo-width': 1.2,
    },
  },
  {
    id: 'poi-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'pois',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 18, 11],
      'text-anchor': 'top',
      'text-offset': [0, 0.6],
      'text-allow-overlap': false,
      'symbol-sort-key': ['match', ['get', 'source'], 'tourism', 1, 'amenity', 2, 'leisure', 3, 'shop', 4, 5],
    },
    paint: {
      'text-color': '#4f463b',
      'text-halo-color': '#fffdf5',
      'text-halo-width': 1.1,
    },
  },
  {
    id: 'places',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'places',
    minzoom: VECTOR_MIN_ZOOM,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 13],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#26302d',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.2,
    },
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
