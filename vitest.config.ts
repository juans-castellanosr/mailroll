import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      {
        test: {
          name: 'repository',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          globals: false,
        },
      },
    ],
  },
});
