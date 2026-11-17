import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/main.ts',
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
