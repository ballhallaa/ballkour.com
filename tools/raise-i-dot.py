#!/usr/bin/env python3
"""Raise the dot of i and j in the site's Barlow fonts, so small text doesn't read "Ground tlme".

    python3 -m pip install fonttools brotli
    python3 tools/raise-i-dot.py

Barlow leaves only 57 to 91 thousandths of the text size between the dot of an i or j and its stem (less the bolder it
is). At 14px that's about a pixel, and browsers on Linux round it away, so the dot runs into the stem and the i looks
like an l. This moves the dot up to 100 thousandths above the stem (about 1.4px at 14px, a sliver higher than before)
and drops those two letters' own hinting, which would pull the dot back down. Checked in Brave on Linux: the dot stays
clear from 11px to 20px in every weight the site uses.

It changes the Latin files and the Latin Extended ones, which keep an i and a j to build ĳ from (accented letters like
í start from a dotless ı, so they were clear already). Running it again changes nothing. After running it, bump the
?v= on the Barlow fonts in index.html and 404.html, since browsers keep the fonts for a week.
"""
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import ttProgram

GAP = 100  # thousandths of the text size between the stem's top and the dot's bottom
FONTS = Path(__file__).resolve().parent.parent / "assets" / "fonts"

for path in sorted(FONTS.glob("barlow-latin-*-normal.woff2")):
    font = TTFont(path)
    glyf = font["glyf"]
    changed = []
    for name in ("i", "j"):
        glyph = glyf[name]
        coords, ends, _ = glyph.getCoordinates(glyf)
        starts = [0] + [end + 1 for end in ends[:-1]]
        contours = [range(start, end + 1) for start, end in zip(starts, ends)]
        # The dot is the outline that sits highest; the rest is the stem
        dot = max(contours, key=lambda c: min(coords[p][1] for p in c))
        stem_top = max(coords[p][1] for c in contours if c is not dot for p in c)
        gap = min(coords[p][1] for p in dot) - stem_top
        if gap >= GAP:
            continue
        for p in dot:
            coords[p] = (coords[p][0], coords[p][1] + GAP - gap)
        glyph.coordinates = coords
        glyph.program = ttProgram.Program()
        glyph.program.fromBytecode(b"")
        glyph.recalcBounds(glyf)
        changed.append(f"{name} {gap}→{GAP}")
    if changed:
        font.flavor = "woff2"
        font.save(path)
    print(f"{path.name}: {', '.join(changed) or 'already raised'}")
