# Scroll Reader — *The Laws of Human Nature*

A Kindle-style reading web app (works in Chrome and on iPhone Safari, installable as a PWA) that turns the PDF into a continuous, reflowable scroll-to-read book.

## Features
- Continuous vertical scrolling through the whole book; chrome auto-hides while you read
- Light / Sepia / Green / Dark / Black themes, brightness slider
- Font family (Literata, Georgia, Palatino, Sans, Atkinson Hyperlegible), size, weight, line spacing, margins, justification, hyphenation
- Generated table of contents (chapters + sub-headings) with per-chapter progress
- Progress bar + scrubber, Kindle-style "Loc", % read, time left in chapter / book (learns your reading speed)
- Bookmarks, colour highlights, notes, copy, dictionary lookup on selected text; export everything as Markdown
- Full-text search with context snippets
- Reading position, settings, bookmarks and highlights saved locally (no account, no server)
- Auto-scroll, keyboard shortcuts, optional tap-edge paging, keep-screen-awake, fullscreen
- Offline after first load (service worker)

## Run locally
```
python3 -m http.server 8787 --directory site
```
Open http://localhost:8787/

## Re-extract from the PDF
```
pip install pymupdf
python3 tools/extract.py "The Laws of Human Nature.pdf" site/book
```

## Deploy
Static site — publish the `site/` folder (Netlify config included).
