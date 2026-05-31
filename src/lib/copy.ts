// All the Arabic text the bot shows. Kept in one file so wording is easy to
// review and change without touching logic. Numbers shown to users are in
// Arabic-Indic digits to match the Quran text.
//
// Bidi note: this text is right-to-left, but commands, clock times and
// timezone names are left-to-right. When a left-to-right run sits in the
// middle of Arabic, the punctuation around it can render in the wrong order.
// The ltr() helper wraps such a run in Unicode isolate characters so it always
// renders correctly. A lone command at the very end of a line is fine without
// it, so we only wrap the tricky cases (examples, formats, timezone names).

import { activeDaysList, isDayActive, toArabicDigits, ALL_DAYS, khatmaDays } from '../core';

// Unicode isolate characters: First Strong Isolate (U+2066) ... Pop
// Directional Isolate (U+2069). Built from code points because the characters
// themselves are invisible.
const FIRST_STRONG_ISOLATE = String.fromCodePoint(0x2066);
const POP_DIRECTIONAL_ISOLATE = String.fromCodePoint(0x2069);

/** Wrap a left-to-right run (a command, a time, a timezone) so it renders
 *  correctly inside right-to-left Arabic text. */
export function ltr(run: string): string {
  return `${FIRST_STRONG_ISOLATE}${run}${POP_DIRECTIONAL_ISOLATE}`;
}

/** Arabic names for ISO weekdays (1 = Monday ... 7 = Sunday). */
const DAY_NAMES_AR: Record<number, string> = {
  1: 'الإثنين',
  2: 'الثلاثاء',
  3: 'الأربعاء',
  4: 'الخميس',
  5: 'الجمعة',
  6: 'السبت',
  7: 'الأحد',
};

// The weekdays in the order Arabic speakers expect to read them: Saturday
// first, Friday last. Values are ISO weekday numbers (Monday = 1 ... Sunday =
// 7) so they still match the bitmask helpers in core; only the display order
// differs. Both the day picker and the settings summary use this.
export const WEEKDAY_DISPLAY_ORDER: readonly number[] = [6, 7, 1, 2, 3, 4, 5];

export function dayNameAr(isoWeekday: number): string {
  return DAY_NAMES_AR[isoWeekday] ?? String(isoWeekday);
}

/** "07:00" style clock, with Arabic-Indic digits. */
export function formatTimeAr(hour: number, minute: number): string {
  const h = toArabicDigits(hour).padStart(2, '٠');
  const m = toArabicDigits(minute).padStart(2, '٠');
  return `${h}:${m}`;
}

/** A friendly list of the active days (Saturday first), or "every day". */
export function daysSummaryAr(mask: number): string {
  if (mask === ALL_DAYS) return 'كل الأيام';
  const days = WEEKDAY_DISPLAY_ORDER.filter((iso) => isDayActive(mask, iso));
  if (days.length === 0) return 'لا يوجد (لن يصلك ورد)';
  return days.map(dayNameAr).join('، ');
}

/**
 * The wird size in correct Arabic number-noun agreement: singular for 1, dual
 * for 2, plural صفحات for 3-10, singular صفحة for 11+.
 */
export function wirdSizeSummaryAr(pages: number): string {
  if (pages === 1) return 'صفحة واحدة';
  if (pages === 2) return 'صفحتان';
  if (pages <= 10) return `${toArabicDigits(pages)} صفحات`;
  return `${toArabicDigits(pages)} صفحة`;
}

/** "صفحة ٢٥ (الجزء ٢)" or "صفحة ٢٥" when the juz is unknown. */
export function pagePositionAr(page: number, juz?: number): string {
  const base = `صفحة ${toArabicDigits(page)}`;
  return juz ? `${base} (الجزء ${toArabicDigits(juz)})` : base;
}

export interface SettingsView {
  deliveryHour: number;
  deliveryMinute: number;
  activeDays: number;
  timezone: string;
  wirdSize: number;
  currentPage: number;
  pausedAt: Date | null;
  /** Juz of the current page, shown if known. */
  currentJuz?: number;
}

