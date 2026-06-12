import { describe, it, expect } from 'vitest';
import { buildPageTafseerKeyboard } from './tafseer-keyboard';

/** Flatten grammY's inline keyboard to plain { text, url } buttons. */
function buttons(kb: { inline_keyboard: { text: string; url?: string }[][] }) {
  return kb.inline_keyboard.flat().map((b) => ({ text: b.text, url: b.url }));
}

describe('buildPageTafseerKeyboard', () => {
  it('renders one URL button per page, each linking to that page on quran.com', () => {
    const btns = buttons(buildPageTafseerKeyboard([2, 3, 4]));
    expect(btns).toHaveLength(3);
    expect(btns[0].url).toBe('https://quran.com/ar/page/2');
    expect(btns[2].url).toBe('https://quran.com/ar/page/4');
    // A clear "صفحة N" label with the page number in Arabic-Indic digits.
    expect(btns[1].text).toContain('صفحة');
    expect(btns[1].text).toContain('٣');
  });

  it('wraps into rows of perRow so a full-juz wird stays compact', () => {
    const pages = Array.from({ length: 20 }, (_, i) => i + 1);
    const kb = buildPageTafseerKeyboard(pages, 4);
    expect(kb.inline_keyboard.length).toBe(5); // 20 pages / 4 per row
    for (const row of kb.inline_keyboard) expect(row.length).toBeLessThanOrEqual(4);
    expect(buttons(kb)).toHaveLength(20);
  });

  it('handles a single-page wird (the common case)', () => {
    const btns = buttons(buildPageTafseerKeyboard([100]));
    expect(btns).toHaveLength(1);
    expect(btns[0].url).toBe('https://quran.com/ar/page/100');
  });
});
