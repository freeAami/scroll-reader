#!/usr/bin/env python3
"""Extract a reflowable, Kindle-style book from the Laws of Human Nature PDF.

Usage: python3 tools/extract.py <input.pdf> <output-dir>

Produces:
  <out>/meta.json          title/author/sections index (with headings for the TOC)
  <out>/sections/NN.json   blocks for each section
  <out>/img/*.jpg|png      cover, title page, chapter ornament
"""
import html
import json
import os
import re
import sys

import pymupdf
from PIL import Image

BODY = 14.4
SMALL = 10.8
SUBHEAD = 16.6
TITLE = 23.8
DROPCAP = 37.4
BREAK = 28.8
LEFT = 72  # body left margin

SKIP_PAGES = set()


def near(a, b, tol=0.3):
    return abs(a - b) < tol


def span_html(spans):
    """Render spans of a line into inline HTML with <em>/<strong>."""
    out = []
    for s in spans:
        t = s["text"]
        if not t:
            continue
        f = s["font"]
        it = "Italic" in f
        bd = "Bold" in f
        out.append([it, bd, t])
    return out


def merge_runs(runs):
    """runs: list of (it, bd, text). Merge adjacent runs with same style."""
    merged = []
    for it, bd, t in runs:
        if merged and merged[-1][0] == it and merged[-1][1] == bd:
            merged[-1][2] += t
        else:
            merged.append([it, bd, t])
    return merged


def plain_text(runs):
    return html.escape(re.sub(r"\s+", " ", "".join(r[2] for r in runs))).strip()


def runs_to_html(runs):
    parts = []
    for it, bd, t in merge_runs(runs):
        t = html.escape(t)
        if it:
            t = f"<em>{t}</em>"
        if bd:
            t = f"<strong>{t}</strong>"
        parts.append(t)
    s = "".join(parts)
    s = re.sub(r"</em>(\s*)<em>", r"\1", s)
    s = re.sub(r"</strong>(\s*)<strong>", r"\1", s)
    return s.strip()


def block_runs(block):
    """Join the lines of a block into runs, handling line joins/hyphens."""
    runs = []
    for i, line in enumerate(block["lines"]):
        lr = span_html(line["spans"])
        if not lr:
            continue
        if runs:
            prev = runs[-1][2]
            if prev.endswith("-") and not prev.endswith(" -"):
                pass  # hard hyphen: join directly
            else:
                runs[-1][2] = prev + " "
        runs.extend(lr)
    # collapse whitespace
    for r in runs:
        r_text = re.sub(r"[ \t]+", " ", r[2])
        r[2] = r_text
    return runs


def block_text(block):
    return "".join(s["text"] for l in block["lines"] for s in l["spans"]).strip()


def block_size(block):
    sizes = {}
    for l in block["lines"]:
        for s in l["spans"]:
            sizes[round(s["size"], 1)] = sizes.get(round(s["size"], 1), 0) + len(s["text"])
    return max(sizes, key=sizes.get) if sizes else 0


def block_fonts(block):
    return {s["font"] for l in block["lines"] for s in l["spans"] if s["text"].strip()}


