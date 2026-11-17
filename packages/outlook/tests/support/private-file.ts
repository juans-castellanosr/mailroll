import { statSync } from 'node:fs';
import { expect } from 'vitest';

export function expectPrivateFile(path: string): void {
  const mode = statSync(path).mode & 0o777;

  if (process.platform === 'win32') {
    expect(
      mode,
      `${path} on win32, where only the read-only attribute exists and privacy comes from the folder ACL`,
    ).toBe(0o666);
  } else {
    expect(mode, `${path} on ${process.platform}`).toBe(0o600);
  }
}
