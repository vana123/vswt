import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'node-pty'],
  sourcemap: dev,
  minify: !dev,
  logLevel: 'info'
};

if (watch) {
  const ctx = await context(extensionConfig);
  await ctx.watch();
  console.log('[esbuild] watching extension...');
} else {
  await build(extensionConfig);
}
