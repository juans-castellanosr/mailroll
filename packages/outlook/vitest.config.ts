import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const dir = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mailroll\/core(?=\?|$)/, replacement: resolve(dir, '../core/src/index.ts') },
      { find: /^mailroll$/, replacement: resolve(dir, '../mailroll/src/exports/node.ts') },
      { find: /^@mailroll\/outlook$/, replacement: resolve(dir, 'src/index.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
