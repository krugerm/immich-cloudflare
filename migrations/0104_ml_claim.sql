-- Phase 4: one ML job per asset at a time. A job claims the asset before calling the ML container and releases the
-- claim when it stamps ml_at or fails; a claim older than 5 minutes counts as abandoned (an evicted consumer).
ALTER TABLE assets ADD COLUMN ml_claim_at TEXT;
