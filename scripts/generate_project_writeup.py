from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "output" / "pdf" / "automatic-sports-card-listing-technical-writeup-format-match.pdf"
FONT_DIR = (
    Path.home()
    / ".cache"
    / "codex-runtimes"
    / "codex-primary-runtime"
    / "dependencies"
    / "native"
    / "libreoffice-headless"
    / "libreoffice"
    / "LibreOfficeDev.app"
    / "Contents"
    / "Resources"
    / "fonts"
    / "truetype"
)

FONT_SANS = "WriteupSans"
FONT_SANS_BOLD = "WriteupSansBold"
FONT_SANS_ITALIC = "WriteupSansItalic"
FONT_SERIF_BOLD = "WriteupSerifBold"


def register_fonts():
    registrations = [
        (FONT_SANS, FONT_DIR / "LiberationSans-Regular.ttf"),
        (FONT_SANS_BOLD, FONT_DIR / "LiberationSans-Bold.ttf"),
        (FONT_SANS_ITALIC, FONT_DIR / "LiberationSans-Italic.ttf"),
        (FONT_SERIF_BOLD, FONT_DIR / "LiberationSerif-Bold.ttf"),
    ]
    for font_name, font_path in registrations:
        if font_name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(font_name, str(font_path)))


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="TitleBlock",
            parent=styles["Title"],
            fontName=FONT_SERIF_BOLD,
            fontSize=16.2,
            leading=19,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#162032"),
            spaceAfter=2,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SubtitleBlock",
            parent=styles["Normal"],
            fontName=FONT_SANS,
            fontSize=9.6,
            leading=11.6,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#4b5563"),
            spaceAfter=8,
        )
    )
    styles.add(
        ParagraphStyle(
            name="MetaLabel",
            parent=styles["Normal"],
            fontName=FONT_SANS_BOLD,
            fontSize=7.6,
            leading=9.1,
            textColor=colors.HexColor("#6b7280"),
            spaceAfter=0,
        )
    )
    styles.add(
        ParagraphStyle(
            name="MetaValue",
            parent=styles["Normal"],
            fontName=FONT_SANS,
            fontSize=9.45,
            leading=11.7,
            textColor=colors.HexColor("#111827"),
            spaceAfter=0,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SectionHeading",
            parent=styles["Heading2"],
            fontName=FONT_SANS_BOLD,
            fontSize=10.3,
            leading=12.2,
            textColor=colors.HexColor("#111827"),
            spaceBefore=4,
            spaceAfter=3,
        )
    )
    styles.add(
        ParagraphStyle(
            name="Body",
            parent=styles["Normal"],
            fontName=FONT_SANS,
            fontSize=9.15,
            leading=11.3,
            textColor=colors.HexColor("#1f2937"),
            spaceAfter=3,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BodyTight",
            parent=styles["Normal"],
            fontName=FONT_SANS,
            fontSize=8.95,
            leading=11.0,
            textColor=colors.HexColor("#1f2937"),
            spaceAfter=2,
        )
    )
    styles.add(
        ParagraphStyle(
            name="ArchLabel",
            parent=styles["Normal"],
            fontName=FONT_SANS_BOLD,
            fontSize=8.95,
            leading=10.7,
            textColor=colors.HexColor("#111827"),
            spaceAfter=0,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SmallNote",
            parent=styles["Normal"],
            fontName=FONT_SANS_ITALIC,
            fontSize=8.55,
            leading=10.4,
            textColor=colors.HexColor("#4b5563"),
            spaceAfter=4,
        )
    )
    return styles


