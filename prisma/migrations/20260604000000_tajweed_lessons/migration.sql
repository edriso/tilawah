-- Daily tajweed lesson, posted right before the wird.

-- AlterTable: per-subscriber toggle (on by default) and the 0-based cycle
-- position into the seeded lesson deck (advances by one per lesson, wraps to 0).
ALTER TABLE `subscribers`
    ADD COLUMN `tajweed_enabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `tajweed_lesson_index` INTEGER NOT NULL DEFAULT 0;

-- CreateTable: cache of the Telegram file_id for each per-ayah tajweed example
-- audio clip, so a clip is uploaded from the source once and then re-sent by
-- reference. Keyed by the (surah, ayah) the clip recites.
CREATE TABLE `tajweed_audio` (
    `surah_number` INTEGER NOT NULL,
    `number_in_surah` INTEGER NOT NULL,
    `file_id` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`surah_number`, `number_in_surah`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
