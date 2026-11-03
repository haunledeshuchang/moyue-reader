A local-first, paper-like ebook reader for Windows — no account, no sync, no network calls.

### Highlights

- **Two-page spreads that actually look like a book** — dotted WPS-style gutter line, inner margin strictly equal to the outer margin, empty side margins reserved for marginal notes.
- **Whole-book page numbers** (`Page 35 / 212`), advancing by exactly 1 per turn and staying stable across font size, page mode and window width.
- **The pointer belongs to text selection** — drag-to-turn and click-to-turn are both gone; paging is `←`/`→` or the edge arrows only. Highlighting never flips the page.
- **Paper-like typography** — 2 em indent, justified with `inter-character`, `line-break: strict`, `text-spacing-trim` / `text-autospace` for CJK–Latin mixing.
- **Custom MOBI/AZW3 parser** — PalmDOC LZ77, HUFF/CDIC, MOBI6 + KF8, EXTH metadata, cover extraction.
- **Annotations** — 6-colour highlights that tint the glyphs only, Word-style marginal comments, side drawer, export to Markdown.

### Downloads

| Build | File | Notes |
|---|---|---|
| Installer | `MoYue-0.1.4-x64.exe` | Per-user install, desktop & Start-menu shortcuts, file associations |
| Portable | `MoYue-0.1.4-portable.exe` | Single executable, no installation |

Windows x64 · unsigned build, so SmartScreen may ask once (*More info → Run anyway*).

### What changed in 0.1.4

- **Fixed: the font picker did nothing on real books.** Every EPUB that ships its own `font-family` — which is most Chinese trade books — looked identical no matter which face you picked. The font was only written on `body`, and a book's own rule such as `p { font-family: 汉仪旗黑50S }` is a *direct* declaration on the paragraph, so it always beat the value inherited from `body`. The rule now goes down to every text element inside the page (`body, body *`, plus `::before`/`::after`), so 系统 / 宋体 / 华宋 / 黑体 / 楷体 / Times really do re-shape the text on any book. `code`, `pre`, `kbd`, `samp`, `tt` are deliberately left monospaced.
- **The font is part of the layout signature**, so the whole-book page count is re-measured after a typeface change instead of keeping the previous face's total.
- **Injected theme rules no longer accumulate.** `epub.js` only appends rules and never clears them, so every font / size / theme change left another copy behind; the previous batch is now dropped first.
- **The font picker is greyed out for PDFs**, with a tooltip — a PDF carries its glyphs inside the page, so no typeface switch can ever change it, and a button that silently does nothing reads as a bug.

### What changed in 0.1.3

- **New typeface: 华文宋体 / STSong** (the `华宋` button in the 版式 panel). It sits between 宋体 and 黑体 so the reading faces go system → 宋体 → 华宋 → 黑体 → 楷体 → Times. STSong ships with Office and the SinoType family rather than with Windows itself, so the stack falls back to NSimSun/SimSun on machines that do not have it — nothing breaks, you just get the Song face you already had.
- The 版式 panel is 28 px wider (264 → 292 px) so the sixth font button fits without clipping `Times`.

### What changed in 0.1.2

- **Whole-book page numbers are now measured, not estimated.** Every spine section is re-typeset off-screen at the current layout (same column width, gap, font, line-height), so the total page count is the real one. Before, a two-line title-page could be counted as a full page, and bumping the font size re-sampled the estimate and shifted the whole book's numbering.
- **New: close button on the selection toolbar** — and tapping anywhere on the page also dismisses it. Selecting a passage you only wanted to read no longer leaves an un-dismissable toolbar on screen.
- **Mouse clicks never page any more — only the edge arrows do.** Click paging turned out to be the main source of accidental turns while highlighting: a passage is selected by dragging, and one stray click either flipped the page or dropped the selection. Keyboard `←`/`→` and the two hover arrows are now the only ways to turn. (This supersedes the click paging introduced earlier in this same version.)
- **Arrow hit targets are now 64 × 148 px** instead of a 42 px circle, and they no longer fade out on a timer — the "I clicked and nothing happened" feeling came from aiming at a small circle that had already started disappearing.
- **Highlights now colour only the glyphs.** EPUB draws them with the CSS Custom Highlight API (`::highlight`) instead of an SVG rectangle overlay. The overlay painted a rect per line box (with 2× line spacing that is a bar twice as tall as the text) and its coordinates were computed once when the annotation was created, so after a page turn or a font-size change the colour stayed where it was and bled over neighbouring text. `::highlight` is repainted by the browser and follows the text through any reflow.
- **Fixed: paging sometimes did nothing.** The turn lock could stay held while a new chapter was being built, silently swallowing every further click. Neighbouring chapters are now pre-fetched, the lock has a hard timeout, and rapid clicks queue instead of being dropped.
- Hover arrows no longer fade out after 1.8 s (they were vanishing just as you moved to click them).

### What changed in 0.1.1

- Fixed: EPUB content shifted right and overflowed the window after opening the TOC sidebar (the stage was not re-paginated when only the container width changed).
- New taskbar / window icon (墨).
- **Installer size cut from 98.7 MB to 77 MB**: runtime moved to Electron 40 (Chromium 144), 26 MB of unused WebGPU shader-compiler DLLs dropped, pdf.js pinned to 4.10.38.

### Notes

- Strong-DRM MOBI files are rejected with a clear message.
- Scanned PDFs have no text layer (image-only, no OCR).
- Reading data stays in `%APPDATA%/moyue-reader/`.
