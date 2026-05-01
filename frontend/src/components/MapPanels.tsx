import { For, Show } from 'solid-js';
import type {
  AddressLookupResponse,
  IdentifyResponse,
  IdentifiedFeature,
  MapLayerKey,
  MapLayerSettings,
  SearchResult,
} from '../types';
import {
  featureLabel,
  formatCoordinate,
  formatMeters,
  formatSearchDistance,
  poiTagItems,
  searchResultLabel,
} from '../utils/formatters';

type SearchControlProps = {
  query: string;
  results: SearchResult[];
  error: string | null;
  isSearching: boolean;
  isOpen: boolean;
  onSubmit: (event: SubmitEvent) => Promise<void>;
  onInput: (value: string) => void;
  onFocus: () => void;
  onClear: () => void;
  onSelectResult: (result: SearchResult) => void;
  minQueryChars: number;
};

export function SearchControl(props: SearchControlProps) {
  return (
    <section class="searchControl" aria-label="Map search">
      <form class="searchForm" onSubmit={(event) => void props.onSubmit(event)}>
        <input
          value={props.query}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          onFocus={props.onFocus}
          placeholder="Search places, POIs, transit"
          aria-label="Search map"
        />
        <Show when={props.query.trim().length > 0}>
          <button type="button" class="searchClearButton" onClick={props.onClear} aria-label="Clear search">
            Clear
          </button>
        </Show>
      </form>
      <Show when={props.isOpen}>
        <div class="searchResults" role="listbox" aria-label="Search results">
          <Show when={props.isSearching}>
            <p class="searchStatus">Searching</p>
          </Show>
          <Show when={props.error}>
            {(error) => <p class="errorText">{error()}</p>}
          </Show>
          <Show
            when={!props.error && props.results.length > 0}
            fallback={
              <Show when={!props.isSearching && !props.error && props.query.trim().length >= props.minQueryChars}>
                <p class="emptyState searchEmpty">No results found.</p>
              </Show>
            }
          >
            <div class="searchList">
              <For each={props.results}>
                {(result) => (
                  <button type="button" class="searchResult" onClick={() => props.onSelectResult(result)}>
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
  );
}

type LayerPanelProps = {
  open: boolean;
  panelRef: (element: HTMLElement) => void;
  settings: MapLayerSettings;
  options: Array<{ key: MapLayerKey; label: string }>;
  onToggle: (key: MapLayerKey) => void;
};

export function LayerPanel(props: LayerPanelProps) {
  return (
    <section
      ref={props.panelRef}
      id="layer-control"
      class="layerControl"
      classList={{ open: props.open }}
      aria-label="Map layers"
    >
      <h2>Layers</h2>
      <div class="layerToggleList">
        <For each={props.options}>
          {(option) => (
            <label class="layerToggle">
              <input
                type="checkbox"
                checked={props.settings[option.key]}
                onChange={() => props.onToggle(option.key)}
              />
              <span>{option.label}</span>
            </label>
          )}
        </For>
      </div>
    </section>
  );
}

type IdentifyPanelProps = {
  result: IdentifyResponse | null;
  addressResult: AddressLookupResponse | null;
  identifyError: string | null;
  addressError: string | null;
  isIdentifying: boolean;
  isLookingUpAddress: boolean;
  panelRef: (element: HTMLElement) => void;
  onClose: () => void;
};

export function IdentifyPanel(props: IdentifyPanelProps) {
  return (
    <Show when={props.result}>
      {(result) => (
        <section ref={props.panelRef} class="identifyPanel" aria-label="Clicked point details">
          <div class="identifyHeader">
            <div>
              <h2>Point</h2>
              <p>{formatCoordinate(result().lat, result().lon)}</p>
              <Show when={props.addressResult?.address}>
                {(address) => <p class="identifyAddress">{address().formatted_address}</p>}
              </Show>
            </div>
            <button type="button" class="iconButton" onClick={props.onClose}>
              Close
            </button>
          </div>

          <Show when={props.isIdentifying}>
            <p class="identifyStatus">Looking up nearby map features</p>
          </Show>

          <Show when={props.isLookingUpAddress}>
            <p class="identifyStatus">Looking up nearest address</p>
          </Show>

          <Show when={props.identifyError}>
            {(error) => <p class="errorText">{error()}</p>}
          </Show>

          <Show when={props.addressError}>
            {(error) => <p class="errorText">{error()}</p>}
          </Show>

          <Show
            when={!props.isIdentifying && !props.identifyError && result().features.length > 0}
            fallback={
              <Show when={!props.isIdentifying && !props.identifyError && !props.isLookingUpAddress}>
                <p class="emptyState">
                  <Show
                    when={props.addressResult?.address}
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
                {(feature) => <IdentifyFeatureCard feature={feature} />}
              </For>
            </div>
          </Show>
        </section>
      )}
    </Show>
  );
}

function IdentifyFeatureCard(props: { feature: IdentifiedFeature }) {
  return (
    <article class="identifyItem">
      <div>
        <strong>{props.feature.name}</strong>
        <span>{featureLabel(props.feature)}</span>
        <Show when={poiTagItems(props.feature).length > 0}>
          <dl class="poiTags">
            <For each={poiTagItems(props.feature)}>
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
      <small>{formatMeters(props.feature.distance_meters)}</small>
    </article>
  );
}
