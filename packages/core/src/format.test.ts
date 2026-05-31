import { describe, it, expect } from 'vitest';
import { ayahMarker, formatPage, formatWird } from './format';
import type { PageContent } from './types';

const BASMALA = 'بِسْمِ ٱللَّهِ';

// A mid-surah page: ayat 3 and 4 of Al-Baqarah (no surah opening, no basmala).
const midSurahPage: PageContent = {
  pageNumber: 3,
  juz: 1,
  ayat: [
    { surahNumber: 2, surahNameAr: 'البقرة', numberInSurah: 3, text: 'نص الآية الثالثة' },
    { surahNumber: 2, surahNameAr: 'البقرة', numberInSurah: 4, text: 'نص الآية الرابعة' },
  ],
};

// A page that opens An-Nas (114:1): a surah start, so the basmala shows.
const surahStartPage: PageContent = {
  pageNumber: 604,
  juz: 30,
  ayat: [{ surahNumber: 114, surahNameAr: 'الناس', numberInSurah: 1, text: 'قل أعوذ' }],
};

// A page spanning the end of one surah and the start of the next.
const twoSurahPage: PageContent = {
  pageNumber: 100,
  juz: 5,
  ayat: [
    { surahNumber: 3, surahNameAr: 'آل عمران', numberInSurah: 200, text: 'آخر آية' },
    { surahNumber: 4, surahNameAr: 'النساء', numberInSurah: 1, text: 'يا أيها الناس' },
  ],
};

describe('ayahMarker', () => {
  it('wraps the number in ornamented brackets with Arabic digits', () => {
    expect(ayahMarker(5)).toBe('﴿٥﴾');
    expect(ayahMarker(255)).toBe('﴿٢٥٥﴾');
  });
});

describe('formatPage', () => {
  it('shows a page-and-juz header and the ayat with markers', () => {
    const [msg] = formatPage(midSurahPage, BASMALA);
    expect(msg).toContain('📖 صفحة ٣ • الجزء ١');
    expect(msg).toContain('سورة البقرة');
    expect(msg).toContain('نص الآية الثالثة ﴿٣﴾');
    expect(msg).toContain('نص الآية الرابعة ﴿٤﴾');
  });

  it('does NOT show the basmala mid-surah', () => {
    const [msg] = formatPage(midSurahPage, BASMALA);
    expect(msg).not.toContain(BASMALA);
  });

  it('shows the basmala when a page opens a surah that carries one', () => {
    const [msg] = formatPage(surahStartPage, BASMALA);
    expect(msg).toContain('سورة الناس');
    expect(msg).toContain(BASMALA);
  });

  it('renders one section per surah on a page that spans two', () => {
    const [msg] = formatPage(twoSurahPage, BASMALA);
    expect(msg).toContain('سورة آل عمران');
    expect(msg).toContain('سورة النساء');
    // basmala appears once, for the surah that actually opens here (An-Nisa).
    expect(msg.match(new RegExp(BASMALA, 'g'))).toHaveLength(1);
    // Al-Imran's last ayah comes before An-Nisa's first ayah.
    expect(msg.indexOf('آخر آية')).toBeLessThan(msg.indexOf('يا أيها الناس'));
  });

  it('returns a single message for a normal-length page', () => {
    expect(formatPage(midSurahPage, BASMALA)).toHaveLength(1);
  });
});

describe('formatWird', () => {
  it('produces a message per page, in order', () => {
    const messages = formatWird([midSurahPage, surahStartPage], BASMALA);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('صفحة ٣');
    expect(messages[1]).toContain('صفحة ٦٠٤');
  });

  it('prepends the lead line to the first message only', () => {
    const messages = formatWird([midSurahPage, surahStartPage], BASMALA, '🌿 وردك اليوم');
    expect(messages[0].startsWith('🌿 وردك اليوم')).toBe(true);
    expect(messages[1]).not.toContain('وردك اليوم');
  });
});
