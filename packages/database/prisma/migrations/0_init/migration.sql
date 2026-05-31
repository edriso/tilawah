-- CreateTable
CREATE TABLE `surahs` (
    `number` INTEGER NOT NULL,
    `nameAr` VARCHAR(64) NOT NULL,
    `nameEn` VARCHAR(64) NOT NULL,
    `revelation` VARCHAR(16) NOT NULL,
    `ayah_count` INTEGER NOT NULL,

    PRIMARY KEY (`number`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ayat` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `surah_number` INTEGER NOT NULL,
    `number_in_surah` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `page` INTEGER NOT NULL,
    `juz` INTEGER NOT NULL,

    INDEX `ayat_page_idx`(`page`),
    UNIQUE INDEX `ayat_surah_number_in_surah_key`(`surah_number`, `number_in_surah`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscribers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'user',
    `platform` VARCHAR(16) NOT NULL DEFAULT 'telegram',
    `chat_id` BIGINT NOT NULL,
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'Africa/Cairo',
    `delivery_hour` TINYINT NOT NULL DEFAULT 6,
    `delivery_minute` TINYINT NOT NULL DEFAULT 0,
    `active_days` INTEGER NOT NULL DEFAULT 127,
    `wird_size` INTEGER NOT NULL DEFAULT 1,
    `current_page` INTEGER NOT NULL DEFAULT 1,
    `paused_at` DATETIME(3) NULL,
    `blocked_at` DATETIME(3) NULL,
    `started_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `subscribers_paused_at_blocked_at_idx`(`paused_at`, `blocked_at`),
    UNIQUE INDEX `subscribers_platform_chat_key`(`platform`, `chat_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `delivery_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `subscriber_id` INTEGER NOT NULL,
    `scheduled_for` VARCHAR(10) NOT NULL,
    `start_page` INTEGER NOT NULL,
    `page_count` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'sent',
    `sent_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `delivery_logs_subscriber_id_created_at_idx`(`subscriber_id`, `created_at`),
    UNIQUE INDEX `delivery_logs_subscriber_date_key`(`subscriber_id`, `scheduled_for`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cron_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(64) NOT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `success` BOOLEAN NOT NULL DEFAULT false,
    `duration_ms` INTEGER NULL,
    `stats_json` TEXT NULL,
    `error_message` TEXT NULL,

    INDEX `cron_runs_name_started_at_idx`(`name`, `started_at` DESC),
    INDEX `cron_runs_started_at_idx`(`started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ayat` ADD CONSTRAINT `ayat_surah_number_fkey` FOREIGN KEY (`surah_number`) REFERENCES `surahs`(`number`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `delivery_logs` ADD CONSTRAINT `delivery_logs_subscriber_id_fkey` FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

