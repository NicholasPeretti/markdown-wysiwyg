import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Extension host bundle (Node). */
const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
});

/** Webview bundle (browser). CSS imports are emitted to dist/webview.css. */
const webviewCtx = await esbuild.context({
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/webview.js',
  sourcemap: !production,
  minify: production,
  loader: {
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
  },
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log('watching...');
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}
