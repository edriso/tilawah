-- Read-gated wird: a user's position advances only when they CONFIRM a read.

-- AlterTable: when the reader confirmed this day's wird (tapped "read" or ran
-- /next). Null until confirmed. The wird repeats each day until it is set, and
-- the count of unconfirmed "sent" rows before today is the "days not read"
-- number. The channel auto-advances on send and is not gated by this.
ALTER TABLE `delivery_logs`
    ADD COLUMN `confirmed_at` DATETIME(3) NULL;
