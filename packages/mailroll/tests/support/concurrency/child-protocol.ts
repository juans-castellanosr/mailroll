export type ChildJob =
  | {
      readonly kind: 'sdk';
      readonly statePath: string;
      readonly emails: readonly string[];
      readonly ledgerPath: string;
      readonly run: string;
      readonly lock: boolean;
    }
  | {
      readonly kind: 'cli';
      readonly campaigns: string;
      readonly cwd: string;
      readonly ledgerPath: string;
      readonly run: string;
    }
  | { readonly kind: 'lock-and-exit'; readonly lockPath: string }
  | { readonly kind: 'lock-and-hold'; readonly lockPath: string };

export interface ChildDone {
  readonly type: 'done';
  readonly ok: boolean;
  readonly detail: string;
}

export type ChildMessage =
  { readonly type: 'at-send'; readonly to: string } | { readonly type: 'locked'; readonly pid: number } | ChildDone;

export interface ParentMessage {
  readonly type: 'go';
  readonly to: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseChildMessage(value: unknown): ChildMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value['type'] === 'at-send' && typeof value['to'] === 'string') {
    return { type: 'at-send', to: value['to'] };
  }

  if (value['type'] === 'locked' && typeof value['pid'] === 'number') {
    return { type: 'locked', pid: value['pid'] };
  }

  if (value['type'] === 'done' && typeof value['ok'] === 'boolean' && typeof value['detail'] === 'string') {
    return { type: 'done', ok: value['ok'], detail: value['detail'] };
  }

  return undefined;
}

export function parseParentMessage(value: unknown): ParentMessage | undefined {
  return isRecord(value) && value['type'] === 'go' && typeof value['to'] === 'string'
    ? { type: 'go', to: value['to'] }
    : undefined;
}

export function parseChildJob(raw: string | undefined): ChildJob {
  const value: unknown = JSON.parse(raw ?? 'null');

  if (!isRecord(value)) {
    throw new Error('child job: not an object');
  }

  const text = (name: string): string => {
    const field = value[name];

    if (typeof field !== 'string') {
      throw new Error(`child job: ${name} must be text`);
    }

    return field;
  };

  switch (value['kind']) {
    case 'sdk': {
      const emails = value['emails'];

      if (!Array.isArray(emails) || !emails.every((email): email is string => typeof email === 'string')) {
        throw new Error('child job: emails must be a list of text');
      }

      return {
        kind: 'sdk',
        statePath: text('statePath'),
        emails,
        ledgerPath: text('ledgerPath'),
        run: text('run'),
        lock: value['lock'] === true,
      };
    }

    case 'cli':
      return {
        kind: 'cli',
        campaigns: text('campaigns'),
        cwd: text('cwd'),
        ledgerPath: text('ledgerPath'),
        run: text('run'),
      };
    case 'lock-and-exit':
      return { kind: 'lock-and-exit', lockPath: text('lockPath') };
    case 'lock-and-hold':
      return { kind: 'lock-and-hold', lockPath: text('lockPath') };
    default:
      throw new Error('child job: unknown kind');
  }
}
