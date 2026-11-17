import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  fixedExtension: true,
  target: 'node22.18',
  tsconfig: 'tsconfig.json',
  dts: true,
  sourcemap: false,
  clean: true,
  minify: false,
});
