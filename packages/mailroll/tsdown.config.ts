import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/exports/node.ts',
    core: 'src/exports/core.ts',
    cli: 'src/platform/cli/main.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22.18',
  tsconfig: 'tsconfig.json',
  dts: true,
  sourcemap: false,
  clean: true,
  minify: false,
});
