// Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms.
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/** The reading direction of `text`, by its first strong letter — what
 *  `dir="auto"` decides for one element. For a container whose first text is
 *  not the lyric (a Latin stem tag before Hebrew words), where `dir="auto"`
 *  would read the tag and lay the words out left to right. */
export function textDir(text: string): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LTR_CHAR.test(ch)) return 'ltr';
  }
  return 'ltr';
}
