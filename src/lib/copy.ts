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

/**
 * A count of days in correct Arabic number-noun agreement: "يوم واحد" (1),
 * "يومان" (2), "N أيام" (3-10), "N يومًا" (11+). Used by the gentle "you have
 * not read for N days" nudge.
 */
export function daysCountAr(days: number): string {
  if (days === 1) return 'يوم واحد';
  if (days === 2) return 'يومين';
  if (days <= 10) return `${toArabicDigits(days)} أيام`;
  return `${toArabicDigits(days)} يومًا`;
}

/** "صفحة ٢٥ (الجزء ٢)" or "صفحة ٢٥" when the juz is unknown. */
export function pagePositionAr(page: number, juz?: number): string {
  const base = `صفحة ${toArabicDigits(page)}`;
  return juz ? `${base} (الجزء ${toArabicDigits(juz)})` : base;
}

/** Arabic name of a reciter key (see src/core/reciter.ts), for buttons,
 *  captions, and the status line. */
const RECITER_NAME_AR: Record<string, string> = {
  abdulbasit: 'عبد الباسط عبد الصمد',
  husary: 'محمود خليل الحصري',
  alafasy: 'مشاري العفاسي',
  sudais: 'عبد الرحمن السديس',
  minshawi: 'محمد صديق المنشاوي',
};

export function reciterNameAr(key: string): string {
  return RECITER_NAME_AR[key] ?? key;
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
  /** How the wird is delivered: "text" or "image". */
  wirdFormat?: 'text' | 'image';
  /** Whether the daily tajweed lesson is on. Omitted when a caller does not
   *  track it. */
  tajweedEnabled?: boolean;
  /** Whether the page recitation is on, and the chosen reciter key. */
  wirdAudioEnabled?: boolean;
  reciter?: string;
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
  const lines = [
    heading,
    `• الحالة: ${status}`,
    `• الورد اليومي: ${wirdSizeSummaryAr(s.wirdSize)}`,
    `• الموضع الحالي: ${pagePositionAr(s.currentPage, s.currentJuz)}`,
    `• وقت الإرسال: ${formatTimeAr(s.deliveryHour, s.deliveryMinute)}`,
    `• الأيام: ${daysSummaryAr(s.activeDays)}`,
    `• المنطقة الزمنية: ${ltr(s.timezone)}`,
  ];
  // Show the delivery format (image is the default). Omitted only when a caller
  // does not track it.
  if (s.wirdFormat) {
    lines.push(`• طريقة الإرسال: ${s.wirdFormat === 'image' ? 'صورة 🖼️' : 'نص 📝'}`);
  }
  if (s.tajweedEnabled !== undefined) {
    lines.push(`• درس التجويد اليومي: ${s.tajweedEnabled ? 'مفعّل ✅' : 'متوقف ⏸️'}`);
  }
  if (s.wirdAudioEnabled !== undefined) {
    lines.push(
      `• تلاوة الصفحة: ${s.wirdAudioEnabled ? `${reciterNameAr(s.reciter ?? '')} 🎧` : 'متوقفة ⏸️'}`,
    );
  }
  return lines.join('\n');
}

