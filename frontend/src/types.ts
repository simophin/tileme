export type ImportState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ImportJob = {
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

export type ImportName = {
  name: string;
};

export type ImportNameMode = 'existing' | 'new';

export type ImportSourceKind = 'local_path' | 'url';

export type ApiError = {
  error?: string;
};

export type IdentifiedFeature = {
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

export type IdentifyResponse = {
  lat: number;
  lon: number;
  radius_meters: number;
  features: IdentifiedFeature[];
};

export type ResolvedAddress = {
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

export type AddressLookupResponse = {
  lat: number;
  lon: number;
  radius_meters: number;
  address: ResolvedAddress | null;
};

export type SearchResult = {
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

export type SearchResponse = {
  query: string;
  results: SearchResult[];
};

export type MapLayerKey = 'transit' | 'walking' | 'cycling' | 'amenities';

export type MapLayerSettings = Record<MapLayerKey, boolean>;

export type StoredMapView = {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

export type PoiTagItem = {
  key: string;
  label: string;
  value: string;
};
