import type { CcPrompts } from '../../../src/platform/cli/cc';
import type {
  MenuCheckboxChoice,
  MenuChoice,
  MenuInputOptions,
  MenuPrompts,
} from '../../../src/platform/menu/menu-prompts';

export type PromptCall =
  | {
      readonly kind: 'select';
      readonly message: string;
      readonly choices: readonly MenuChoice<unknown>[];
      readonly defaultValue: unknown;
    }
  | { readonly kind: 'checkbox'; readonly message: string; readonly choices: readonly MenuCheckboxChoice<unknown>[] }
  | { readonly kind: 'confirm'; readonly message: string; readonly defaultValue: boolean }
  | { readonly kind: 'input'; readonly message: string; readonly options: MenuInputOptions };

export type Answer = (call: PromptCall) => unknown;

export class ScriptedPrompts implements MenuPrompts {
  readonly calls: PromptCall[] = [];
  readonly printed: string[] = [];

  constructor(private readonly script: Answer[]) {}

  get remaining(): number {
    return this.script.length;
  }

  select<V>(message: string, choices: readonly MenuChoice<V>[], defaultValue?: V): Promise<V> {
    return this.answer<V>({ kind: 'select', message, choices, defaultValue });
  }

  checkbox<V>(message: string, choices: readonly MenuCheckboxChoice<V>[]): Promise<V[]> {
    return this.answer<V[]>({ kind: 'checkbox', message, choices });
  }

  confirm(message: string, defaultValue: boolean): Promise<boolean> {
    return this.answer<boolean>({ kind: 'confirm', message, defaultValue });
  }

  input(message: string, options: MenuInputOptions): Promise<string> {
    return this.answer<string>({ kind: 'input', message, options });
  }

  print(lines: readonly string[]): void {
    this.printed.push(...lines);
  }

  private answer<T>(call: PromptCall): Promise<T> {
    this.calls.push(call);
    const next = this.script.shift();

    if (next === undefined) {
      throw new Error(`unexpected prompt (script exhausted): ${call.kind} "${call.message}"`);
    }

    return Promise.resolve(next(call) as T);
  }
}

function expectKind<K extends PromptCall['kind']>(call: PromptCall, kind: K): Extract<PromptCall, { kind: K }> {
  if (call.kind !== kind) {
    throw new Error(`expected a ${kind} prompt, got ${call.kind} "${call.message}"`);
  }

  return call as Extract<PromptCall, { kind: K }>;
}

export const choose =
  (text: string): Answer =>
  (call) => {
    const select = expectKind(call, 'select');
    const match = select.choices.find((c) => c.name.includes(text));

    if (match === undefined) {
      throw new Error(
        `no choice containing "${text}" in "${select.message}": ${select.choices.map((c) => c.name).join(' | ')}`,
      );
    }

    if (match.disabled !== undefined) {
      throw new Error(`choice "${match.name}" is disabled: ${match.disabled}`);
    }

    return match.value;
  };

export const tick =
  (...texts: string[]): Answer =>
  (call) =>
    expectKind(call, 'checkbox')
      .choices.filter((c) => texts.some((t) => c.name.includes(t)))
      .map((c) => c.value);

export const keepTicks: Answer = (call) =>
  expectKind(call, 'checkbox')
    .choices.filter((c) => c.checked === true)
    .map((c) => c.value);

export const answerConfirm =
  (value: boolean): Answer =>
  (call) => {
    expectKind(call, 'confirm');

    return value;
  };

export const type =
  (value: string): Answer =>
  (call) => {
    const input = expectKind(call, 'input');
    const verdict = input.options.validate(value);

    if (verdict !== true) {
      throw new Error(`input "${value}" rejected: ${verdict}`);
    }

    return value;
  };

export const inspect =
  (check: (call: PromptCall) => void, then: Answer): Answer =>
  (call) => {
    check(call);

    return then(call);
  };

export function stubCcPrompts(picked: readonly string[], typed: string): CcPrompts & { readonly seen: string[][] } {
  const seen: string[][] = [];

  return {
    seen,
    pickFromList: (choices, checked) => {
      seen.push([...choices], [...checked]);

      return Promise.resolve(picked);
    },
    addNew: () => Promise.resolve(typed),
  };
}
