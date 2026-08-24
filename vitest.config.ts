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
    env: {
      /**
       * The suite gets its own database and its own artifacts folder.
       *
       * It used to share the real ones, and that was not merely untidy: the suite
       * builds storyboards through the real tools, so every run left hundreds of
       * finished-looking artifacts in the production database. Once the flow began
       * offering a saved storyboard back instead of rebuilding it, those became
       * what a user was offered -- a subject's "already generated" storyboard was
       * a test fixture full of placeholder text. Isolation is the fix; deleting
       * afterwards is not, because a crashed or interrupted run never gets there.
       *
       * Both paths are gitignored and can be deleted at any time: everything in
       * them is rebuilt by the next run.
       */
      DB_PATH: './data/test/storyboard.db',
      ARTIFACT_DIR: './artifacts-test',

      /**
       * No Word round-trip in the suite.
       *
       * Resolving a document's fields means handing it to Word, which costs
       * seconds per render and rewrites the package as it saves. Both are wrong
       * here: the suite renders repeatedly, and it asserts the renderer's output
       * is byte-identical to the template's parts -- which is a property of what
       * the renderer wrote, before Word touched it. The refresh has its own test
       * that switches it back on.
       */
      REFRESH_FIELDS: 'false',
    },
  },
});
