A local-first, paper-like ebook reader for Windows — no account, no sync, no network calls.

### Highlights

- **Two-page spreads that actually look like a book** — dotted WPS-style gutter line, inner margin strictly equal to the outer margin, empty side margins reserved for marginal notes.
- **Whole-book page numbers** (`Page 35 / 212`), advancing by exactly 1 per turn and staying stable across font size, page mode and window width.
- **The pointer belongs to text selection** — drag-to-turn is gone, paging is `←`/`→` or the hover arrows. Highlighting no longer flips the page.
- **Paper-like typography** — 2 em indent, justified with `inter-character`, `line-break: strict`, `text-spacing-trim` / `text-autospace` for CJK–Latin mixing.
- **Custom MOBI/AZW3 parser** — PalmDOC LZ77, HUFF/CDIC, MOBI6 + KF8, EXTH metadata, cover extraction.
- **Annotations** — 6-colour highlights, Word-style marginal comments, side drawer, export to Markdown.

### Downloads

| Build | File | Notes |
|---|---|---|
| Installer | `MoYue-0.1.1-x64.exe` | Per-user install, desktop & Start-menu shortcuts, file associations |
| Portable | `MoYue-0.1.1-portable.exe` | Single executable, no installation |

Windows x64 · unsigned build, so SmartScreen may ask once (*More info → Run anyway*).

### What changed in 0.1.1

- Fixed: EPUB content shifted right and overflowed the window after opening the TOC sidebar (the stage was not re-paginated when only the container width changed).
- New taskbar / window icon (墨).
- **Installer size cut from 98.7 MB to 77 MB**: runtime moved to Electron 40 (Chromium 144), 26 MB of unused WebGPU shader-compiler DLLs dropped, pdf.js pinned to 4.10.38.

### Notes

- Strong-DRM MOBI files are rejected with a clear message.
- Scanned PDFs have no text layer (image-only, no OCR).
- Reading data stays in `%APPDATA%/moyue-reader/`.
