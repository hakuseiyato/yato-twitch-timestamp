// Worker のテストを workerd 上で動かす設定（D1 / R2 は Miniflare のローカル実装）
// Runs Worker tests inside workerd (D1 / R2 are Miniflare's local implementations)
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // テスト専用の binding。setup.ts で D1 に流す / Test-only binding, applied to D1 in setup.ts
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
