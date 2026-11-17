import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import base from '../../vitest.config';

export default defineConfig({
  ...base,
  root: resolve(import.meta.dirname, '../..'),
  test: {
    ...base.test,
    include: ['tests/repro/**/*.repro.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
