interface Env {
  DISABLE_QUEUE_CONSUMERS?: string;
  /** Secret (wrangler secret put) that signs the media container's per-job R2 grants. */
  MEDIA_GRANT_SECRET?: string;
  /** Tests only: vectorStore() returns an in-memory fake instead of Vectorize. */
  TEST_FAKE_VECTORS?: string;
  /** Secret (wrangler secret put) for Resend's HTTP API, which sends password reset email. Unset: no email is sent. */
  RESEND_API_KEY?: string;
}
