import type { EmailAddress } from '@mailroll/core';
import type { ListStatus } from '../status/list-status';

export interface TableColumn {
  readonly header: string;
  readonly alignRight?: boolean;
}

export function renderTable(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): string[] {
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const format = (cells: readonly string[]): string =>
    columns
      .map((column, i) => {
        const value = cells[i] ?? '';
        const width = widths[i] ?? value.length;

        return column.alignRight === true ? value.padStart(width) : value.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return [format(columns.map((c) => c.header)), ...rows.map(format)].map((line) => `  ${line}`);
}

export function panelTitle(title: string): string {
  return `\n── ${title} ${'─'.repeat(Math.max(4, 60 - title.length))}`;
}

export function listLabel(list: ListStatus): string {
  return `${list.template.id} · ${list.dataFile}`;
}

export function ccLabel(list: ListStatus, cc: readonly EmailAddress[]): string {
  if (list.template.ccPolicy === 'forbidden') {
    return 'not allowed';
  }

  return cc.length > 0 ? cc.join(', ') : '—';
}
