import { For, Show } from 'solid-js';
import { JobRow, StatusPill } from './JobRow';
import type {
  ImportJob,
  ImportName,
  ImportNameMode,
  ImportSourceKind,
} from '../types';

type ImportPanelProps = {
  open: boolean;
  panelRef: (element: HTMLElement) => void;
  activeJob: ImportJob | null;
  importNames: ImportName[];
  jobs: ImportJob[];
  jobsError: string | null;
  submitError: string | null;
  importNameMode: ImportNameMode;
  selectedImportName: string;
  newImportName: string;
  sourceKind: ImportSourceKind;
  sourceValue: string;
  isSubmitting: boolean;
  rerunningJobId: string | null;
  onClose: () => void;
  onSubmit: (event: SubmitEvent) => Promise<void>;
  onRefreshJobs: () => Promise<void>;
  onCancelJob: (id: string) => Promise<void>;
  onRerunJob: (id: string) => Promise<void>;
  onImportNameModeChange: (value: ImportNameMode) => void;
  onSelectedImportNameChange: (value: string) => void;
  onNewImportNameChange: (value: string) => void;
  onSourceKindChange: (value: ImportSourceKind) => void;
  onSourceValueChange: (value: string) => void;
};

export function ImportPanel(props: ImportPanelProps) {
  return (
    <aside
      ref={props.panelRef}
      id="import-panel"
      class="sidePanel"
      classList={{ open: props.open }}
      aria-label="Import controls"
    >
      <div class="brand">
        <h1>tileme</h1>
        <div class="brandActions">
          <StatusPill job={props.activeJob} />
          <button class="iconButton" type="button" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>

      <form class="importForm" onSubmit={(event) => void props.onSubmit(event)}>
        <div class="segmented" role="radiogroup" aria-label="Import name mode">
          <button
            type="button"
            classList={{ selected: props.importNameMode === 'existing' }}
            onClick={() => props.onImportNameModeChange('existing')}
            disabled={props.importNames.length === 0}
          >
            Existing
          </button>
          <button
            type="button"
            classList={{ selected: props.importNameMode === 'new' }}
            onClick={() => props.onImportNameModeChange('new')}
          >
            New
          </button>
        </div>

        <Show
          when={props.importNameMode === 'existing' && props.importNames.length > 0}
          fallback={
            <label class="field">
              <span>Import name</span>
              <input
                value={props.newImportName}
                onInput={(event) => props.onNewImportNameChange(event.currentTarget.value)}
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
              value={props.selectedImportName}
              onInput={(event) => props.onSelectedImportNameChange(event.currentTarget.value)}
              required
            >
              <For each={props.importNames}>
                {(name) => <option value={name.name}>{name.name}</option>}
              </For>
            </select>
          </label>
        </Show>

        <div class="segmented" role="radiogroup" aria-label="Import source type">
          <button
            type="button"
            classList={{ selected: props.sourceKind === 'local_path' }}
            onClick={() => props.onSourceKindChange('local_path')}
          >
            File path
          </button>
          <button
            type="button"
            classList={{ selected: props.sourceKind === 'url' }}
            onClick={() => props.onSourceKindChange('url')}
          >
            URL
          </button>
        </div>

        <label class="field">
          <span>{props.sourceKind === 'url' ? 'OSM PBF URL' : 'Server file path'}</span>
          <input
            value={props.sourceValue}
            onInput={(event) => props.onSourceValueChange(event.currentTarget.value)}
            placeholder={
              props.sourceKind === 'url'
                ? 'https://download.geofabrik.de/.../latest.osm.pbf'
                : '/data/osm/australia-latest.osm.pbf'
            }
            required
          />
        </label>

        <Show when={props.submitError}>
          {(error) => <p class="errorText">{error()}</p>}
        </Show>

        <button class="primaryButton" type="submit" disabled={props.isSubmitting}>
          {props.isSubmitting ? 'Starting import' : 'Start import'}
        </button>
      </form>

      <div class="jobsHeader">
        <h2>Import jobs</h2>
        <button type="button" onClick={() => void props.onRefreshJobs()}>
          Refresh
        </button>
      </div>

      <Show when={props.jobsError}>
        {(error) => <p class="errorText">{error()}</p>}
      </Show>

      <div class="jobList">
        <Show
          when={props.jobs.length > 0}
          fallback={<p class="emptyState">No imports yet.</p>}
        >
          <For each={props.jobs}>
            {(job) => (
              <JobRow
                job={job}
                onCancel={props.onCancelJob}
                onRerun={props.onRerunJob}
                isRerunning={props.rerunningJobId === job.id}
              />
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
}
