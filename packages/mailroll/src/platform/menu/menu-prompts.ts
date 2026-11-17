export interface MenuChoice<V> {
  readonly name: string;
  readonly value: V;
  readonly description?: string;
  readonly disabled?: string;
}

export interface MenuCheckboxChoice<V> extends MenuChoice<V> {
  readonly checked?: boolean;
}

export interface MenuInputOptions {
  readonly default?: string;
  readonly validate: (value: string) => true | string;
}

export interface MenuPrompts {
  select<V>(message: string, choices: readonly MenuChoice<V>[], defaultValue?: V): Promise<V>;
  checkbox<V>(message: string, choices: readonly MenuCheckboxChoice<V>[]): Promise<V[]>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  input(message: string, options: MenuInputOptions): Promise<string>;
  print(lines: readonly string[]): void;
}