def main(pdf_path, out_dir):
    doc = pymupdf.open(pdf_path)
    os.makedirs(os.path.join(out_dir, "sections"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "img"), exist_ok=True)

    # ---- images -------------------------------------------------------
    def save_img(page_no, name, max_w, fmt="JPEG", quality=82):
        img = doc[page_no].get_images()[0]
        pix = pymupdf.Pixmap(doc, img[0])
        if pix.n > 4:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        tmp = os.path.join(out_dir, "img", "_tmp.png")
        pix.save(tmp)
        im = Image.open(tmp).convert("RGB")
        if im.width > max_w:
            im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
        path = os.path.join(out_dir, "img", name)
        im.save(path, fmt, quality=quality, optimize=True)
        os.remove(tmp)
        return im.width, im.height

    cover_size = save_img(0, "cover.jpg", 900)
    save_img(2, "title.jpg", 900)
    save_img(21, "ornament.png", 1200, fmt="PNG")

    # ---- walk pages -> flat list of elements ----------------------------
    sections = []

    def new_section(kind, title, number=None, subtitle=None):
        sec = {
            "id": f"s{len(sections):02d}",
            "kind": kind,
            "title": title,
            "number": number,
            "subtitle": subtitle,
            "blocks": [],
        }
        sections.append(sec)
        return sec

    cur = new_section("cover", "Cover")
    cur["blocks"].append({"t": "img", "src": "img/cover.jpg", "w": cover_size[0], "h": cover_size[1], "alt": "Cover"})

    pending_dropcap = None
    prev_body = None  # last body paragraph block dict (for cross-page merge)
    prev_body_page = -1
    skipping_index = False

    for pno in range(len(doc)):
        page = doc[pno]
        if pno in (0, 3, 689):
            continue
        if pno == 2:
            s = new_section("front", "Title Page")
            s["blocks"].append({"t": "img", "src": "img/title.jpg", "w": 900, "h": 1360, "alt": "Title page"})
            continue
        blocks = []
        for b in page.get_text("dict")["blocks"]:
            if b["type"] != 0:
                continue
            line_sizes = {round(l["spans"][0]["size"], 1) for l in b["lines"] if l["spans"]}
            if len(line_sizes) > 1 and any(sz > BODY + 1 for sz in line_sizes):
                for l in b["lines"]:
                    blocks.append({"bbox": l["bbox"], "lines": [l]})
            else:
                blocks.append(b)
        # reading order: by y, then x (drop caps come out of order)
        blocks.sort(key=lambda b: (round(b["bbox"][1]), b["bbox"][0]))
        first_text_block = True
        for b in blocks:
            txt = block_text(b)
            if not txt:
                continue
            size = block_size(b)
            fonts = block_fonts(b)
            x0 = b["lines"][0]["bbox"][0]
            x1 = b["bbox"][2]
            nlines = len(b["lines"])
            bold = any("Bold" in f for f in fonts)
            italic = all("Italic" in f for f in fonts)

            # ----- skip TOC + index pages -----
            if near(size, 20.2) and txt == "Contents":
                skipping_index = "contents"
                continue
            if skipping_index == "contents":
                if near(size, TITLE):
                    skipping_index = False
                else:
                    continue
            if near(size, TITLE) and bold and txt == "Index":
                skipping_index = "index"
                continue
            if skipping_index == "index":
                if near(size, TITLE) and bold:
                    skipping_index = False
                else:
                    continue
            if near(size, SUBHEAD) and txt.startswith("A B C D E F"):
                continue

            # ----- structure -----
            if near(size, DROPCAP):
                pending_dropcap = txt
                continue
            if near(size, BREAK) and txt == "—":
                cur["blocks"].append({"t": "hr"})
                continue
            if txt.replace(" ", "") == "•••":
                cur["blocks"].append({"t": "hr"})
                continue
            if near(size, SUBHEAD) and bold and txt.isdigit():
                cur = new_section("chapter", "", number=int(txt))
                continue
            if near(size, TITLE) and bold:
                if cur["kind"] == "chapter" and cur["title"] == "":
                    cur["title"] = txt
                    cur["_tpage"] = pno
                elif cur["kind"] == "chapter" and not cur["subtitle"] and not cur["blocks"] and cur.get("_tpage") == pno:
                    cur["title"] += " " + txt
                else:
                    cur = new_section("part", txt)
                continue
            if near(size, TITLE) and italic:
                cur["subtitle"] = txt
                continue
            if near(size, SUBHEAD) and bold:
                cur["blocks"].append({"t": "h2", "html": plain_text(block_runs(b))})
                prev_body = None
                continue
            if near(size, SUBHEAD) and italic:
                cur["blocks"].append({"t": "h3", "html": plain_text(block_runs(b))})
                prev_body = None
                continue
            # centered bold 14.4 single line -> h2 (may wrap onto a second block)
            if near(size, BODY) and nlines == 1 and fonts == {"Georgia-Bold"} and x0 > 80:
                if cur["blocks"] and cur["blocks"][-1]["t"] == "h2" and cur["blocks"][-1].get("_page") == pno \
                        and cur["blocks"][-1].get("_cont"):
                    cur["blocks"][-1]["html"] += " " + plain_text(block_runs(b))
                else:
                    cur["blocks"].append({"t": "h2", "html": plain_text(block_runs(b)), "_page": pno, "_cont": True})
                prev_body = None
                continue
            if near(size, SMALL) or near(size, 8.6):
                # epigraph / quote or front matter
                if cur["kind"] in ("front",) or pno in (1, 4):
                    if pno == 1 and cur["title"] != "Also by Robert Greene":
                        cur = new_section("front", "Also by Robert Greene")
                        continue  # the heading itself
                    if pno == 4 and cur["title"] != "Copyright":
                        cur = new_section("front", "Copyright")
                    cur["blocks"].append({"t": "small", "html": runs_to_html(block_runs(b))})
                else:
                    if txt.startswith("—"):
                        cur["blocks"].append({"t": "cite", "html": runs_to_html(block_runs(b))})
                    else:
                        cur["blocks"].append({"t": "quote", "html": runs_to_html(block_runs(b))})
                prev_body = None
                continue
            if pno == 5:
                cur = new_section("front", "Dedication")
                cur["blocks"].append({"t": "center", "html": runs_to_html(block_runs(b))})
                continue
            if pno == 1:
                if cur["title"] != "Also by Robert Greene":
                    cur = new_section("front", "Also by Robert Greene")
                continue

            # ----- body paragraph -----
            runs = block_runs(b)
            if pending_dropcap:
                it0, bd0 = (runs[0][0], runs[0][1]) if runs else (False, False)
                runs.insert(0, [it0, bd0, pending_dropcap])
                pending_dropcap = None
                runs = merge_runs(runs)
            html_text = runs_to_html(runs)
            indented = x0 > LEFT + 5
            is_centered = x0 > 150 and nlines == 1
            if is_centered:
                cur["blocks"].append({"t": "center", "html": html_text})
                prev_body = None
                continue
            continuation = (
                prev_body is not None
                and prev_body_page == pno - 1
                and first_text_block
                and not indented
                and not pending_dropcap
                and prev_body.get("_x1", 0) > 300
            )
            if continuation:
                joiner = "" if prev_body["html"].endswith("-") else " "
                prev_body["html"] = prev_body["html"] + joiner + html_text
                prev_body["html"] = re.sub(r"</em> <em>", " ", prev_body["html"])
                prev_body["_x1"] = b["lines"][-1]["bbox"][2]
                prev_body_page = pno
            else:
                blk = {"t": "p", "html": html_text, "_x1": b["lines"][-1]["bbox"][2]}
                cur["blocks"].append(blk)
                prev_body = blk
                prev_body_page = pno
            first_text_block = False
        # end of page

    # ---- clean up + write ----------------------------------------------
    meta_sections = []
    total_chars = 0
    for i, sec in enumerate(sections):
        chars = 0
        headings = []
        for j, blk in enumerate(sec["blocks"]):
            blk.pop("_x1", None)
            blk.pop("_page", None)
            blk.pop("_cont", None)
            if "html" in blk:
                plain = re.sub(r"<[^>]+>", "", blk["html"])
                chars += len(plain)
                if blk["t"] in ("h2", "h3"):
                    headings.append({"b": j, "t": blk["t"], "text": html.unescape(plain)})
        sec["chars"] = chars
        sec.pop("_tpage", None)
        total_chars += chars
        fname = f"sections/{i:02d}.json"
        with open(os.path.join(out_dir, fname), "w") as f:
            json.dump(sec, f, ensure_ascii=False)
        meta_sections.append({
            "id": sec["id"],
            "kind": sec["kind"],
            "title": sec["title"],
            "number": sec["number"],
            "subtitle": sec["subtitle"],
            "file": fname,
            "chars": chars,
            "blocks": len(sec["blocks"]),
            "headings": headings,
        })

    meta = {
        "title": "The Laws of Human Nature",
        "author": "Robert Greene",
        "cover": "img/cover.jpg",
        "totalChars": total_chars,
        "sections": meta_sections,
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(f"{len(sections)} sections, {total_chars} chars")
    for s in meta_sections:
        print(f"  {s['id']} {s['kind']:8} {s['number'] or '':>2} {s['title'][:45]:45} {s['chars']:>7} chars {s['blocks']:>4} blocks {len(s['headings'])} heads")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
