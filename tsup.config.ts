import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', webhooks: 'src/webhooks.ts', firehose: 'src/firehose.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  external: ['node:crypto'],
});
