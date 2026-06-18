-- The daily tajweed lesson is now OFF by default: a reader opts in with
-- /tajweed on (the channel admin with /admin_tajweed on). Only the column
-- DEFAULT changes; existing rows keep whatever they were set to.
ALTER TABLE `subscribers`
    MODIFY `tajweed_enabled` BOOLEAN NOT NULL DEFAULT false;
