import { Show, createMemo } from 'solid-js';
import type { ImportJob } from '../types';
import { formatDate } from '../utils/formatters';

type JobRowProps = {
  job: ImportJob;
  onCancel: (id: string) => Promise<void>;
  onRerun: (id: string) => Promise<void>;
  isRerunning: boolean;
};

export function JobRow(props: JobRowProps) {
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

export function StatusPill(props: { job: ImportJob | null }) {
  return (
    <Show
      when={props.job}
      fallback={<span class="statusPill idle">Idle</span>}
    >
      {(job) => <span class={`statusPill ${job().state}`}>{job().state}</span>}
    </Show>
  );
}
