// Public surface of the database package: the Prisma client, the model types,
// the services the bot calls, and the reference data.

export { prisma } from './client';

// Generated model types, re-exported so the app imports them from one place.
export type { Surah, Ayah, Subscriber, DeliveryLog } from './generated/prisma/client';

// Services
export * from './services/quran.service';
export * from './services/subscriber.service';
export * from './services/pause.service';
export * from './services/delivery.service';
export * from './services/mushaf-image.service';
export * from './services/tajweed-audio.service';
export * from './services/page-audio.service';

// Reference data
export * from './reference/surahs';
export * from './reference/ayah-counts';
export * from './reference/pages';
export * from './reference/tajweed-lessons';
export * from './reference/quran-virtues';
