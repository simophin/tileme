import type {
  ApiError,
  IdentifiedFeature,
  PoiTagItem,
  SearchResult,
} from '../types';

export function formatCoordinate(lat: number, lon: number) {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

export function featureLabel(feature: IdentifiedFeature) {
  return [feature.layer, feature.source, feature.class].filter(Boolean).join(' / ');
}

export function searchResultLabel(result: SearchResult) {
  return [result.import_name, result.layer, result.source, result.class].filter(Boolean).join(' / ');
}

export function formatSearchDistance(value: number | null) {
  if (value === null) {
    return '';
  }
  if (value < 1000) {
    return `${Math.round(value)} m`;
  }
  return `${Math.round(value / 1000)} km`;
}

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

export function poiTagItems(feature: IdentifiedFeature): PoiTagItem[] {
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

export function formatMeters(value: number) {
  if (value < 1) {
    return 'at point';
  }
  return `${Math.round(value)} m`;
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export async function readApiError(response: Response) {
  try {
    const body = (await response.json()) as ApiError;
    return body.error ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}
