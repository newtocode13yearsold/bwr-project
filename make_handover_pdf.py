# -*- coding: utf-8 -*-
"""Generate a beginner-friendly handover checklist PDF for the BWR website sale."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER

# ---- Colours ----
GREEN = colors.HexColor("#22c55e")
DARK = colors.HexColor("#14532d")
GREY = colors.HexColor("#475569")
LIGHT = colors.HexColor("#f0fdf4")
BORDER = colors.HexColor("#bbf7d0")

styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    "TitleBig", parent=styles["Title"], fontSize=26, textColor=DARK,
    spaceAfter=4, alignment=TA_CENTER, leading=30,
)
subtitle_style = ParagraphStyle(
    "Sub", parent=styles["Normal"], fontSize=11, textColor=GREY,
    alignment=TA_CENTER, spaceAfter=2,
)
section_style = ParagraphStyle(
    "Section", parent=styles["Heading2"], fontSize=14, textColor=colors.white,
    spaceBefore=14, spaceAfter=8, leftIndent=6, leading=18,
)
step_title_style = ParagraphStyle(
    "StepTitle", parent=styles["Heading3"], fontSize=12, textColor=DARK,
    spaceBefore=8, spaceAfter=2, leading=15,
)
body_style = ParagraphStyle(
    "Body", parent=styles["Normal"], fontSize=10.5, textColor=colors.HexColor("#1e293b"),
    leading=15, spaceAfter=4,
)
note_style = ParagraphStyle(
    "Note", parent=styles["Normal"], fontSize=9.5, textColor=GREY,
    leading=13, spaceAfter=4, leftIndent=4,
)
warn_style = ParagraphStyle(
    "Warn", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#7c2d12"),
    leading=14,
)


def section_header(text):
    """A green bar section header."""
    t = Table([[Paragraph(text, section_style)]], colWidths=[170 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ROUNDEDCORNERS", [4, 4, 4, 4]),
    ]))
    return t


def checkbox_step(number, title, lines):
    """A single numbered step with a checkbox, title, and body lines."""
    inner = [Paragraph(f"<b>Step {number}: {title}</b>", step_title_style)]
    for ln in lines:
        inner.append(Paragraph(ln, body_style))
    box = Table(
        [["☐", inner]],
        colWidths=[12 * mm, 158 * mm],
    )
    box.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTSIZE", (0, 0), (0, 0), 20),
        ("TEXTCOLOR", (0, 0), (0, 0), GREEN),
        ("TOPPADDING", (0, 0), (0, 0), 2),
        ("LEFTPADDING", (1, 0), (1, 0), 4),
    ]))
    return box


def callout(text, bg, border, txt_style):
    t = Table([[Paragraph(text, txt_style)]], colWidths=[170 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 1, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


story = []

# ---- Title ----
story.append(Paragraph("BWR Website &mdash; Handover Checklist", title_style))
story.append(Paragraph("Everything the new owner needs to do, in order, to take over the site", subtitle_style))
story.append(Paragraph("BWR = Biking, Walking, Running &mdash; the maps that make your life easier", subtitle_style))
story.append(Spacer(1, 6))
story.append(HRFlowable(width="100%", thickness=1.2, color=BORDER))
story.append(Spacer(1, 8))

# ---- Intro ----
story.append(callout(
    "<b>Welcome!</b> This website is not one single file &mdash; it is made of a few parts that all work "
    "together. Follow the steps below <b>in order</b> and tick each box as you finish. By the end, the "
    "website will be fully yours and running on your own accounts.",
    LIGHT, BORDER, body_style,
))
story.append(Spacer(1, 6))

# ---- What you are receiving ----
story.append(section_header("What you are receiving"))
parts = [
    ["Part", "What it is"],
    ["The code", "All the files the website is built from (kept on GitHub)."],
    ["Cloudflare", "The online service that runs the website."],
    ["The saved data (KV)", "All users, map paths and reports the site has stored."],
    ["The domain", "The web address people type to visit the site."],
    ["Service accounts", "Outside helpers for emails and maps (you make your own)."],
]
tbl = Table(parts, colWidths=[45 * mm, 125 * mm])
tbl.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), DARK),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTSIZE", (0, 0), (-1, -1), 10),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
    ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
]))
story.append(tbl)

# ---- The steps ----
story.append(section_header("Do these steps in order"))

steps = [
    ("Get the code (GitHub)", [
        "Make a free account at <b>github.com</b> if you don't have one.",
        "Ask the seller to <b>transfer the project (repository)</b> to your GitHub account, or to send you a download (a ZIP file).",
        "<i>This is the box of building blocks the whole website is made of.</i>",
    ]),
    ("Make your Cloudflare account", [
        "Go to <b>cloudflare.com</b> and create a free account.",
        "This is the service that actually runs the website online (it's called a “Worker”).",
        "<i>Tip: use an email and password you control and will keep.</i>",
    ]),
    ("Install the tools on your computer", [
        "Install <b>Node.js</b> from <b>nodejs.org</b> (this lets you run the website's commands).",
        "Open the project folder, then in a terminal type: <font face='Courier'>npm install</font>",
        "<i>This downloads the extra pieces the project needs.</i>",
    ]),
    ("Create your storage (KV)", [
        "In the terminal, run: <font face='Courier'>npm run kv:create BWR_KV</font>",
        "This creates the “memory” where users and map paths are saved.",
        "Copy the ID it gives you into the file <font face='Courier'>wrangler.jsonc</font> (the seller can show you where).",
    ]),
    ("Get your own secret keys", [
        "<b>Maps:</b> sign up at <b>openrouteservice.org</b> and copy your key (called ORS_KEY).",
        "<b>Emails:</b> sign up at <b>resend.com</b> and copy your key (called RESEND_API_KEY).",
        "<b>Emails (sender address):</b> in Resend, verify your domain, then set the sender as RESEND_FROM, "
        "for example <font face='Courier'>BWR &lt;noreply@yoursite.com&gt;</font>. The address MUST use a "
        "domain you have verified in Resend, or emails will silently fail to send.",
        "Add them with: <font face='Courier'>npx wrangler secret put ORS_KEY</font> "
        "(then the same for <font face='Courier'>RESEND_API_KEY</font> and <font face='Courier'>RESEND_FROM</font>).",
        "<i>Use YOUR OWN keys &mdash; never the seller's &mdash; so any costs go to you, not them.</i>",
    ]),
    ("Put the website online", [
        "In the terminal, run: <font face='Courier'>npm run deploy:worker</font>",
        "Cloudflare will give you a web address ending in <font face='Courier'>.workers.dev</font>.",
        "Open that address in your browser &mdash; your copy of the site is now live!",
    ]),
    ("Move the saved data over", [
        "If you want the existing users, paths and reports, ask the seller to <b>export the data</b> from their storage and give it to you.",
        "Import it into your own storage (the seller or a developer can run a short script for this).",
        "<i>Skip this only if you want to start completely fresh and empty.</i>",
    ]),
    ("Become the admin", [
        "If you started fresh: open <font face='Courier'>/api/setup</font> once to create your admin account.",
        "If you took over the seller's data: ask the seller for the existing admin login.",
        "<i>The admin can draw paths, manage reports and change user plans.</i>",
    ]),
    ("Connect your web address (domain)", [
        "If a custom address (like <font face='Courier'>yoursite.com</font>) is included, have the seller <b>transfer the domain</b> to you.",
        "Point it at your Cloudflare Worker (Cloudflare has a guide for this).",
        "Update <font face='Courier'>API_URL</font> in <font face='Courier'>js/config.js</font> to match your address.",
    ]),
    ("Final check &mdash; test everything", [
        "Open the site and try to: register a new account, log in, and plan a route.",
        "Report a fake problem and check it appears for the admin.",
        "Send a test email (registration) and confirm it arrives.",
        "<i>No email? It's almost always RESEND_FROM (Step 5): the sender address must use a domain "
        "you've verified in Resend, otherwise emails fail silently with no error.</i>",
        "<i>If all of these work, the handover is complete. ✓</i>",
    ]),
]

for i, (title, lines) in enumerate(steps, start=1):
    story.append(checkbox_step(i, title, lines))
    story.append(Spacer(1, 2))

# ---- Warnings ----
story.append(Spacer(1, 6))
story.append(section_header("Important things to know"))
story.append(callout(
    "<b>&#9888; Other people's private data.</b> This website stores real users' email addresses and "
    "passwords. Looking after other people's private information is a legal responsibility (especially in "
    "France/EU). Keep it safe, don't share it, and tell users if the owner changes.",
    colors.HexColor("#fff7ed"), colors.HexColor("#fdba74"), warn_style,
))
story.append(Spacer(1, 6))
story.append(callout(
    "<b>&#9888; Never reuse the seller's secret keys.</b> Always create your own (Step 5). Otherwise the "
    "seller could still control parts of your site, or get billed for your usage.",
    colors.HexColor("#fff7ed"), colors.HexColor("#fdba74"), warn_style,
))
story.append(Spacer(1, 6))
story.append(callout(
    "<b>&#10003; Get it in writing.</b> Before money changes hands, write a simple agreement listing exactly "
    "what is included: the code, the domain, the data and the accounts. This protects both of you.",
    LIGHT, BORDER, body_style,
))

# ---- Footer note ----
story.append(Spacer(1, 10))
story.append(HRFlowable(width="100%", thickness=1, color=BORDER))
story.append(Spacer(1, 4))
story.append(Paragraph(
    "Need help with a step? The seller can run the data export/import and show you the exact files to edit. "
    "Take it one box at a time &mdash; you've got this!",
    note_style,
))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(GREY)
    canvas.drawCentredString(A4[0] / 2, 12 * mm,
                             "BWR Website Handover Checklist  —  follow the steps in order")
    canvas.restoreState()


doc = SimpleDocTemplate(
    "BWR-Handover-Checklist.pdf", pagesize=A4,
    leftMargin=20 * mm, rightMargin=20 * mm,
    topMargin=18 * mm, bottomMargin=20 * mm,
    title="BWR Website Handover Checklist",
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("PDF created: BWR-Handover-Checklist.pdf")
