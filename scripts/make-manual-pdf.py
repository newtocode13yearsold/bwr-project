#!/usr/bin/env python3
"""Convert HOWTO.md into a styled manual.pdf under Projet Thomas/manual/."""
import os, re, html
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, HRFlowable, Preformatted)

SRC = os.path.join(os.path.dirname(__file__), "..", "HOWTO.md")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "manual")
os.makedirs(OUT_DIR, exist_ok=True)
OUT = os.path.join(OUT_DIR, "manual.pdf")

INK = colors.HexColor("#1f2937")
GREEN = colors.HexColor("#166534")
GREENBG = colors.HexColor("#dcfce7")
CODEBG = colors.HexColor("#f3f4f6")
LINE = colors.HexColor("#d1d5db")

styles = getSampleStyleSheet()
base = ParagraphStyle("body", parent=styles["Normal"], fontName="Helvetica",
                      fontSize=10, leading=15, textColor=INK, spaceAfter=6)
h1 = ParagraphStyle("h1", parent=base, fontName="Helvetica-Bold", fontSize=20,
                    leading=24, textColor=GREEN, spaceBefore=6, spaceAfter=10)
h2 = ParagraphStyle("h2", parent=base, fontName="Helvetica-Bold", fontSize=14,
                    leading=18, textColor=GREEN, spaceBefore=14, spaceAfter=6)
bullet = ParagraphStyle("bullet", parent=base, leftIndent=14, bulletIndent=2,
                        spaceAfter=3)
quote = ParagraphStyle("quote", parent=base, leftIndent=10, textColor=colors.HexColor("#374151"),
                       fontName="Helvetica-Oblique", backColor=GREENBG,
                       borderPadding=(6, 6, 6, 6), spaceBefore=4, spaceAfter=8)
cell = ParagraphStyle("cell", parent=base, fontSize=8.5, leading=11, spaceAfter=0)
cellhdr = ParagraphStyle("cellhdr", parent=cell, fontName="Helvetica-Bold",
                         textColor=colors.white)


def inline(t):
    t = html.escape(t)
    t = re.sub(r"`([^`]+)`", r'<font face="Courier" size="8.5" backColor="#f3f4f6">\1</font>', t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<b>\1</b>", t)
    return t


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


with open(SRC, encoding="utf-8") as f:
    lines = f.read().split("\n")

flow = []
i = 0
while i < len(lines):
    line = lines[i]
    s = line.strip()

    if s.startswith("```"):
        buf = []
        i += 1
        while i < len(lines) and not lines[i].strip().startswith("```"):
            buf.append(lines[i]); i += 1
        code = "\n".join(buf)
        p = Preformatted(code, ParagraphStyle("code", parent=base,
                         fontName="Courier", fontSize=8.5, leading=11,
                         textColor=INK, backColor=CODEBG, borderPadding=6))
        flow.append(p); flow.append(Spacer(1, 6)); i += 1; continue

    if s.startswith("|") and i + 1 < len(lines) and set(lines[i+1].strip()) <= set("|-: "):
        header = split_row(s)
        i += 2
        rows = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            rows.append(split_row(lines[i])); i += 1
        data = [[Paragraph(inline(c), cellhdr) for c in header]]
        for r in rows:
            data.append([Paragraph(inline(c), cell) for c in r])
        ncol = len(header)
        avail = A4[0] - 36 * mm
        tbl = Table(data, colWidths=[avail / ncol] * ncol, repeatRows=1)
        tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), GREEN),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f9fafb")]),
            ("GRID", (0, 0), (-1, -1), 0.5, LINE),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        flow.append(tbl); flow.append(Spacer(1, 8)); continue

    if s.startswith("# "):
        flow.append(Paragraph(inline(s[2:]), h1))
    elif s.startswith("## "):
        flow.append(Paragraph(inline(s[3:]), h2))
    elif s.startswith("---"):
        flow.append(Spacer(1, 4))
        flow.append(HRFlowable(width="100%", thickness=0.7, color=LINE))
        flow.append(Spacer(1, 4))
    elif s.startswith(">"):
        flow.append(Paragraph(inline(s.lstrip("> ").strip()), quote))
    elif re.match(r"^[-*] ", s):
        flow.append(Paragraph(inline(s[2:]), bullet, bulletText="•"))
    elif s == "":
        pass
    else:
        flow.append(Paragraph(inline(s), base))
    i += 1


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#9ca3af"))
    canvas.drawString(18 * mm, 12 * mm, "BWR — bwrmaps.com — Operator Manual")
    canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, "Page %d" % doc.page)
    canvas.restoreState()


doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                        topMargin=16 * mm, bottomMargin=18 * mm,
                        title="BWR Operator Manual", author="BWR")
doc.build(flow, onFirstPage=footer, onLaterPages=footer)
print("Wrote", os.path.abspath(OUT))