/** Build the status / settings summary, shared by users and the channel. */
export function settingsSummary(s: SettingsView, opts: { isChannel?: boolean } = {}): string {
  const noDays = activeDaysList(s.activeDays).length === 0;
  let status: string;
  if (s.pausedAt) status = 'في وضع الراحة ⏸️';
  else if (noDays)
    status = opts.isChannel ? 'متوقف (لا يوجد يوم محدد) ⚠️' : 'لن يصلك ورد (لم تختر أي يوم) ⚠️';
  else status = 'يعمل ✅';

  const heading = opts.isChannel ? 'إعدادات القناة:' : 'إعداداتك الحالية:';
  return [
    heading,
    `• الحالة: ${status}`,
    `• الورد اليومي: ${wirdSizeSummaryAr(s.wirdSize)}`,
    `• الموضع الحالي: ${pagePositionAr(s.currentPage, s.currentJuz)}`,
    `• وقت الإرسال: ${formatTimeAr(s.deliveryHour, s.deliveryMinute)}`,
    `• الأيام: ${daysSummaryAr(s.activeDays)}`,
    `• المنطقة الزمنية: ${ltr(s.timezone)}`,
  ].join('\n');
}

export const COPY = {
  // ── User onboarding and help ──────────────────────────────────────
  welcome: (settings: string) =>
    [
      'السلام عليكم ورحمة الله 🌿',
      '',
      'مرحبًا بك في بوت "تلاوة". يرسل لك وردًا من القرآن كل يوم بإذن الله، صفحة واحدة افتراضيًا، ويمكنك زيادتها حتى ٢٠ صفحة (جزء كامل).',
      '',
      '👈 لقراءة وردك الآن اضغط /today',
      '',
      settings,
      '',
      'لضبط حجم الورد: /wird',
      'ولعرض كل الأوامر: /help',
    ].join('\n'),

  help: [
    'بوت "تلاوة" يرسل لك وردًا يوميًا من القرآن الكريم.',
    '',
    'الأوامر:',
    '/today: قراءة ورد اليوم الآن (بدون تغيير موضعك)',
    `/wird: حجم الورد اليومي (١ إلى ٢٠ صفحة)، مثل ${ltr('/wird 5')}`,
    `/page: الانتقال إلى صفحة معيّنة (١ إلى ٦٠٤)، مثل ${ltr('/page 100')}`,
    '/time: ضبط وقت الإرسال',
    '/days: اختيار أيام الإرسال',
    '/timezone: ضبط المنطقة الزمنية',
    '/pause: أخذ راحة أو العودة منها (يبقى موضعك محفوظًا)',
    '/status: عرض إعداداتك وموضعك الحالي',
  ].join('\n'),

  // Shown when the personal bot is turned off (channel-only deployment).
  userBotDisabled:
    'هذا البوت يخدم قناة "تلاوة" فقط، والورد الشخصي غير مفعّل هنا. تابع القناة لتصلك الصفحة اليومية بإذن الله 🌿',

  notReady: 'تعذّر تجهيز وردك الآن، حاول لاحقًا بإذن الله.',

  // Shown for a stray text message that is not a command and not an expected
  // number reply (after /page or /wird).
  unknownText: 'لم أفهم رسالتك 🤔\nاكتب /help لرؤية الأوامر، أو /page لتغيير صفحتك.',

  // ── Wird size ─────────────────────────────────────────────────────
  wirdPrompt: (current: number) =>
    [
      `حجم وردك الحالي: ${wirdSizeSummaryAr(current)}.`,
      'اختر عدد الصفحات من الأزرار، أو أرسل رقمًا من ١ إلى ٢٠،',
      `أو اكتبه مع الأمر مباشرة، مثل ${ltr('/wird 5')}`,
    ].join('\n'),
  wirdInvalid: `الرجاء كتابة رقم صحيح من ١ إلى ٢٠، مثل ${ltr('/wird 5')}`,
  wirdUpdated: (pages: number) =>
    `تم ضبط الورد على ${wirdSizeSummaryAr(pages)} في اليوم ✅\nبهذه السرعة تختم القرآن في نحو ${toArabicDigits(khatmaDays(pages))} يومًا بإذن الله.`,

  // ── Current page (go to a page) ───────────────────────────────────
  pagePrompt: (current: number, juz?: number) =>
    [
      `موضعك الحالي: ${pagePositionAr(current, juz)}.`,
      'أرسل رقم الصفحة التي تريد الانتقال إليها (من ١ إلى ٦٠٤)،',
      `أو اكتبه مع الأمر مباشرة، مثل ${ltr('/page 100')}`,
    ].join('\n'),
  pageInvalid: `رقم الصفحة غير صحيح. اكتب رقمًا من ١ إلى ٦٠٤، مثل ${ltr('/page 100')}`,
  pageUpdated: (page: number, juz?: number) =>
    `تم ضبط موضعك على ${pagePositionAr(page, juz)} ✅\nسيبدأ وردك القادم من هنا. لرؤيته الآن اضغط /today`,

  // ── Pause / resume (single toggle) ────────────────────────────────
  paused: 'تم إيقاف الإرسال مؤقتًا، وسيبقى موضعك محفوظًا 🌿\nوعندما تريد العودة اكتب /pause',
  resumed: 'أهلًا بعودتك 🌿 سنكمل من حيث توقفت بإذن الله.',
  pausedHint: 'تذكير: أنت في وضع الراحة الآن، فلن يصلك الورد تلقائيًا.\nللعودة اكتب /pause',

  // ── Time ──────────────────────────────────────────────────────────
  timePrompt:
    'اختر وقت الإرسال من الأزرار، أو اكتبه بنفسك بهذه الصيغة (٢٤ ساعة):\n' +
    `${ltr('/time HH:MM')}\nمثل ${ltr('/time 07:00')}`,
  timeInvalid: `صيغة الوقت غير صحيحة. اكتب الوقت بنظام ٢٤ ساعة، مثل ${ltr('/time 07:00')}`,
  timeUpdated: (t: string, tz: string) =>
    `تم ضبط وقت الإرسال على ${ltr(t)} حسب منطقتك (${ltr(tz)}) ✅\nإن لم تكن منطقتك صحيحة فاضبطها عبر /timezone`,

  // ── Timezone ──────────────────────────────────────────────────────
  tzPrompt:
    'اختر منطقتك الزمنية من المدن التالية، أو اكتبها بنفسك بهذه الصيغة:\n' +
    `${ltr('/timezone Area/City')}\nمثل ${ltr('/timezone Africa/Cairo')}`,
  tzInvalid: `اسم المنطقة الزمنية غير صحيح. مثال صحيح: ${ltr('Africa/Cairo')}`,
  tzUpdated: (tz: string) => `تم ضبط المنطقة الزمنية على ${ltr(tz)} ✅`,

  // ── Days ──────────────────────────────────────────────────────────
  daysPrompt: 'اختر الأيام التي تريد أن يصلك فيها الورد، ثم اضغط "تم":',
  daysUpdated: (summary: string) => `تم تحديث أيام الإرسال: ${summary} ✅`,
  daysNone: 'لم تختر أي يوم، لن يصلك ورد. اختر يومًا واحدًا على الأقل، أو خذ راحة عبر /pause',

  // The lead line prefixed to a user's daily wird (and the /today preview).
  wirdLead: '🌿 وردك اليوم',

  // ── Admin / channel ───────────────────────────────────────────────
  adminOnly: 'هذا الأمر للمشرف فقط.',
  noChannel: 'لا توجد قناة مُعدّة. اضبط CHANNEL_CHAT_ID في ملف الإعدادات أولًا.',
  channelLead: '🌿 ورد اليوم',

  setPageUsage: `اكتب رقم آخر صفحة تمت قراءتها (١ إلى ٦٠٤)، مثل ${ltr('/admin_setpage 50')}\nوسينشر البوت الصفحة التالية في الإرسال القادم.`,
  setPageInvalid: 'رقم الصفحة غير صحيح. اكتب رقمًا صحيحًا من ١ إلى ٦٠٤.',
  setPageDone: (lastRead: number, next: number) =>
    `تم ✅ آخر صفحة مقروءة: ${toArabicDigits(lastRead)}. الإرسال القادم يبدأ من صفحة ${toArabicDigits(next)}.`,

  adminWirdUsage: `اكتب عدد صفحات القناة في اليوم (١ إلى ٢٠)، مثل ${ltr('/admin_wird 1')}`,
  adminWirdInvalid: 'العدد غير صحيح. اكتب رقمًا صحيحًا من ١ إلى ٢٠.',
  adminWirdDone: (pages: number) => `تم ضبط ورد القناة على ${wirdSizeSummaryAr(pages)} في اليوم ✅`,

  adminTimeUsage: `اكتب وقت نشر القناة بنظام ٢٤ ساعة، مثل ${ltr('/admin_time 06:00')}`,
  adminTzUsage: `اكتب المنطقة الزمنية للقناة، مثل ${ltr('/admin_tz Africa/Cairo')}`,

  channelPaused: 'تم إيقاف نشر القناة مؤقتًا. للعودة اكتب /admin_pause',
  channelResumed: 'تمت العودة لنشر القناة ✅',
};
