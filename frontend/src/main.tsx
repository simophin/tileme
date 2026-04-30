import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { render } from 'solid-js/web';
import maplibregl, { Map } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

type ImportState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

type ImportJob = {
  id: string;
  import_name: string;
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

type ImportName = {
  name: string;
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
  tags: Record<string, unknown>;
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

type ResolvedAddress = {
  osm_id: number;
  formatted_address: string;
  unit: string | null;
  house_number: string;
  street: string | null;
  suburb: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  distance_meters: number;
  lat: number;
  lon: number;
};

type AddressLookupResponse = {
  lat: number;
  lon: number;
  radius_meters: number;
  address: ResolvedAddress | null;
};

type SearchResult = {
  layer: string;
  import_name: string;
  osm_id: number;
  source: string | null;
  class: string | null;
  name: string;
  distance_meters: number | null;
  lat: number;
  lon: number;
};

type SearchResponse = {
  query: string;
  results: SearchResult[];
};

const MAX_MAP_ZOOM = 18;
const MAP_VIEW_STORAGE_KEY = 'tileme.map.view.v1';
const MAP_LAYER_SETTINGS_STORAGE_KEY = 'tileme.map.layers.v1';
const IDENTIFY_LONG_PRESS_MS = 550;
const IDENTIFY_LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const IDENTIFY_POST_LONG_PRESS_SUPPRESS_MS = 700;
const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_MIN_QUERY_CHARS = 2;

type MapLayerKey = 'transit' | 'walking' | 'cycling' | 'amenities';

type MapLayerSettings = Record<MapLayerKey, boolean>;

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

const DEFAULT_MAP_LAYER_SETTINGS: MapLayerSettings = {
  transit: true,
  walking: true,
  cycling: true,
  amenities: true,
};

const MAP_LAYER_OPTIONS: Array<{ key: MapLayerKey; label: string }> = [
  { key: 'transit', label: 'Transit' },
  { key: 'walking', label: 'Walking & Trails' },
  { key: 'cycling', label: 'Cycling' },
  { key: 'amenities', label: 'Amenities' },
];

const OVERLAY_LAYER_GROUPS: Record<MapLayerKey, string[]> = {
  transit: [
    'railway-casing',
    'railway-lines',
    'transit-route-lines',
    'transit-ferry-route-lines',
    'railway-labels',
    'transit-stop-markers',
    'transit-stop-labels',
    'transit-platform-labels',
    'bus-stop-labels',
    'transit-poi-labels',
  ],
  walking: ['walking-tracks', 'walking-steps', 'walking-track-labels'],
  cycling: [
    'cycling-cycleway-casing',
    'cycling-cycleways',
    'cycling-dedicated-lane-casing',
    'cycling-dedicated-lanes',
    'cycling-shared-lane-casing',
    'cycling-shared-lanes',
    'cycling-lane-labels',
  ],
  amenities: ['amenity-poi-labels'],
};

const TRAIN_STOP_CLASSES = ['halt', 'station'];
const TRAM_STOP_CLASSES = ['tram_stop'];
const RAIL_TRANSIT_STOP_CLASSES = [...TRAIN_STOP_CLASSES, ...TRAM_STOP_CLASSES];
const TRAIN_PLATFORM_CLASSES = ['platform'];
const TRAIN_STOP_ICON = 'tileme-train-stop';
const TRAM_STOP_ICON = 'tileme-tram-stop';
const BUS_STOP_CLASSES = ['bus_stop', 'bus_station'];
const BUS_STOP_ICON = 'tileme-bus-stop';
const RAIL_TRANSIT_PLATFORM_FILTER: maplibregl.ExpressionSpecification = [
  'all',
  ['==', ['get', 'source'], 'public_transport'],
  [
    'any',
    ['in', ['get', 'railway'], ['literal', TRAIN_PLATFORM_CLASSES]],
    [
      'all',
      ['in', ['get', 'class'], ['literal', TRAIN_PLATFORM_CLASSES]],
      ['==', ['get', 'train'], 'yes'],
    ],
    [
      'all',
      ['in', ['get', 'public_transport'], ['literal', TRAIN_PLATFORM_CLASSES]],
      ['==', ['get', 'train'], 'yes'],
    ],
  ],
];
const RAIL_TRANSIT_STOP_FILTER: maplibregl.ExpressionSpecification = [
  'all',
  ['==', ['get', 'source'], 'public_transport'],
  ['!', RAIL_TRANSIT_PLATFORM_FILTER],
  [
    'any',
    ['in', ['get', 'class'], ['literal', RAIL_TRANSIT_STOP_CLASSES]],
    ['in', ['get', 'railway'], ['literal', RAIL_TRANSIT_STOP_CLASSES]],
    ['==', ['get', 'train'], 'yes'],
    ['==', ['get', 'tram'], 'yes'],
  ],
];
const TRAM_TRANSIT_STOP_FILTER: maplibregl.ExpressionSpecification = [
  'any',
  ['in', ['get', 'class'], ['literal', TRAM_STOP_CLASSES]],
  ['in', ['get', 'railway'], ['literal', TRAM_STOP_CLASSES]],
  ['==', ['get', 'tram'], 'yes'],
];
const BUS_TRANSIT_STOP_FILTER: maplibregl.ExpressionSpecification = [
  'all',
  ['==', ['get', 'source'], 'public_transport'],
  [
    'any',
    ['in', ['get', 'class'], ['literal', BUS_STOP_CLASSES]],
    ['==', ['get', 'highway'], 'bus_stop'],
    ['==', ['get', 'bus'], 'yes'],
  ],
];

function App() {
  const [jobs, setJobs] = createSignal<ImportJob[]>([]);
  const [importNames, setImportNames] = createSignal<ImportName[]>([]);
  const [jobsError, setJobsError] = createSignal<string | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [importNameMode, setImportNameMode] = createSignal<'existing' | 'new'>('new');
  const [selectedImportName, setSelectedImportName] = createSignal('');
  const [newImportName, setNewImportName] = createSignal('');
  const [sourceKind, setSourceKind] = createSignal<'local_path' | 'url'>('local_path');
  const [sourceValue, setSourceValue] = createSignal('');
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [rerunningJobId, setRerunningJobId] = createSignal<string | null>(null);
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

  async function loadImportNames() {
    try {
      const response = await fetch('/import-names');
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const names = (await response.json()) as ImportName[];
      setImportNames(names);
      if (!selectedImportName() && names[0]) {
        setSelectedImportName(names[0].name);
        setImportNameMode('existing');
      }
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : 'Unable to load import names');
    }
  }

  onMount(() => {
    void loadJobs();
    void loadImportNames();
    const interval = window.setInterval(() => void loadJobs(), 3000);
    onCleanup(() => window.clearInterval(interval));
  });

  async function submitImport(event: SubmitEvent) {
    event.preventDefault();
    setSubmitError(null);
    setIsSubmitting(true);

    const importName =
      importNameMode() === 'existing' ? selectedImportName().trim() : newImportName().trim();
    const value = sourceValue().trim();
    const source =
      sourceKind() === 'url'
        ? { type: 'url', url: value }
        : { type: 'local_path', path: value };

    try {
      const response = await fetch('/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ import_name: importName, source, mode: 'replace' }),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      setSourceValue('');
      if (importNameMode() === 'new') {
        setSelectedImportName(importName);
        setNewImportName('');
        setImportNameMode('existing');
      }
      await loadJobs();
      await loadImportNames();
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

  async function rerunJob(id: string) {
    setRerunningJobId(id);
    try {
      const response = await fetch(`/imports/${id}/rerun`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      await loadJobs();
      await loadImportNames();
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : 'Unable to re-run import');
    } finally {
      setRerunningJobId(null);
    }
  }

  return (
    <main class="shell">
      <section class="mapPane" aria-label="Map">
        <TileMap
          isImportPanelOpen={isImportPanelOpen()}
          openImportPanel={() => setIsImportPanelOpen(true)}
        />
      </section>

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
          <div class="segmented" role="radiogroup" aria-label="Import name mode">
            <button
              type="button"
              classList={{ selected: importNameMode() === 'existing' }}
              onClick={() => setImportNameMode('existing')}
              disabled={importNames().length === 0}
            >
              Existing
            </button>
            <button
              type="button"
              classList={{ selected: importNameMode() === 'new' }}
              onClick={() => setImportNameMode('new')}
            >
              New
            </button>
          </div>

          <Show
            when={importNameMode() === 'existing' && importNames().length > 0}
            fallback={
              <label class="field">
                <span>Import name</span>
                <input
                  value={newImportName()}
                  onInput={(event) => setNewImportName(event.currentTarget.value)}
                  placeholder="australia"
                  maxlength="80"
                  required
                />
              </label>
            }
          >
            <label class="field">
              <span>Import name</span>
              <select
                value={selectedImportName()}
                onInput={(event) => setSelectedImportName(event.currentTarget.value)}
                required
              >
                <For each={importNames()}>
                  {(name) => <option value={name.name}>{name.name}</option>}
                </For>
              </select>
            </label>
          </Show>

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
            <For each={jobs()}>
              {(job) => (
                <JobRow
                  job={job}
                  onCancel={cancelJob}
                  onRerun={rerunJob}
                  isRerunning={rerunningJobId() === job.id}
                />
              )}
            </For>
          </Show>
        </div>
      </aside>
    </main>
  );
}

type TileMapProps = {
  isImportPanelOpen: boolean;
  openImportPanel: () => void;
};

function TileMap(props: TileMapProps) {
  let containerRef!: HTMLDivElement;
  let panelRef: HTMLElement | undefined;
  let map: Map | null = null;
  let identifyMarker: maplibregl.Marker | null = null;
  let searchMarker: maplibregl.Marker | null = null;
  let identifyAbort: AbortController | null = null;
  let addressLookupAbort: AbortController | null = null;
  let searchAbort: AbortController | null = null;
  let searchTimeout: number | null = null;
  let pendingLongPressTimeout: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let layerToggleButton: HTMLButtonElement | null = null;
  let importToggleButton: HTMLButtonElement | null = null;
  let activeLongPressPointerId: number | null = null;
  let longPressStartX = 0;
  let longPressStartY = 0;
  let suppressMapClickUntil = 0;
  const [mapError, setMapError] = createSignal<string | null>(null);
  const [identifyResult, setIdentifyResult] = createSignal<IdentifyResponse | null>(null);
  const [identifyError, setIdentifyError] = createSignal<string | null>(null);
  const [isIdentifying, setIsIdentifying] = createSignal(false);
  const [addressResult, setAddressResult] = createSignal<AddressLookupResponse | null>(null);
  const [addressError, setAddressError] = createSignal<string | null>(null);
  const [isLookingUpAddress, setIsLookingUpAddress] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [searchResults, setSearchResults] = createSignal<SearchResult[]>([]);
  const [searchError, setSearchError] = createSignal<string | null>(null);
  const [isSearching, setIsSearching] = createSignal(false);
  const [isSearchPanelOpen, setIsSearchPanelOpen] = createSignal(false);
  const [layerSettings, setLayerSettings] = createSignal(loadStoredMapLayerSettings());
  const [isLayerPanelOpen, setIsLayerPanelOpen] = createSignal(false);

  onMount(() => {
    const vectorTileUrlTemplate = `${window.location.origin}/tiles/{z}/{x}/{y}.pbf`;
    const initialView = loadStoredMapView();

    map = new maplibregl.Map({
      container: containerRef,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          tileme: {
            type: 'vector',
            tiles: [vectorTileUrlTemplate],
            minzoom: 0,
            maxzoom: MAX_MAP_ZOOM,
            scheme: 'xyz',
          },
        },
        layers: mapLayers,
      },
      center: [initialView.lng, initialView.lat],
      zoom: initialView.zoom,
      bearing: initialView.bearing,
      pitch: initialView.pitch,
      maxZoom: MAX_MAP_ZOOM,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showAccuracyCircle: true,
      }),
      'top-left',
    );
    map.addControl(createImportPanelControl(), 'top-left');
    map.addControl(createLayerPanelControl(), 'top-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('styleimagemissing', (event) => {
      if (event.id === TRAIN_STOP_ICON || event.id === TRAM_STOP_ICON || event.id === BUS_STOP_ICON) {
        addTransitStopIcons(map!);
      }
    });
    map.on('load', () => {
      if (map) {
        addTransitStopIcons(map);
        applyMapLayerSettings(map, layerSettings());
      }
    });
    map.on('click', handleMapClick);
    map.on('contextmenu', handleMapContextMenu);
    map.on('dragstart', cancelPendingLongPress);
    map.on('error', (event) => {
      const message = event.error?.message;
      if (message) {
        setMapError(message);
      }
    });
    map.on('moveend', persistCurrentMapView);
    resizeObserver = new ResizeObserver(() => map?.resize());
    resizeObserver.observe(containerRef);
    containerRef.addEventListener('pointerdown', handlePointerDown);
    containerRef.addEventListener('pointermove', handlePointerMove);
    containerRef.addEventListener('pointerup', cancelPendingLongPress);
    containerRef.addEventListener('pointercancel', cancelPendingLongPress);
    containerRef.addEventListener('pointerleave', cancelPendingLongPress);
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    window.addEventListener('beforeunload', persistCurrentMapView);

    onCleanup(() => {
      cancelPendingLongPress();
      clearPendingSearch();
      identifyAbort?.abort();
      addressLookupAbort?.abort();
      searchAbort?.abort();
      identifyMarker?.remove();
      searchMarker?.remove();
      resizeObserver?.disconnect();
      persistCurrentMapView();
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      containerRef.removeEventListener('pointerdown', handlePointerDown);
      containerRef.removeEventListener('pointermove', handlePointerMove);
      containerRef.removeEventListener('pointerup', cancelPendingLongPress);
      containerRef.removeEventListener('pointercancel', cancelPendingLongPress);
      containerRef.removeEventListener('pointerleave', cancelPendingLongPress);
      window.removeEventListener('beforeunload', persistCurrentMapView);
      map?.remove();
      identifyAbort = null;
      addressLookupAbort = null;
      searchAbort = null;
      identifyMarker = null;
      searchMarker = null;
      resizeObserver = null;
      layerToggleButton = null;
      importToggleButton = null;
      map = null;
    });
  });

  createEffect(() => {
    layerToggleButton?.setAttribute('aria-expanded', String(isLayerPanelOpen()));
  });

  createEffect(() => {
    importToggleButton?.setAttribute('aria-expanded', String(props.isImportPanelOpen));
  });

  createEffect(() => {
    const settings = layerSettings();
    saveStoredMapLayerSettings(settings);
    if (map?.isStyleLoaded()) {
      applyMapLayerSettings(map, settings);
    }
  });

  function toggleLayerSetting(key: MapLayerKey) {
    setLayerSettings((settings) => ({ ...settings, [key]: !settings[key] }));
  }

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    setIsSearchPanelOpen(true);
    clearPendingSearch();

    if (value.trim().length < SEARCH_MIN_QUERY_CHARS) {
      searchAbort?.abort();
      searchAbort = null;
      setSearchResults([]);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    searchTimeout = window.setTimeout(() => {
      searchTimeout = null;
      void runSearch(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  function clearPendingSearch() {
    if (searchTimeout === null) {
      return;
    }

    window.clearTimeout(searchTimeout);
    searchTimeout = null;
  }

  async function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    clearPendingSearch();
    await runSearch(searchQuery());
  }

  async function runSearch(rawQuery: string) {
    if (!map) {
      return;
    }

    const trimmed = rawQuery.trim();
    if (trimmed.length < SEARCH_MIN_QUERY_CHARS) {
      setSearchResults([]);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    searchAbort?.abort();
    const controller = new AbortController();
    searchAbort = controller;
    const center = map.getCenter();
    const params = new URLSearchParams({
      q: trimmed,
      lat: center.lat.toFixed(7),
      lon: center.lng.toFixed(7),
      limit: '12',
    });

    setIsSearching(true);
    setSearchError(null);
    setIsSearchPanelOpen(true);

    try {
      const response = await fetch(`/search?${params}`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const body = (await response.json()) as SearchResponse;
      if (searchQuery().trim() === trimmed) {
        setSearchResults(body.results);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setSearchError(error instanceof Error ? error.message : 'Unable to search the map');
    } finally {
      if (searchAbort === controller) {
        setIsSearching(false);
      }
    }
  }

  function selectSearchResult(result: SearchResult) {
    if (!map) {
      return;
    }

    searchMarker?.remove();
    searchMarker = new maplibregl.Marker({ color: '#7a4d1d' })
      .setLngLat([result.lon, result.lat])
      .addTo(map);
    map.flyTo({
      center: [result.lon, result.lat],
      zoom: Math.max(map.getZoom(), result.layer === 'admin_area' ? 11 : 15),
      essential: true,
    });
    setSearchQuery(result.name);
    setIsSearchPanelOpen(false);
    clearIdentify();
  }

  function clearSearch() {
    clearPendingSearch();
    searchAbort?.abort();
    searchAbort = null;
    searchMarker?.remove();
    searchMarker = null;
    setSearchQuery('');
    setSearchResults([]);
    setSearchError(null);
    setIsSearching(false);
    setIsSearchPanelOpen(false);
  }

  function createLayerPanelControl() {
    let controlContainer: HTMLDivElement | null = null;
    let button: HTMLButtonElement | null = null;

    function handleClick() {
      setIsLayerPanelOpen((open) => !open);
    }

    return {
      onAdd() {
        controlContainer = document.createElement('div');
        controlContainer.className = 'maplibregl-ctrl maplibregl-ctrl-group layerPanelControl';

        button = document.createElement('button');
        button.className = 'layerPanelToggle';
        button.type = 'button';
        button.setAttribute('aria-label', 'Toggle map layers');
        button.setAttribute('aria-controls', 'layer-control');
        button.setAttribute('aria-expanded', String(isLayerPanelOpen()));
        button.addEventListener('click', handleClick);

        const icon = document.createElement('span');
        icon.className = 'maplibregl-ctrl-icon';
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);

        layerToggleButton = button;
        controlContainer.append(button);
        return controlContainer;
      },
      onRemove() {
        button?.removeEventListener('click', handleClick);
        controlContainer?.remove();
        if (layerToggleButton === button) {
          layerToggleButton = null;
        }
        button = null;
        controlContainer = null;
      },
    };
  }

  function createImportPanelControl() {
    let controlContainer: HTMLDivElement | null = null;
    let button: HTMLButtonElement | null = null;

    function handleClick() {
      props.openImportPanel();
    }

    return {
      onAdd() {
        controlContainer = document.createElement('div');
        controlContainer.className = 'maplibregl-ctrl maplibregl-ctrl-group importPanelControl';

        button = document.createElement('button');
        button.className = 'importPanelToggle';
        button.type = 'button';
        button.setAttribute('aria-label', 'Open imports panel');
        button.setAttribute('aria-controls', 'import-panel');
        button.setAttribute('aria-expanded', String(props.isImportPanelOpen));
        button.addEventListener('click', handleClick);

        const icon = document.createElement('span');
        icon.className = 'maplibregl-ctrl-icon';
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);

        importToggleButton = button;
        controlContainer.append(button);
        return controlContainer;
      },
      onRemove() {
        button?.removeEventListener('click', handleClick);
        controlContainer?.remove();
        if (importToggleButton === button) {
          importToggleButton = null;
        }
        button = null;
        controlContainer = null;
      },
    };
  }

  function handleMapClick() {
    if (performance.now() < suppressMapClickUntil) {
      return;
    }

    if (!identifyResult() && !identifyError() && !isIdentifying()) {
      return;
    }

    clearIdentify();
  }

  function handleMapContextMenu(event: maplibregl.MapMouseEvent) {
    event.preventDefault();
    suppressMapClickUntil = performance.now() + IDENTIFY_POST_LONG_PRESS_SUPPRESS_MS;
    void identifyPoint(event.lngLat.lat, event.lngLat.lng);
  }

  function cancelPendingLongPress() {
    activeLongPressPointerId = null;
    if (pendingLongPressTimeout === null) {
      return;
    }

    window.clearTimeout(pendingLongPressTimeout);
    pendingLongPressTimeout = null;
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.pointerType !== 'touch' || !event.isPrimary) {
      return;
    }
    if ((event.target as HTMLElement | null)?.closest('.maplibregl-ctrl')) {
      return;
    }

    cancelPendingLongPress();
    activeLongPressPointerId = event.pointerId;
    longPressStartX = event.clientX;
    longPressStartY = event.clientY;
    pendingLongPressTimeout = window.setTimeout(() => {
      pendingLongPressTimeout = null;
      if (!map || activeLongPressPointerId !== event.pointerId) {
        return;
      }

      const bounds = containerRef.getBoundingClientRect();
      const point = [event.clientX - bounds.left, event.clientY - bounds.top] as [number, number];
      const lngLat = map.unproject(point);
      suppressMapClickUntil = performance.now() + IDENTIFY_POST_LONG_PRESS_SUPPRESS_MS;
      activeLongPressPointerId = null;
      void identifyPoint(lngLat.lat, lngLat.lng);
    }, IDENTIFY_LONG_PRESS_MS);
  }

  function handlePointerMove(event: PointerEvent) {
    if (event.pointerId !== activeLongPressPointerId) {
      return;
    }

    const dx = event.clientX - longPressStartX;
    const dy = event.clientY - longPressStartY;
    if (Math.hypot(dx, dy) > IDENTIFY_LONG_PRESS_MOVE_TOLERANCE_PX) {
      cancelPendingLongPress();
    }
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!identifyResult() && !identifyError() && !isIdentifying()) {
      return;
    }

    const target = event.target as Node | null;
    if (panelRef?.contains(target ?? null)) {
      return;
    }

    clearIdentify();
  }

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
    addressLookupAbort?.abort();
    const controller = new AbortController();
    const addressController = new AbortController();
    identifyAbort = controller;
    addressLookupAbort = addressController;

    identifyMarker?.remove();
    identifyMarker = new maplibregl.Marker({ color: '#2f6f88' }).setLngLat([lon, lat]).addTo(map);

    setIdentifyResult({
      lat,
      lon,
      radius_meters: identifyRadiusMeters(map.getZoom()),
      features: [],
    });
    setAddressResult(null);
    setAddressError(null);
    setIdentifyError(null);
    setIsIdentifying(true);
    setIsLookingUpAddress(true);

    const params = new URLSearchParams({
      lat: lat.toFixed(7),
      lon: lon.toFixed(7),
      radius_meters: identifyRadiusMeters(map.getZoom()).toFixed(0),
    });

    void lookupAddress(lat, lon, addressController);

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

  async function lookupAddress(lat: number, lon: number, controller: AbortController) {
    const params = new URLSearchParams({
      lat: lat.toFixed(7),
      lon: lon.toFixed(7),
    });

    try {
      const response = await fetch(`/address_lookup?${params}`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      setAddressResult((await response.json()) as AddressLookupResponse);
      setAddressError(null);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setAddressError(error instanceof Error ? error.message : 'Unable to look up address');
    } finally {
      if (addressLookupAbort === controller) {
        setIsLookingUpAddress(false);
      }
    }
  }

  function clearIdentify() {
    identifyAbort?.abort();
    addressLookupAbort?.abort();
    identifyAbort = null;
    addressLookupAbort = null;
    identifyMarker?.remove();
    identifyMarker = null;
    setIdentifyResult(null);
    setAddressResult(null);
    setAddressError(null);
    setIdentifyError(null);
    setIsIdentifying(false);
    setIsLookingUpAddress(false);
  }

  return (
    <>
      <div ref={containerRef} class="map" />
      <section class="searchControl" aria-label="Map search">
        <form class="searchForm" onSubmit={submitSearch}>
          <input
            value={searchQuery()}
            onInput={(event) => handleSearchInput(event.currentTarget.value)}
            onFocus={() => setIsSearchPanelOpen(searchQuery().trim().length >= SEARCH_MIN_QUERY_CHARS)}
            placeholder="Search places, POIs, transit"
            aria-label="Search map"
          />
          <Show when={searchQuery().trim().length > 0}>
            <button type="button" class="searchClearButton" onClick={clearSearch} aria-label="Clear search">
              Clear
            </button>
          </Show>
        </form>
        <Show when={isSearchPanelOpen()}>
          <div class="searchResults" role="listbox" aria-label="Search results">
            <Show when={isSearching()}>
              <p class="searchStatus">Searching</p>
            </Show>
            <Show when={searchError()}>
              {(error) => <p class="errorText">{error()}</p>}
            </Show>
            <Show
              when={!searchError() && searchResults().length > 0}
              fallback={
                <Show when={!isSearching() && !searchError() && searchQuery().trim().length >= SEARCH_MIN_QUERY_CHARS}>
                  <p class="emptyState searchEmpty">No results found.</p>
                </Show>
              }
            >
              <div class="searchList">
                <For each={searchResults()}>
                  {(result) => (
                    <button type="button" class="searchResult" onClick={() => selectSearchResult(result)}>
                      <span>
                        <strong>{result.name}</strong>
                        <small>{searchResultLabel(result)}</small>
                      </span>
                      <small>{formatSearchDistance(result.distance_meters)}</small>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </section>
      <section
        id="layer-control"
        class="layerControl"
        classList={{ open: isLayerPanelOpen() }}
        aria-label="Map layers"
      >
        <h2>Layers</h2>
        <div class="layerToggleList">
          <For each={MAP_LAYER_OPTIONS}>
            {(option) => (
              <label class="layerToggle">
                <input
                  type="checkbox"
                  checked={layerSettings()[option.key]}
                  onChange={() => toggleLayerSetting(option.key)}
                />
                <span>{option.label}</span>
              </label>
            )}
          </For>
        </div>
      </section>
      <Show when={mapError()}>{(error) => <div class="mapError">{error()}</div>}</Show>
      <Show when={identifyResult()}>
        {(result) => (
          <section ref={panelRef} class="identifyPanel" aria-label="Clicked point details">
            <div class="identifyHeader">
              <div>
                <h2>Point</h2>
                <p>{formatCoordinate(result().lat, result().lon)}</p>
                <Show when={addressResult()?.address}>
                  {(address) => <p class="identifyAddress">{address().formatted_address}</p>}
                </Show>
              </div>
              <button type="button" class="iconButton" onClick={clearIdentify}>
                Close
              </button>
            </div>

            <Show when={isIdentifying()}>
              <p class="identifyStatus">Looking up nearby map features</p>
            </Show>

            <Show when={isLookingUpAddress()}>
              <p class="identifyStatus">Looking up nearest address</p>
            </Show>

            <Show when={identifyError()}>
              {(error) => <p class="errorText">{error()}</p>}
            </Show>

            <Show when={addressError()}>
              {(error) => <p class="errorText">{error()}</p>}
            </Show>

            <Show
              when={!isIdentifying() && !identifyError() && result().features.length > 0}
              fallback={
                <Show when={!isIdentifying() && !identifyError() && !isLookingUpAddress()}>
                  <p class="emptyState">
                    <Show
                      when={addressResult()?.address}
                      fallback={`No mapped features found within ${formatMeters(result().radius_meters)}.`}
                    >
                      No mapped features found near this point.
                    </Show>
                  </p>
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
                        <Show when={poiTagItems(feature).length > 0}>
                          <dl class="poiTags">
                            <For each={poiTagItems(feature)}>
                              {(tag) => (
                                <div>
                                  <dt>{tag.label}</dt>
                                  <dd>{tag.value}</dd>
                                </div>
                              )}
                            </For>
                          </dl>
                        </Show>
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

function loadStoredMapLayerSettings(): MapLayerSettings {
  try {
    const rawValue = window.localStorage.getItem(MAP_LAYER_SETTINGS_STORAGE_KEY);
    if (!rawValue) {
      return DEFAULT_MAP_LAYER_SETTINGS;
    }

    const storedSettings = JSON.parse(rawValue) as Partial<MapLayerSettings>;
    return {
      transit: typeof storedSettings.transit === 'boolean' ? storedSettings.transit : true,
      walking: typeof storedSettings.walking === 'boolean' ? storedSettings.walking : true,
      cycling: typeof storedSettings.cycling === 'boolean' ? storedSettings.cycling : true,
      amenities: typeof storedSettings.amenities === 'boolean' ? storedSettings.amenities : true,
    };
  } catch {
    return DEFAULT_MAP_LAYER_SETTINGS;
  }
}

function saveStoredMapLayerSettings(settings: MapLayerSettings) {
  try {
    window.localStorage.setItem(MAP_LAYER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Browsers can reject localStorage writes in private mode or when storage is full.
  }
}

function applyMapLayerSettings(map: Map, settings: MapLayerSettings) {
  for (const option of MAP_LAYER_OPTIONS) {
    const visibility = settings[option.key] ? 'visible' : 'none';
    for (const layerId of OVERLAY_LAYER_GROUPS[option.key]) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', visibility);
      }
    }
  }
}

function addTransitStopIcons(map: Map) {
  if (!map.hasImage(TRAIN_STOP_ICON)) {
    map.addImage(TRAIN_STOP_ICON, createTransitStopIcon('#1d6f98', 'train'), { pixelRatio: 2 });
  }
  if (!map.hasImage(TRAM_STOP_ICON)) {
    map.addImage(TRAM_STOP_ICON, createTransitStopIcon('#217f7f', 'tram'), { pixelRatio: 2 });
  }
  if (!map.hasImage(BUS_STOP_ICON)) {
    map.addImage(BUS_STOP_ICON, createTransitStopIcon('#5d7d2f', 'bus'), { pixelRatio: 2 });
  }
}

function createTransitStopIcon(color: string, mode: 'train' | 'tram' | 'bus'): ImageData {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create transit stop icon');
  }

  context.clearRect(0, 0, size, size);
  context.fillStyle = color;
  context.beginPath();
  context.arc(24, 24, 20, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = '#ffffff';
  context.lineCap = 'round';
  context.lineJoin = 'round';

  if (mode === 'bus') {
    context.lineWidth = 4;
    context.beginPath();
    context.roundRect(15, 14, 18, 20, 4);
    context.stroke();

    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(18, 22);
    context.lineTo(30, 22);
    context.moveTo(19, 33);
    context.lineTo(19, 36);
    context.moveTo(29, 33);
    context.lineTo(29, 36);
    context.stroke();
  } else if (mode === 'tram') {
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(16, 16);
    context.lineTo(24, 12);
    context.lineTo(32, 16);
    context.stroke();

    context.lineWidth = 5;
    context.beginPath();
    context.moveTo(16, 23);
    context.lineTo(32, 23);
    context.moveTo(18, 31);
    context.lineTo(30, 31);
    context.stroke();
  } else {
    context.lineWidth = 5;
    context.beginPath();
    context.moveTo(17, 14);
    context.lineTo(31, 14);
    context.moveTo(17, 24);
    context.lineTo(31, 24);
    context.moveTo(18, 33);
    context.lineTo(30, 33);
    context.stroke();
  }

  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(18, 36);
  context.lineTo(14, 40);
  context.moveTo(30, 36);
  context.lineTo(34, 40);
  context.stroke();

  return context.getImageData(0, 0, size, size);
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

function searchResultLabel(result: SearchResult) {
  return [result.import_name, result.layer, result.source, result.class].filter(Boolean).join(' / ');
}

function formatSearchDistance(value: number | null) {
  if (value === null) {
    return '';
  }
  if (value < 1000) {
    return `${Math.round(value)} m`;
  }
  return `${Math.round(value / 1000)} km`;
}

type PoiTagItem = {
  key: string;
  label: string;
  value: string;
};

const POI_TAGS: Array<{ key: string; label: string }> = [
  { key: 'public_transport', label: 'Transit' },
  { key: 'railway', label: 'Railway' },
  { key: 'route_ref', label: 'Routes' },
  { key: 'network', label: 'Network' },
  { key: 'bus', label: 'Bus' },
  { key: 'train', label: 'Train' },
  { key: 'tram', label: 'Tram' },
  { key: 'cuisine', label: 'Cuisine' },
  { key: 'opening_hours', label: 'Hours' },
  { key: 'phone', label: 'Phone' },
  { key: 'contact:phone', label: 'Phone' },
  { key: 'website', label: 'Website' },
  { key: 'contact:website', label: 'Website' },
  { key: 'wheelchair', label: 'Wheelchair' },
  { key: 'internet_access', label: 'Internet' },
  { key: 'outdoor_seating', label: 'Outdoor seating' },
  { key: 'takeaway', label: 'Takeaway' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'drive_through', label: 'Drive-through' },
  { key: 'operator', label: 'Operator' },
  { key: 'brand', label: 'Brand' },
  { key: 'diet:vegetarian', label: 'Vegetarian' },
  { key: 'diet:vegan', label: 'Vegan' },
  { key: 'diet:halal', label: 'Halal' },
  { key: 'diet:kosher', label: 'Kosher' },
  { key: 'toilets', label: 'Toilets' },
  { key: 'fee', label: 'Fee' },
  { key: 'heritage', label: 'Heritage' },
  { key: 'start_date', label: 'Opened' },
];

function poiTagItems(feature: IdentifiedFeature): PoiTagItem[] {
  if (feature.layer !== 'poi') {
    return [];
  }

  const seenLabels = new Set<string>();
  const items: PoiTagItem[] = [];

  for (const tag of POI_TAGS) {
    const value = formatTagValue(feature.tags?.[tag.key]);
    if (!value || seenLabels.has(tag.label)) {
      continue;
    }
    seenLabels.add(tag.label);
    items.push({ ...tag, value });
  }

  return items.slice(0, 6);
}

function formatTagValue(value: unknown) {
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === 'yes') {
    return 'Yes';
  }
  if (trimmed === 'no') {
    return 'No';
  }
  if (trimmed === 'limited') {
    return 'Limited';
  }

  return trimmed.replace(/_/g, ' ');
}

function formatMeters(value: number) {
  if (value < 1) {
    return 'at point';
  }
  return `${Math.round(value)} m`;
}

const WALKING_TRACK_CLASSES = ['track', 'path', 'footway', 'pedestrian', 'bridleway'];
const DEDICATED_CYCLEWAY_VALUES = ['lane', 'opposite_lane', 'track', 'opposite_track', 'protected_lane', 'buffered_lane'];
const SHARED_CYCLEWAY_VALUES = ['shared_lane', 'share_busway', 'shoulder'];
const CYCLEWAY_VALUES = [...DEDICATED_CYCLEWAY_VALUES, ...SHARED_CYCLEWAY_VALUES];
const CYCLE_LANE_TAG_FILTER: maplibregl.ExpressionSpecification = [
  'all',
  ['!=', ['get', 'class'], 'cycleway'],
  [
    'any',
    ['in', ['get', 'cycleway'], ['literal', CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:left'], ['literal', CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:right'], ['literal', CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:both'], ['literal', CYCLEWAY_VALUES]],
  ],
];
const DEDICATED_CYCLE_LANE_FILTER: maplibregl.ExpressionSpecification = [
  'all',
  ['!=', ['get', 'class'], 'cycleway'],
  [
    'any',
    ['in', ['get', 'cycleway'], ['literal', DEDICATED_CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:left'], ['literal', DEDICATED_CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:right'], ['literal', DEDICATED_CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:both'], ['literal', DEDICATED_CYCLEWAY_VALUES]],
  ],
];
const SHARED_CYCLE_LANE_FILTER: maplibregl.ExpressionSpecification = [
  'all',
  ['!=', ['get', 'class'], 'cycleway'],
  ['!', DEDICATED_CYCLE_LANE_FILTER],
  [
    'any',
    ['in', ['get', 'cycleway'], ['literal', SHARED_CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:left'], ['literal', SHARED_CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:right'], ['literal', SHARED_CYCLEWAY_VALUES]],
    ['in', ['get', 'cycleway:both'], ['literal', SHARED_CYCLEWAY_VALUES]],
  ],
];
const CYCLE_LANE_FILTER: maplibregl.ExpressionSpecification = [
  'any',
  ['==', ['get', 'class'], 'cycleway'],
  CYCLE_LANE_TAG_FILTER,
];
const RAILWAY_CLASSES = ['rail', 'light_rail', 'subway', 'tram', 'monorail', 'narrow_gauge'];
const PHYSICAL_TRANSIT_TRACK_CLASSES = ['rail', 'light_rail', 'subway', 'tram', 'monorail', 'narrow_gauge'];
const TRAM_LINE_CLASSES = ['tram', 'light_rail'];
const SOLID_TRANSIT_ROUTE_CLASSES = ['train', 'tram', 'subway', 'light_rail'];
const RAILWAY_SERVICE_CLASSES = ['siding', 'yard', 'spur', 'crossover'];
const RAILWAY_FREIGHT_USAGE_CLASSES = ['industrial', 'military'];
const RAILWAY_RENDER_FILTER: maplibregl.ExpressionSpecification = [
  'all',
  ['in', ['get', 'class'], ['literal', PHYSICAL_TRANSIT_TRACK_CLASSES]],
  ['!', ['in', ['get', 'service'], ['literal', RAILWAY_SERVICE_CLASSES]]],
  ['!', ['in', ['get', 'usage'], ['literal', RAILWAY_FREIGHT_USAGE_CLASSES]]],
];
const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'service',
  'living_street',
];

const mapLayers: maplibregl.LayerSpecification[] = [
  {
    id: 'background',
    type: 'background',
    minzoom: 0,
    paint: { 'background-color': '#edf0e7' },
  },
  {
    id: 'water',
    type: 'fill',
    source: 'tileme',
    'source-layer': 'water',
    minzoom: 0,
    paint: {
      'fill-color': [
        'match',
        ['get', 'class'],
        'ocean',
        '#6ea8d8',
        'sea',
        '#79b2de',
        'bay',
        '#84b8df',
        'strait',
        '#88bcdf',
        'river',
        '#8ec2de',
        'riverbank',
        '#98c8df',
        'canal',
        '#91c0d7',
        'lake',
        '#8fb9d4',
        'reservoir',
        '#90bdd7',
        'pond',
        '#9bc6da',
        '#8fb9d4',
      ],
      'fill-opacity': 0.94,
    },
  },
  {
    id: 'landuse',
    type: 'fill',
    source: 'tileme',
    'source-layer': 'landuse',
    minzoom: 8,
    paint: {
      'fill-color': [
        'match',
        ['get', 'class'],
        'park',
        '#b8d99a',
        'grass',
        '#bfdc9a',
        'recreation_ground',
        '#bad59b',
        'nature_reserve',
        '#a8ca8f',
        'wood',
        '#95ba7f',
        'forest',
        '#8eb377',
        '#cdbfa1',
      ],
      'fill-opacity': ['match', ['get', 'class'], 'park', 0.72, 'grass', 0.68, 'wood', 0.78, 'forest', 0.8, 0.56],
    },
  },
  {
    id: 'boundaries',
    type: 'line',
    source: 'tileme',
    'source-layer': 'boundaries',
    minzoom: 0,
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
    filter: ['in', ['get', 'class'], ['literal', ROAD_CLASSES]],
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
    filter: ['in', ['get', 'class'], ['literal', ROAD_CLASSES]],
    paint: {
      'line-color': ['case', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]], '#f1b35f', '#fff8ea'],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.72, 10, 0.9, 14, 1],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.45, 10, 1.35, 14, 4.6],
    },
  },
  {
    id: 'railway-casing',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 9,
    filter: RAILWAY_RENDER_FILTER,
    paint: {
      'line-color': ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], '#75a98b', '#6f93b4'],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.4, 1.2],
        11,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.8, 2],
        14,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 1.5, 3.8],
        17,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 2.2, 5.8],
      ],
      'line-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.26, 0.5],
        11,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.42, 0.68],
        14,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.6, 0.86],
        17,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.72, 0.94],
      ],
    },
  },
  {
    id: 'railway-lines',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 9,
    filter: RAILWAY_RENDER_FILTER,
    paint: {
      'line-color': [
        'match',
        ['get', 'class'],
        'rail',
        '#2f7fbd',
        'tram',
        '#3e9c6f',
        'light_rail',
        '#3e9c6f',
        'subway',
        '#6f87b7',
        '#2f7fbd',
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.24, 0.7],
        11,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.5, 1.1],
        14,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 1, 2.2],
        17,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 1.5, 3.8],
      ],
      'line-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.38, 0.66],
        11,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.58, 0.82],
        14,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.78, 0.92],
        17,
        ['case', ['in', ['get', 'class'], ['literal', TRAM_LINE_CLASSES]], 0.9, 0.98],
      ],
    },
  },
  {
    id: 'transit-route-lines',
    type: 'line',
    source: 'tileme',
    'source-layer': 'transit_routes',
    minzoom: 9,
    filter: ['in', ['get', 'class'], ['literal', SOLID_TRANSIT_ROUTE_CLASSES]],
    paint: {
      'line-color': [
        'case',
        ['has', 'colour'],
        ['get', 'colour'],
        ['match', ['get', 'class'], 'tram', '#3e9c6f', 'light_rail', '#3e9c6f', 'subway', '#6f87b7', '#2f7fbd'],
      ],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.68, 11, 0.86, 14, 0.94, 17, 0.98],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['match', ['get', 'class'], 'tram', 0.55, 'light_rail', 0.55, 0.9],
        11,
        ['match', ['get', 'class'], 'tram', 1.2, 'light_rail', 1.2, 1.8],
        14,
        ['match', ['get', 'class'], 'tram', 2.6, 'light_rail', 2.6, 3.4],
        17,
        ['match', ['get', 'class'], 'tram', 4.2, 'light_rail', 4.2, 5.6],
      ],
    },
  },
  {
    id: 'transit-ferry-route-lines',
    type: 'line',
    source: 'tileme',
    'source-layer': 'transit_routes',
    minzoom: 11,
    filter: ['==', ['get', 'class'], 'ferry'],
    paint: {
      'line-color': ['case', ['has', 'colour'], ['get', 'colour'], '#2479a8'],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.66, 14, 0.82, 17, 0.9],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.9, 14, 1.8, 17, 3.2],
      'line-dasharray': [1.2, 1.2],
    },
  },
  {
    id: 'cycling-cycleway-casing',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 13,
    filter: ['==', ['get', 'class'], 'cycleway'],
    paint: {
      'line-color': '#f4fff7',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.72, 16, 0.9],
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.4, 16, 3.2, 18, 4.2],
    },
  },
  {
    id: 'cycling-cycleways',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 13,
    filter: ['==', ['get', 'class'], 'cycleway'],
    paint: {
      'line-color': '#2b9b72',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.76, 16, 0.96],
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.9, 16, 2.1, 18, 2.8],
    },
  },
  {
    id: 'cycling-dedicated-lane-casing',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 10,
    filter: DEDICATED_CYCLE_LANE_FILTER,
    paint: {
      'line-color': '#effff5',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.46, 11, 0.62, 13, 0.86, 16, 0.98],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 11, 3.4, 13, 6, 16, 10, 18, 12],
    },
  },
  {
    id: 'cycling-dedicated-lanes',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 10,
    filter: DEDICATED_CYCLE_LANE_FILTER,
    paint: {
      'line-color': '#169b6b',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.58, 11, 0.74, 13, 0.94, 16, 1],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 11, 2.2, 13, 4.2, 16, 7.2, 18, 9],
    },
  },
  {
    id: 'cycling-shared-lane-casing',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 10,
    filter: SHARED_CYCLE_LANE_FILTER,
    paint: {
      'line-color': '#effff5',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.42, 11, 0.58, 13, 0.84, 16, 0.96],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 11, 3.4, 13, 6, 16, 10, 18, 12],
      'line-dasharray': [1.6, 0.7],
    },
  },
  {
    id: 'cycling-shared-lanes',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 10,
    filter: SHARED_CYCLE_LANE_FILTER,
    paint: {
      'line-color': '#169b6b',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.54, 11, 0.7, 13, 0.92, 16, 0.98],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 11, 2.2, 13, 4.2, 16, 7.2, 18, 9],
      'line-dasharray': [1.6, 0.7],
    },
  },
  {
    id: 'walking-tracks',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 13,
    filter: ['in', ['get', 'class'], ['literal', WALKING_TRACK_CLASSES]],
    paint: {
      'line-color': ['match', ['get', 'class'], 'cycleway', '#3f8a8d', '#6c8f4f'],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.72, 16, 0.95],
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 16, 1.7, 18, 2.3],
      'line-dasharray': [1.2, 0.8],
    },
  },
  {
    id: 'walking-steps',
    type: 'line',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 13,
    filter: ['==', ['get', 'class'], 'steps'],
    paint: {
      'line-color': '#6c8f4f',
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.72, 16, 0.95],
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 16, 1.7, 18, 2.3],
      'line-dasharray': [0.4, 0.55],
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
    id: 'building-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'buildings',
    minzoom: 17,
    filter: ['any', ['has', 'house_number'], ['has', 'name']],
    layout: {
      'text-field': ['coalesce', ['get', 'house_number'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10, 18, 12],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#5f4938',
      'text-halo-color': '#fff6ea',
      'text-halo-width': 1,
    },
  },
  {
    id: 'address-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'addresses',
    minzoom: 16,
    filter: ['has', 'house_number'],
    layout: {
      'text-field': [
        'case',
        ['has', 'unit'],
        ['concat', ['get', 'unit'], '/', ['get', 'house_number']],
        ['get', 'house_number'],
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 16, 10, 18, 12],
      'text-anchor': 'center',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#6a5140',
      'text-halo-color': '#fff7ee',
      'text-halo-width': 1,
    },
  },
  {
    id: 'water-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'water',
    minzoom: 0,
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
    minzoom: 8,
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
    minzoom: 5,
    filter: ['in', ['get', 'class'], ['literal', ROAD_CLASSES]],
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
    id: 'walking-track-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 15,
    filter: ['all', ['has', 'name'], ['in', ['get', 'class'], ['literal', WALKING_TRACK_CLASSES]]],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 18, 11],
      'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 15, 240, 18, 190],
    },
    paint: {
      'text-color': '#4f6e40',
      'text-halo-color': '#f2f8e9',
      'text-halo-width': 1.1,
    },
  },
  {
    id: 'cycling-lane-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 15,
    filter: ['all', ['has', 'name'], CYCLE_LANE_FILTER],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 18, 11],
      'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 15, 240, 18, 190],
    },
    paint: {
      'text-color': '#287257',
      'text-halo-color': '#f4fff7',
      'text-halo-width': 1.1,
    },
  },
  {
    id: 'railway-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'roads',
    minzoom: 13,
    filter: ['all', ['has', 'name'], RAILWAY_RENDER_FILTER],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 18, 11],
      'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 13, 320, 18, 230],
    },
    paint: {
      'text-color': '#5f5361',
      'text-halo-color': '#faf4ea',
      'text-halo-width': 1.1,
    },
  },
  {
    id: 'transit-stop-markers',
    type: 'circle',
    source: 'tileme',
    'source-layer': 'pois',
    minzoom: 14,
    filter: RAIL_TRANSIT_STOP_FILTER,
    paint: {
      'circle-color': ['case', TRAM_TRANSIT_STOP_FILTER, '#217f7f', '#1d6f98'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4.5, 16, 6, 18, 7],
      'circle-stroke-color': '#fffdf5',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, 1.2, 18, 1.8],
    },
  },
  {
    id: 'transit-stop-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'transit_stop_labels',
    minzoom: 14,
    filter: RAIL_TRANSIT_STOP_FILTER,
    layout: {
      'icon-image': ['case', TRAM_TRANSIT_STOP_FILTER, TRAM_STOP_ICON, TRAIN_STOP_ICON],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.42, 18, 0.58],
      'icon-allow-overlap': false,
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 12, 18, 15],
      'text-anchor': 'top',
      'text-offset': [0, 1.2],
      'text-allow-overlap': false,
      'text-optional': true,
      'symbol-sort-key': 0,
    },
    paint: {
      'text-color': ['case', TRAM_TRANSIT_STOP_FILTER, '#17666a', '#165b80'],
      'text-halo-color': '#fffdf5',
      'text-halo-width': 1.35,
    },
  },
  {
    id: 'transit-platform-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'pois',
    minzoom: 17,
    filter: RAIL_TRANSIT_PLATFORM_FILTER,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 17, 9, 18, 10],
      'text-anchor': 'center',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'symbol-sort-key': 1,
    },
    paint: {
      'text-color': '#2d718f',
      'text-halo-color': '#fffdf5',
      'text-halo-width': 1,
    },
  },
  {
    id: 'bus-stop-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'pois',
    minzoom: 16,
    filter: BUS_TRANSIT_STOP_FILTER,
    layout: {
      'icon-image': BUS_STOP_ICON,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 16, 0.38, 18, 0.48],
      'icon-allow-overlap': false,
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 16, 9, 18, 11],
      'text-anchor': 'top',
      'text-offset': [0, 1.05],
      'text-allow-overlap': false,
      'text-optional': true,
      'symbol-sort-key': 1,
    },
    paint: {
      'text-color': '#516e28',
      'text-halo-color': '#fffdf5',
      'text-halo-width': 1.15,
    },
  },
  {
    id: 'transit-poi-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'pois',
    minzoom: 14,
    filter: [
      'all',
      ['==', ['get', 'source'], 'public_transport'],
      ['!', RAIL_TRANSIT_STOP_FILTER],
      ['!', RAIL_TRANSIT_PLATFORM_FILTER],
      ['!', BUS_TRANSIT_STOP_FILTER],
    ],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 18, 11],
      'text-anchor': 'top',
      'text-offset': [0, 0.6],
      'text-allow-overlap': false,
      'symbol-sort-key': 1,
    },
    paint: {
      'text-color': '#275e78',
      'text-halo-color': '#fffdf5',
      'text-halo-width': 1.1,
    },
  },
  {
    id: 'amenity-poi-labels',
    type: 'symbol',
    source: 'tileme',
    'source-layer': 'pois',
    minzoom: 15,
    filter: ['==', ['get', 'source'], 'amenity'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 18, 11],
      'text-anchor': 'top',
      'text-offset': [0, 0.6],
      'text-allow-overlap': false,
      'symbol-sort-key': 2,
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
    minzoom: 2,
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

function JobRow(props: {
  job: ImportJob;
  onCancel: (id: string) => Promise<void>;
  onRerun: (id: string) => Promise<void>;
  isRerunning: boolean;
}) {
  const canCancel = createMemo(() => props.job.state === 'queued' || props.job.state === 'running');
  const canRerun = createMemo(() => !canCancel());
  const message = createMemo(() => props.job.error_message ?? props.job.progress_message ?? props.job.log_tail);

  return (
    <article class="jobRow">
      <div class="jobTop">
        <span class={`stateBadge ${props.job.state}`}>{props.job.state}</span>
        <time>{formatDate(props.job.created_at)}</time>
      </div>
      <p class="importName">{props.job.import_name}</p>
      <p class="sourceValue" title={props.job.source_value}>
        {props.job.source_value}
      </p>
      <Show when={message()}>
        {(text) => <p class={props.job.error_message ? 'jobError' : 'jobMessage'}>{text()}</p>}
      </Show>
      <div class="jobActions">
        <span>{props.job.source_type === 'url' ? 'URL' : 'Path'}</span>
        <Show when={canRerun()}>
          <button
            type="button"
            onClick={() => void props.onRerun(props.job.id)}
            disabled={props.isRerunning}
          >
            {props.isRerunning ? 'Re-running' : 'Re-run'}
          </button>
        </Show>
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
