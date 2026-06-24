import cron, { type ScheduledTask } from 'node-cron';
import type { Bot, Context } from 'grammy';
import { deliverDueSubscribers, type DeliveryStats } from './lib/deliver';
import { sweepPending } from './lib/pending';
import { logger } from './lib/logger';

const tasks: ScheduledTask[] = [];

// In-process lock so two delivery BATCHES never overlap. A batch that takes
// longer than a minute would otherwise let the next cron tick (or the startup
// catch-up) start a second batch, and both could send to the same subscriber
// before either records the delivery. The per-day unique index stops a double
// RECORD/advance; this guard stops a double SEND between batches. (Assumes a
// single bot process; horizontal scaling would need a database lock instead.)
//
// Note: /today is a second, interactive sender that runs OUTSIDE this lock (it
// claims today's delivery when a user reads their wird early). The unique index
// still prevents any double record/advance (and the position never moves twice),
// so the only residual race is a user running /today in the exact sub-second
// their scheduled send fires. Both paths read hasDeliveryFor (a check, not a
// claim) before sending, so that race can duplicate the VISIBLE payload — the
// nudge, the lesson, the wird pages, and the recitation — even though only one
// of them records the day and advances. Benign and near-impossible; a fuller fix
// would need a per-subscriber mutex, not worth it under the single-process model.
let deliveryRunning = false;

/**
 * Run one delivery batch, unless another one is already in progress. Used by
 * both the cron tick and the startup catch-up. Returns null when skipped
 * because a run was already active.
 */
export async function runDeliveryOnce(
  bot: Bot<Context>,
  now: Date = new Date(),
): Promise<DeliveryStats | null> {
  if (deliveryRunning) {
    logger.debug('Delivery already running, skipping this trigger');
    return null;
  }
  deliveryRunning = true;
  try {
    return await deliverDueSubscribers(bot, now);
  } finally {
    deliveryRunning = false;
  }
}

/**
 * Start the recurring jobs:
 *   - Delivery tick, every minute. Each subscriber is judged in their own
 *     timezone, so one global minute-tick serves every timezone correctly.
 *     The (subscriber, local date) record keeps it to one wird per day.
 *   - Pending-input sweep, every few minutes, so abandoned /page and /wird
 *     prompts never leak memory.
 *
 * Errors inside a job are caught so a single bad run never kills the loop.
 */
export function startScheduler(bot: Bot<Context>): void {
  const tick = cron.schedule('* * * * *', () => {
    runDeliveryOnce(bot)
      .then((stats) => {
        if (stats && stats.due > 0) logger.info('Delivery tick', { ...stats });
      })
      .catch((err) => logger.error('Delivery tick failed', { error: String(err) }));
  });

  // Drop abandoned /page and /wird prompts so the pending-input map never
  // grows unbounded over a long-running process.
  const pendingSweep = cron.schedule('*/5 * * * *', () => sweepPending());

  tasks.push(tick, pendingSweep);
  logger.info('Scheduler started', { jobs: tasks.length });
}

export function stopScheduler(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
  logger.info('Scheduler stopped');
}
