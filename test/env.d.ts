declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

// The plugin types `env` as Cloudflare.Env, so the test-only binding is declared there too.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('@cloudflare/vitest-plugin').D1Migration[];
    DISABLE_QUEUE_CONSUMERS?: string;
    MEDIA_GRANT_SECRET?: string;
    TEST_FAKE_VECTORS?: string;
  }
}

declare module '*.jsonc?raw' {
  const content: string;
  export default content;
}
