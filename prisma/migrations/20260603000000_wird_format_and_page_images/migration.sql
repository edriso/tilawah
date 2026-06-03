-- Delivery format: a subscriber receives each daily page as a picture of the
-- Madani Mushaf page (the default) or as plain text.

-- AlterTable: how this subscriber's wird is delivered ("image" | "text").
-- Defaults to "image"; without a page-image source configured the bot falls
-- back to text at send time, so this is safe even before a source is set.
ALTER TABLE `subscribers` ADD COLUMN `wird_format` VARCHAR(16) NOT NULL DEFAULT 'image';

-- CreateTable: cache of the Telegram file_id for each Mushaf page, so an image
-- page is uploaded from the source once and then re-sent by reference.
CREATE TABLE `mushaf_page_images` (
    `page` INTEGER NOT NULL,
    `file_id` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`page`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