export const COPY = {
  // ── Bot profile (set on startup via the Bot API, like the commands) ─
  // About = the short blurb on the bot's profile card (Telegram limit 120).
  // Ends with "للبدء اضغط\nStart" — the line break before Start is intentional.
  botAbout:
    'وردك اليومي من القرآن 🌿 صفحة كل يوم، أو أكثر حتى جزء كامل، في الوقت والأيام التي تختارها. للبدء اضغط\nStart',
  // Description = the text on the empty chat, shown before /start (limit 512).
  botDescription: [
    'السلام عليكم ورحمة الله 🌿',
    'بوت "تلاوة" يعينك على قراءة وردك اليومي من القرآن الكريم:',
    '• يصلك كل يوم وردك من المصحف، صفحة واحدة افتراضيًا، ويمكنك زيادتها حتى ٢٠ صفحة.',
    '• لا يتقدّم وردك إلا حين تؤكّد أنك قرأته، فلا تفوتك صفحة ولو انقطعت أيامًا.',
    '• تختار وقت الإرسال والأيام التي تناسبك.',
    '• يمكنك أخذ راحة وقتما تشاء، وتعود من حيث توقفت.',
    'للبدء اضغط',
    'Start',
  ].join('\n'),

  // ── User onboarding and help ──────────────────────────────────────
  welcome: (settings: string) =>
    [
      'السلام عليكم ورحمة الله 🌿',
      '',
      'مرحبًا بك في بوت "تلاوة". يرسل لك وردًا من القرآن كل يوم بإذن الله، صفحة واحدة افتراضيًا، ويمكنك زيادتها حتى ٢٠ صفحة (جزء كامل).',
      '',
      '👈 لقراءة وردك الآن اضغط /today',
      'وبعد قراءته اضغط زر «✅ قرأتُ وردي — التالي» لينتقل بك إلى ما بعده. وما لم تؤكّد، يبقى وردك في انتظارك ولا تفوتك صفحة.',
      '',
      settings,
      '',
      'لضبط حجم الورد: /wird',
      'ولقراءة المزيد أو تدارُك يوم فائت: /next',
      'ولعرض كل الأوامر: /help',
    ].join('\n'),

  help: [
    'بوت "تلاوة" يرسل لك وردًا يوميًا من القرآن الكريم.',
    '',
    'الأوامر:',
    '/today: قراءة ورد اليوم الآن',
    '/next: تأكيد قراءة وردك والانتقال إلى التالي (لقراءة المزيد أو تدارك يوم فائت)',
    `/wird: حجم الورد اليومي (١ إلى ٢٠ صفحة)، مثل ${ltr('/wird 5')}`,
    '/tajweed: درس تجويد يومي قبل وردك (تشغيل/إيقاف)',
    '/reciter: تلاوة صفحتك صوتًا، واختيار القارئ أو الإيقاف',
    '/tafsir: رابط لقراءة تفسير صفحات وردك على الموقع',
    '/format: طريقة الإرسال، نصًّا أو صورة من المصحف',
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

  // Shown above the wird when /today re-shows a wird already delivered today.
  todayAlready: 'وصلك ورد اليوم من قبل، وهذا هو:',

  // ── Reading confirmation (the "read ✓" button) ───────────────────
  // The button under each user wird, and the small prompt that carries it.
  readButton: '✅ قرأتُ وردي — التالي',
  confirmPrompt: 'إذا أتممتَ قراءة وردك فاضغط الزر لأنتقل بك إلى وردك التالي.',
  // Shown after a confirmed read advances the reader. Mentions /next so a reader
  // who wants more knows how to keep going now.
  readConfirmed: (page: number, juz?: number) =>
    `بارك الله فيك ✓\nانتقلتَ إلى ${pagePositionAr(page, juz)}.\nيصلك وردك التالي في موعده، أو اكتب ${ltr('/next')} لقراءة المزيد الآن.`,
  // Toast when an old/already-used "read" button is tapped (the position has
  // already moved on). Kept gentle: their reading is recorded, nothing is wrong.
  readAlready: 'سجّلنا قراءتك ✓',
  // The lead line for the wird shown by /next (the NEXT portion, on demand).
  nextLead: '🌿 وردك التالي',
  // The gentle "you have not read for N days" message shown when a wird repeats
  // unread, followed by an ayah on the virtue of the Qur'an (text from the DB).
  // No parse_mode anywhere, so the ayah's characters are safe.
  missedDaysMessage: (
    days: number,
    ayah: { text: string; surahNameAr: string; numberInSurah: number; note?: string },
  ) =>
    [
      `لم تقرأ وردك منذ ${daysCountAr(days)}.`,
      'لا حرج، عُد متى شئت ووردك بانتظارك من حيث توقفت.',
      '',
      // Frame the verse as an encouragement on the merit of the Qur'an — NOT the
      // reader's wird — so a verse shown here is never mistaken for today's wird
      // (which follows next, clearly led by "🌿 وردك اليوم").
      'وهذه آيةٌ في فضل القرآن:',
      '',
      ayah.text,
      `[سورة ${ayah.surahNameAr} — آية ${toArabicDigits(ayah.numberInSurah)}]`,
    ].join('\n'),

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

  // ── Delivery format (text or image) ───────────────────────────────
  formatPrompt: (current: 'text' | 'image', imageAvailable: boolean) => {
    const now =
      current === 'image'
        ? 'يصلك وردك الآن على هيئة صورة من المصحف.'
        : 'يصلك وردك الآن على هيئة نص.';
    const lines = [`طريقة إرسال وردك: ${current === 'image' ? 'صورة 🖼️' : 'نص 📝'}`, now];
    if (imageAvailable) {
      lines.push('اختر الطريقة التي تناسبك:');
      lines.push('• النص يمكنك نسخه والبحث فيه.');
      lines.push('• الصورة تعرض صفحة المصحف كما هي.');
    } else {
      lines.push('خيار الصورة غير متاح في هذا البوت حاليًا.');
    }
    return lines.join('\n');
  },
  formatUpdated: (format: 'text' | 'image') =>
    format === 'image'
      ? 'تم ✅ سيصلك وردك على هيئة صورة من المصحف بإذن الله 🖼️'
      : 'تم ✅ سيصلك وردك على هيئة نص بإذن الله 📝',
  formatImageUnavailable:
    'عذرًا، خيار الصورة غير متاح في هذا البوت حاليًا. سيبقى وردك على هيئة نص 📝',

  // ── Current page (go to a page) ───────────────────────────────────
  pagePrompt: (current: number, juz?: number) =>
    [
      `موضعك الحالي: ${pagePositionAr(current, juz)}.`,
      'أرسل رقم الصفحة التي تريد الانتقال إليها (من ١ إلى ٦٠٤)،',
      `أو اكتبه مع الأمر مباشرة، مثل ${ltr('/page 100')}`,
    ].join('\n'),
  pageInvalid: `رقم الصفحة غير صحيح. اكتب رقمًا من ١ إلى ٦٠٤، مثل ${ltr('/page 100')}`,
  // After /page: the position is set to the new page and that wird is shown.
  // Read-gated, so nothing advances yet — the reader moves on by confirming.
  pageSet: (page: number, juz?: number) =>
    `ضبطنا موضعك على ${pagePositionAr(page, juz)} ✅\nوهذا وردك من هنا.`,

  // ── Pause / resume (single toggle) ────────────────────────────────
  paused: 'تم إيقاف الإرسال مؤقتًا، وسيبقى موضعك محفوظًا.\nوعندما تريد العودة اكتب /pause',
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

  // ── Daily tajweed lesson ──────────────────────────────────────────
  // Header above the lesson preview in /tajweed (no-arg).
  tajweedStatus: (enabled: boolean) =>
    enabled
      ? 'درس التجويد اليومي مفعّل ✅ يصلك قبل وردك كل يوم. وهذا درس اليوم:'
      : 'درس التجويد اليومي متوقف ⏸️ يمكنك تشغيله ليصلك قبل وردك كل يوم.',
  tajweedUsage: (enabled: boolean) =>
    [
      `درس التجويد اليومي الآن: ${enabled ? 'مفعّل ✅' : 'متوقف ⏸️'}.`,
      `للتشغيل اكتب ${ltr('/tajweed on')}، وللإيقاف ${ltr('/tajweed off')}،`,
      'أو استخدم الزر تحت رسالة /tajweed.',
    ].join('\n'),
  tajweedEnabledMsg: 'تم تشغيل درس التجويد اليومي ✅ سيصلك قبل وردك كل يوم بإذن الله.',
  tajweedDisabledMsg: 'تم إيقاف درس التجويد اليومي ⏸️ سيصلك وردك وحده.',
  tajweedTurnOnBtn: '✅ تشغيل درس التجويد',
  tajweedTurnOffBtn: '⏸️ إيقاف درس التجويد',
  tajweedToggledOn: 'تم تشغيل درس التجويد ✅',
  tajweedToggledOff: 'تم إيقاف درس التجويد ⏸️',
  // ── Tajweed lessons browser (the full index, opened from /tajweed) ──
  // A read-only library of every lesson; tapping one shows it, without touching
  // the reader's daily lesson position.
  tajweedBrowseBtn: '📚 كل دروس التجويد',
  tajweedListHeader: '📚 دروس التجويد — اختر الدرس الذي تحب أن تتعلّمه:',
  tajweedBackBtn: '« كل الدروس',
  tajweedLessonUnavailable: 'هذا الدرس غير متاح حاليًا.',
  // Shown while the lesson deck is still under review (not yet live).
  tajweedComingSoon:
    'درس التجويد اليومي قيد الإعداد والمراجعة على يد متخصص، وسيبدأ قريبًا بإذن الله 🌿',
  // Caption + music-player title/performer for a lesson's example clip, so the
  // player names it when Telegram auto-advances the chat's audio playlist.
  tajweedAudioCaption: (titleAr: string) => `مثال: ${titleAr}`,
  tajweedAudioTitle: (titleAr: string) => `مثال: ${titleAr}`,
  tajweedAudioPerformer: 'دروس التجويد',

  // ── Page recitation (reciter) ─────────────────────────────────────
  // Caption under each page's audio clip.
  pageAudioCaption: (page: number, reciter: string) =>
    `تلاوة الصفحة ${toArabicDigits(page)} — ${reciterNameAr(reciter)}`,
  // Music-player title for a page clip (the reciter is the performer). Telegram
  // auto-advances through the chat's audio when one ends; naming the track
  // keeps the player and lock screen showing which page is playing.
  pageAudioTitle: (page: number) => `الصفحة ${toArabicDigits(page)}`,
  reciterPrompt: (enabled: boolean, reciter: string) =>
    [
      enabled
        ? `تلاوة صفحتك تصلك الآن بصوت ${reciterNameAr(reciter)} 🎧`
        : 'تلاوة الصفحة متوقفة الآن ⏸️',
      'اختر القارئ، أو أوقف التلاوة:',
    ].join('\n'),
  reciterUpdated: (reciter: string) =>
    `تم ✅ ستصلك تلاوة صفحتك بصوت ${reciterNameAr(reciter)} بإذن الله 🎧`,
  reciterOff: 'تم إيقاف تلاوة الصفحة ⏸️ سيصلك الورد بدون صوت.',
  // Callback toasts.
  reciterToggledOff: 'تم إيقاف التلاوة ⏸️',
  // "Try it on today's page" preview button (on the reciter confirmation) + its
  // toasts. The preview plays ONE page's recitation in the new voice as a
  // silent peek: it never records a delivery or advances the position.
  reciterSampleBtn: '🎧 جرّب على صفحة اليوم',
  sampleSent: 'أرسلنا عينة على صفحة اليوم',
  sampleNoPage: 'ابدأ أولًا بـ /today لتجربة القارئ',
  sampleReciterOff: 'التلاوة متوقفة حاليًا',

  // ── Page tafseer (/tafsir) ────────────────────────────────────────
  // A link, not stored text: a tilawah page holds many ayat, so we point the
  // reader at the exact page on quran.com (a trusted source) where every ayah's
  // tafsir is one tap away. The buttons below cover today's wird pages.
  tafsirIntro:
    'تفسير صفحات وردك 📖\nافتح الصفحة على الموقع، ثم اضغط على أي آية لقراءة تفسيرها (الميسر، السعدي، ابن كثير، وغيرها).',
  tafsirNoPages: 'لم نتمكّن من تحديد صفحات وردك الآن. جرّب /today أولًا.',

  // ── Admin / channel ───────────────────────────────────────────────
  adminOnly: 'هذا الأمر للمشرف فقط.',
  noChannel: 'لا توجد قناة مُعدّة. اضبط CHANNEL_CHAT_ID في ملف الإعدادات أولًا.',
  channelLead: '🌿 ورد اليوم',

  setPageUsage: `اكتب رقم آخر صفحة تمت قراءتها (١ إلى ٦٠٤)، مثل ${ltr('/admin_setpage 50')}\nوسينشر البوت الصفحة التالية في الإرسال القادم.`,
  setPageInvalid: 'رقم الصفحة غير صحيح. اكتب رقمًا صحيحًا من ١ إلى ٦٠٤.',
  setPageDone: (lastRead: number, next: number) =>
    `تم ✅ آخر صفحة مقروءة: ${toArabicDigits(lastRead)}. الإرسال القادم يبدأ من صفحة ${toArabicDigits(next)}.`,

  adminRestartDone: 'تم ✅ بدأنا ختمة جديدة من صفحة ١.',

  adminWirdUsage: `اكتب عدد صفحات القناة في اليوم (١ إلى ٢٠)، مثل ${ltr('/admin_wird 1')}`,
  adminWirdInvalid: 'العدد غير صحيح. اكتب رقمًا صحيحًا من ١ إلى ٢٠.',
  adminWirdDone: (pages: number) => `تم ضبط ورد القناة على ${wirdSizeSummaryAr(pages)} في اليوم ✅`,

  adminTimeUsage: `اكتب وقت نشر القناة بنظام ٢٤ ساعة، مثل ${ltr('/admin_time 06:00')}`,
  adminTzUsage: `اكتب المنطقة الزمنية للقناة، مثل ${ltr('/admin_tz Africa/Cairo')}`,

  adminFormatUsage: (current: 'text' | 'image', imageAvailable: boolean) => {
    const lines = [
      `طريقة نشر القناة الحالية: ${current === 'image' ? 'صورة 🖼️' : 'نص 📝'}`,
      `اكتب ${ltr('/admin_format text')} للنص أو ${ltr('/admin_format image')} للصورة.`,
    ];
    if (!imageAvailable) {
      lines.push('ملاحظة: خيار الصورة غير مُعدّ بعد (اضبط MUSHAF_IMAGE_BASE_URL في الإعدادات).');
    }
    return lines.join('\n');
  },
  adminFormatInvalid: `القيمة غير صحيحة. اكتب ${ltr('text')} أو ${ltr('image')}.`,
  adminFormatImageUnavailable:
    'خيار الصورة غير مُعدّ. اضبط MUSHAF_IMAGE_BASE_URL في الإعدادات أولًا، ثم أعد المحاولة.',
  adminFormatDone: (format: 'text' | 'image') =>
    format === 'image'
      ? 'تم ✅ ستنشر القناة الورد على هيئة صورة من المصحف 🖼️'
      : 'تم ✅ ستنشر القناة الورد على هيئة نص 📝',

  channelPaused: 'تم إيقاف نشر القناة مؤقتًا. للعودة اكتب /admin_pause',
  channelResumed: 'تمت العودة لنشر القناة ✅',

  adminTajweedUsage: (enabled: boolean) =>
    [
      `درس التجويد اليومي للقناة الآن: ${enabled ? 'مفعّل ✅' : 'متوقف ⏸️'}.`,
      `اكتب ${ltr('/admin_tajweed on')} لتفعيله أو ${ltr('/admin_tajweed off')} لإيقافه.`,
      'يُنشر قبل ورد القناة كل يوم.',
    ].join('\n'),
  adminTajweedDone: (enabled: boolean) =>
    enabled
      ? 'تم ✅ ستنشر القناة درس التجويد قبل الورد كل يوم.'
      : 'تم ⏸️ لن تنشر القناة درس التجويد، الورد فقط.',

  adminReciterUsage: (enabled: boolean, reciter: string) =>
    [
      enabled
        ? `تلاوة القناة الآن بصوت ${reciterNameAr(reciter)} 🎧`
        : 'تلاوة القناة متوقفة الآن ⏸️',
      `اكتب ${ltr('/admin_reciter off')} للإيقاف، أو اسم المفتاح:`,
      `${ltr('abdulbasit / husary / alafasy / sudais / minshawi')}`,
    ].join('\n'),
  adminReciterDone: (enabled: boolean, reciter: string) =>
    enabled
      ? `تم ✅ ستنشر القناة تلاوة الصفحة بصوت ${reciterNameAr(reciter)} 🎧`
      : 'تم ⏸️ لن تنشر القناة تلاوة الصفحة.',

  adminReviewCaption: (count: number) =>
    [
      `📄 ملف مراجعة دروس التجويد (${toArabicDigits(count)} درسًا).`,
      'يحتوي كل درس مع نص آيته من المصحف واسم ملف الصوت.',
      'راجِع الشرح ومطابقة الأمثلة، أو مرّر الملف لمختص (قارئ مُجاز).',
    ].join('\n'),
};
