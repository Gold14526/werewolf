import { defineConfig } from '@neon/config/v1';

// Deploy into the account/project/branch selected by `neon link`.
// Database credentials are injected by Neon, never committed here.
export default defineConfig({
  functions: {
    werewolf: {
      name: 'Werewolf API',
      source: './neon/index.mjs',
      env: { ALLOWED_ORIGINS: 'https://gold14526.github.io' },
    },
  },
});
