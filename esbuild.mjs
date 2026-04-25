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

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview-ui/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: dev,
  minify: !dev,
  logLevel: 'info'
};

if (watch) {
  const ctxA = await context(extensionConfig);
  const ctxB = await context(webviewConfig);
  await Promise.all([ctxA.watch(), ctxB.watch()]);
  console.log('[esbuild] watching extension + webview...');
} else {
  await Promise.all([build(extensionConfig), build(webviewConfig)]);
}
