-- DropForeignKey
ALTER TABLE `ayat` DROP FOREIGN KEY `ayat_surah_number_fkey`;

-- DropIndex
DROP INDEX `ayat_page_idx` ON `ayat`;

-- DropIndex
DROP INDEX `ayat_surah_number_in_surah_key` ON `ayat`;

-- AlterTable
ALTER TABLE `ayat` ADD COLUMN `riwayah` VARCHAR(32) NOT NULL DEFAULT 'hafs';

-- AlterTable
ALTER TABLE `mushaf_page_images` DROP PRIMARY KEY,
    ADD COLUMN `riwayah` VARCHAR(32) NOT NULL DEFAULT 'hafs',
    ADD PRIMARY KEY (`riwayah`, `page`);

-- AlterTable
ALTER TABLE `page_audio` DROP PRIMARY KEY,
    ADD COLUMN `riwayah` VARCHAR(32) NOT NULL DEFAULT 'hafs',
    ADD PRIMARY KEY (`riwayah`, `page`, `reciter`);

-- AlterTable
ALTER TABLE `subscribers` ADD COLUMN `riwayah` VARCHAR(32) NOT NULL DEFAULT 'hafs';

-- CreateIndex
CREATE INDEX `ayat_riwayah_page_idx` ON `ayat`(`riwayah`, `page`);

-- CreateIndex
CREATE UNIQUE INDEX `ayat_riwayah_surah_ayah_key` ON `ayat`(`riwayah`, `surah_number`, `number_in_surah`);

-- AddForeignKey
ALTER TABLE `ayat` ADD CONSTRAINT `ayat_surah_number_fkey` FOREIGN KEY (`surah_number`) REFERENCES `surahs`(`number`) ON DELETE RESTRICT ON UPDATE CASCADE;
