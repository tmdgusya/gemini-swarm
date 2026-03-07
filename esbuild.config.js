import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  minify: false,
  // Mark node: built-ins as external (they're always available)
  external: ['node:*'],
  banner: {
    // createRequire needed for any CJS dependencies that esbuild can't statically resolve
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
};

await Promise.all([
  // MCP server (entry point for gemini extension)
  build({
    ...shared,
    entryPoints: ['src/server.ts'],
    outfile: 'dist/server.js',
  }),
  // Coordination HTTP server (spawned as separate process)
  build({
    ...shared,
    entryPoints: ['src/coord-server.ts'],
    outfile: 'dist/coord-server.js',
  }),
]);

console.log('Build complete: dist/server.js, dist/coord-server.js');
