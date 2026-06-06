-- Daily page recitation: after the wird, send an audio of each page.

-- AlterTable: per-subscriber on/off (default on) and the chosen reciter key
-- (default Abdul Basit murattal). See src/core/reciter.ts for the keys.
ALTER TABLE `subscribers`
    ADD COLUMN `wird_audio_enabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `reciter` VARCHAR(16) NOT NULL DEFAULT 'abdulbasit';

-- CreateTable: cache of the Telegram file_id for each page+reciter recitation
-- clip, so a clip is fetched from the source once and then re-sent by reference.
CREATE TABLE `page_audio` (
    `page` INTEGER NOT NULL,
    `reciter` VARCHAR(16) NOT NULL,
    `file_id` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`page`, `reciter`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
