// The link to read a Mushaf page's tafseer on the web. Pure, so it is easy to
// test. We store NO tafseer text (a tilawah page holds dozens of ayat, far too
// much to send); instead /tafsir hands the reader a link to the exact page they
// are reading on quran.com, where every ayah's tafsir (Al-Muyassar, As-Saadi,
// Ibn Kathir, and more) is one tap away. quran.com is the Quran.Foundation site
// (the same trusted source the ayah bot links its tafseer to). The link is
// built from the page number alone, so it is always correct for whatever the
// reader's wird currently is — `pnpm verify:tafseer` checks the pattern still
// resolves.

/** The Mushaf-page tafseer page on quran.com (Arabic), for page 1..604. The
 *  reader opens the page and taps any ayah to read its tafsir. */
export function pageTafseerUrl(pageNumber: number): string {
  return `https://quran.com/ar/page/${pageNumber}`;
}
