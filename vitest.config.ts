import { defineConfig } from 'vitest/config';

/**
 * Vite does not yet recognise `node:sqlite` as a Node builtin, so it tries to
 * resolve it from node_modules and fails. Marking it external hands it straight to
 * Node's own loader.
 */
export default defineConfig({
  plugins: [
    {
      name: 'externalize-node-sqlite',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'node:sqlite' || id === 'sqlite') return { id: 'node:sqlite', external: true };
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Ingestion parses a 311-page PDF; the default 5s timeout is far too short.
    testTimeout: 60_000,
    hookTimeout: 300_000,
    // The tool layer is a single-writer SQLite process, so suites must not race.
    fileParallelism: false,
    pool: 'forks',
  },
});
