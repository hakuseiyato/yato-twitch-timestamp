// テストだけで使う binding の型 / Types of bindings that exist only in tests
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
