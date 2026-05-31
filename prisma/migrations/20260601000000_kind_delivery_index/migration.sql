-- Replace the (paused_at, blocked_at) index with one led by `kind` so the
-- daily "who is due" scan (kind IN (...) AND paused_at IS NULL AND
-- blocked_at IS NULL) and the channel lookup are served from the index.
DROP INDEX `subscribers_paused_at_blocked_at_idx` ON `subscribers`;

CREATE INDEX `subscribers_kind_paused_at_blocked_at_idx` ON `subscribers`(`kind`, `paused_at`, `blocked_at`);
