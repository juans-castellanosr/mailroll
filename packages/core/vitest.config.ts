import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const dir = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: [{ find: /^@mailroll\/core(?=\?|$)/, replacement: resolve(dir, 'src/index.ts') }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
