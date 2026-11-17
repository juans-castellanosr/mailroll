import type { MenuPrompts } from './menu-prompts';

export class Breadcrumb {
  private readonly entries = new Map<string, string>();

  constructor(private readonly prompts: MenuPrompts) {}

  set(label: string, value: string): void {
    this.entries.set(label, value);
  }

  auto(label: string, value: string, why: string): void {
    this.set(label, value);
    this.prompts.print([`✔ ${label}: ${value} — ${why}`]);
  }

  show(): void {
    if (this.entries.size === 0) {
      return;
    }

    const parts = [...this.entries].map(([label, value]) => `${label}: ${value}`);

    this.prompts.print(['', `» ${parts.join('  ·  ')}`]);
  }
}