def meta_table(styles):
    rows = [
        (
            Paragraph("PROJECT", styles["MetaLabel"]),
            Paragraph(
                "Bulk sports card intake, comp research, pricing, and eBay listing workflow for sellers handling many cards at once.",
                styles["MetaValue"],
            ),
        ),
        (
            Paragraph("STACK", styles["MetaLabel"]),
            Paragraph(
                "Node.js (ESM), built-in node:http server, vanilla HTML/CSS/JS, OpenAI Vision GPT-4.1, Apify, eBay Browse and Inventory APIs, Google Drive OAuth, optional Supabase sync.",
                styles["MetaValue"],
            ),
        ),
        (
            Paragraph("PRIMARY GOAL", styles["MetaLabel"]),
            Paragraph(
                "Replace slow card-by-card listing work with a pipeline that extracts metadata, finds comps, recommends prices, and prepares publish-ready inventory records.",
                styles["MetaValue"],
            ),
        ),
    ]
    table = Table(rows, colWidths=[1.28 * inch, 5.55 * inch], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
                ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#d7dde6")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e3e8ef")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return table


def architecture_block(styles, label, value):
    return [
        Paragraph(f"<b>{label}</b>", styles["ArchLabel"]),
        Paragraph(value, styles["BodyTight"]),
        Spacer(1, 1),
    ]


def architecture_table(styles):
    rows = [
        (
            Paragraph("FILE", styles["MetaLabel"]),
            Paragraph("RESPONSIBILITY", styles["MetaLabel"]),
        ),
        (
            Paragraph("src/server.js", styles["ArchLabel"]),
            Paragraph(
                "Bootstraps environment loading, starts the HTTP server, and triggers a best-effort local-to-Supabase sync during startup.",
                styles["BodyTight"],
            ),
        ),
        (
            Paragraph("src/app.js", styles["ArchLabel"]),
            Paragraph(
                "Acts as the application shell: static file serving, API routing, batch and card mutations, review actions, import/export, Drive flows, and eBay publish endpoints.",
                styles["BodyTight"],
            ),
        ),
        (
            Paragraph("src/jobs/pipeline.js", styles["ArchLabel"]),
            Paragraph(
                "Runs the core processing path: OCR extraction, canonical matching, Apify lookup, live-market search, pricing calculation, comp persistence, and audit-event creation.",
                styles["BodyTight"],
            ),
        ),
        (
            Paragraph("src/lib/store.js + src/lib/storage.js", styles["ArchLabel"]),
            Paragraph(
                "Provide local-first persistence with queued state mutations, atomic disk writes, rolling JSON backups, image storage, and optional Supabase mirroring.",
                styles["BodyTight"],
            ),
        ),
        (
            Paragraph("src/services/*.js", styles["ArchLabel"]),
            Paragraph(
                "Keep external concerns modular across OCR, pricing, eBay Browse search, eBay Inventory publishing, Apify sold-comp search, authentication, and Google Drive import/move operations.",
                styles["BodyTight"],
            ),
        ),
    ]
    table = Table(rows, colWidths=[2.05 * inch, 4.78 * inch], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eff3f8")),
                ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#d7dde6")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e3e8ef")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def bullet_list(styles, items):
    return ListFlowable(
        [ListItem(Paragraph(item, styles["BodyTight"])) for item in items],
        bulletType="bullet",
        bulletFontName=FONT_SANS,
        bulletFontSize=7.7,
        bulletColor=colors.HexColor("#111827"),
        leftIndent=12,
        bulletOffsetY=1,
        spaceBefore=0,
        spaceAfter=3,
    )


def draw_page_chrome(canvas, doc):
    canvas.saveState()
    page_width, page_height = letter
    bar_y = page_height - 46
    bar_h = 26
    canvas.setFillColor(colors.HexColor("#1f497d"))
    canvas.rect(doc.leftMargin, bar_y, page_width - doc.leftMargin - doc.rightMargin, bar_h, fill=1, stroke=0)

    canvas.setFont(FONT_SANS_BOLD, 9)
    canvas.setFillColor(colors.white)
    canvas.drawString(doc.leftMargin + 10, bar_y + 9, "Automatic Sports Card Listing")
    canvas.drawRightString(page_width - doc.rightMargin - 10, bar_y + 9, f"Page {doc.page}")

    canvas.setStrokeColor(colors.HexColor("#c7ced8"))
    canvas.setLineWidth(0.75)
    canvas.line(doc.leftMargin, 34, page_width - doc.rightMargin, 34)

    canvas.restoreState()


def build_story(styles):
    story = [
        Spacer(1, 42),
        Paragraph("Automatic Sports Card Listing", styles["TitleBlock"]),
        Paragraph("Technical Portfolio Writeup", styles["SubtitleBlock"]),
        HRFlowable(
            width="26%",
            thickness=0.75,
            color=colors.HexColor("#c7ced8"),
            spaceBefore=0,
            spaceAfter=10,
            hAlign="CENTER",
        ),
        meta_table(styles),
        Spacer(1, 8),
    ]

    story.extend(
        [
            Paragraph("Executive Summary", styles["SectionHeading"]),
            Paragraph(
                "Built a local-first web application that turns raw sports card photos into reviewable inventory records with OCR-assisted extraction, pricing evidence, and listing publication support. The system is structured as a deterministic batch pipeline so a seller can process volume without repeating the same research steps by hand.",
                styles["Body"],
            ),
            Paragraph("Business Problem", styles["SectionHeading"]),
            Paragraph(
                "Manual sports card listing is slow because each item requires several dependent decisions before it can be published. This project codifies that work into a repeatable flow with guardrails for noisy metadata, serialized cards, and ambiguous market-search results.",
                styles["Body"],
            ),
            bullet_list(
                styles,
                [
                    "Batch front/back image intake removes one-at-a-time listing work.",
                    "Metadata extraction combines heuristics, filename hints, and OpenAI vision so the system can still progress when one signal is incomplete.",
                    "Pricing stays anchored to sold comps and only leans on active listings when the market is clearly hotter.",
                    "Review tooling keeps a human in the loop for card details, excluded comps, and final publish decisions.",
                    "eBay and Google Drive integrations extend the workflow beyond research into operational listing management.",
                ],
            ),
            Paragraph("Architecture", styles["SectionHeading"]),
            architecture_table(styles),
            Spacer(1, 6),
            Paragraph("Core Technical Decisions", styles["SectionHeading"]),
            bullet_list(
                styles,
                [
                    "Local JSON state is the default persistence model, which keeps setup lightweight while still allowing optional Supabase sync.",
                    "Manual candidate fields are merged with OCR output so user hints survive imperfect automation instead of being overwritten.",
                    "Serialized cards are priced conservatively: exact print-run comps are preferred, then adjusted comparisons are used only when neighboring serial runs are all that exist.",
                    "Query builders normalize parallel names, rookie labels, autograph hints, and serial denominators so external search results are cleaner and more relevant.",
                    "Audit events plus rotating state backups provide practical recovery points for an inventory workflow with frequent edits.",
                ],
            ),
            Paragraph("Data Flow and Quality Controls", styles["SectionHeading"]),
            Paragraph(
                "The user creates a batch, uploads or imports paired images, and triggers processing. OCR extracts structured fields, matching maps the card into a canonical identity lane, market data is gathered, and the pricing engine returns a recommendation plus evidence snapshots. Each card can then be reviewed in the UI, edited when necessary, and moved into draft or publish flows. The test suite covers OCR heuristics and vision fallbacks, Apify parsing, identity matching, and pricing behavior for edge cases like parallels and numbered cards.",
                styles["Body"],
            ),
            Paragraph("Deployment and Reliability", styles["SectionHeading"]),
            bullet_list(
                styles,
                [
                    "The app runs on a low-dependency Node.js stack with the built-in HTTP server, which keeps local deployment simple and transparent.",
                    "Secrets remain in a root-level .env file, and eBay environment selection supports production or sandbox behavior without code changes.",
                    "Browse and market-heat cache files control repeated network work and help keep the workflow responsive.",
                    "Image and state writes are persisted to disk with recoverable backup snapshots, reducing the blast radius of failed writes or malformed edits.",
                    "Automated tests and linting make it quick to verify core workflow logic after changes.",
                ],
            ),
            Paragraph("Outcome", styles["SectionHeading"]),
            Paragraph(
                "The finished system is a production-style listing assistant for collectors and resellers who need to process inventory in volume. It demonstrates practical workflow automation, multimodal extraction, pricing heuristics, and end-to-end marketplace integration in a single project.",
                styles["Body"],
            ),
            Paragraph(
                "Portfolio value: local-first product design, OCR-plus-human-review workflow design, comp-driven pricing logic, and operational marketplace thinking in one build.",
                styles["SmallNote"],
            ),
        ]
    )
    return story


def main():
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    register_fonts()
    doc = SimpleDocTemplate(
        str(OUTPUT_PATH),
        pagesize=letter,
        leftMargin=0.8 * inch,
        rightMargin=0.8 * inch,
        topMargin=0.72 * inch,
        bottomMargin=0.72 * inch,
        title="Automatic Sports Card Listing Technical Writeup",
        author="OpenAI Codex",
    )
    doc.build(build_story(build_styles()), onFirstPage=draw_page_chrome, onLaterPages=draw_page_chrome)
    print(OUTPUT_PATH)


if __name__ == "__main__":
    main()
