import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            super().showPage()
        super().save()

    def draw_page_decorations(self, page_count):
        self.saveState()
        self.setFont("Helvetica", 9)
        self.setFillColor(colors.HexColor("#4A5568"))

        # Header (pages > 1)
        if self._pageNumber > 1:
            self.drawString(
                54,
                750,
                "VARUNA — Project Prototype Technical Architecture & Algorithm Guide",
            )
            self.setStrokeColor(colors.HexColor("#CBD5E0"))
            self.setLineWidth(0.5)
            self.line(54, 742, 558, 742)

        # Footer
        page_str = f"Page {self._pageNumber} of {page_count}"
        self.drawRightString(558, 36, page_str)
        self.drawString(54, 36, "CONFIDENTIAL & PROPRIETARY — VARUNA SIH26143")
        self.setStrokeColor(colors.HexColor("#CBD5E0"))
        self.setLineWidth(0.5)
        self.line(54, 48, 558, 48)
        self.restoreState()


def build_pdf(filename):
    doc = SimpleDocTemplate(
        filename,
        pagesize=letter,
        leftMargin=54,
        rightMargin=54,
        topMargin=54,
        bottomMargin=54,
    )

    styles = getSampleStyleSheet()

    # Custom styles
    primary_color = colors.HexColor("#1A365D")  # Navy
    secondary_color = colors.HexColor("#2B6CB0")  # Medium Blue
    dark_neutral = colors.HexColor("#2D3748")
    light_bg = colors.HexColor("#F7FAFC")
    border_color = colors.HexColor("#E2E8F0")

    title_style = ParagraphStyle(
        "DocTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=24,
        leading=28,
        textColor=primary_color,
        alignment=0,
        spaceAfter=8,
    )

    subtitle_style = ParagraphStyle(
        "DocSubTitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=12,
        leading=16,
        textColor=secondary_color,
        spaceAfter=20,
    )

    h1_style = ParagraphStyle(
        "H1",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=20,
        textColor=primary_color,
        spaceBefore=16,
        spaceAfter=10,
        keepWithNext=True,
    )

    h2_style = ParagraphStyle(
        "H2",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=16,
        textColor=secondary_color,
        spaceBefore=12,
        spaceAfter=6,
        keepWithNext=True,
    )

    body_style = ParagraphStyle(
        "Body",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        textColor=dark_neutral,
        spaceAfter=8,
    )

    bullet_style = ParagraphStyle(
        "Bullet", parent=body_style, leftIndent=15, firstLineIndent=-10, spaceAfter=4
    )

    code_style = ParagraphStyle(
        "CodeBlock",
        parent=styles["Normal"],
        fontName="Courier",
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#1A202C"),
        backColor=colors.HexColor("#EDF2F7"),
        borderColor=border_color,
        borderWidth=1,
        borderPadding=8,
        spaceBefore=6,
        spaceAfter=8,
    )

    callout_style = ParagraphStyle(
        "Callout",
        parent=body_style,
        fontName="Helvetica-Oblique",
        fontSize=9.5,
        leading=13.5,
        textColor=colors.HexColor("#2C5282"),
        backColor=colors.HexColor("#EBF8FF"),
        borderColor=colors.HexColor("#3182CE"),
        borderWidth=1,
        borderPadding=8,
        spaceBefore=8,
        spaceAfter=10,
    )

    table_header_style = ParagraphStyle(
        "TableHeader",
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=11,
        textColor=colors.white,
        alignment=1,
    )

    table_body_style = ParagraphStyle(
        "TableBody",
        fontName="Helvetica",
        fontSize=8.5,
        leading=11,
        textColor=dark_neutral,
    )

    story = []

    # Title Banner
    story.append(Paragraph("VARUNA Project Prototype Technical Guide", title_style))
    story.append(
        Paragraph(
            "Vessel Attribution through Remote-sensing & Unified Navigational Analytics<br/><b>Smart India Hackathon 2026 — Problem Statement SIH26143</b>",
            subtitle_style,
        )
    )
    story.append(
        HRFlowable(width="100%", thickness=2, color=primary_color, spaceAfter=15)
    )

    # Executive Summary
    story.append(Paragraph("Executive Summary", h1_style))
    story.append(
        Paragraph(
            "<b>VARUNA</b> is an end-to-end automated system designed to detect satellite-observed ocean oil spills, "
            "backtrack their physical origin using real ocean currents and atmospheric winds, correlate them against real "
            "AIS vessel trajectories, and produce a statistically sound, fully explainable vessel attribution dossier. "
            "This document details every function, algorithm, decision mechanism, mathematical equation, and data flow.",
            body_style,
        )
    )

    # 1. System Pipeline Overview
    story.append(Paragraph("1. System Pipeline Architecture", h1_style))
    story.append(
        Paragraph(
            "The system operates across six sequential modules. Zero fake, synthetic, or mock data is used; "
            "every single data object carries an explicit provenance record.",
            body_style,
        )
    )

    pipeline_data = [
        [
            Paragraph("Stage", table_header_style),
            Paragraph("Module Name", table_header_style),
            Paragraph("Core Technology / Function", table_header_style),
            Paragraph("Output Artifact", table_header_style),
        ],
        [
            Paragraph("1", table_body_style),
            Paragraph("Satellite Ingestion", table_body_style),
            Paragraph("GDAL Range Requests on STAC (MPC)", table_body_style),
            Paragraph("Cloud-Optimized GeoTIFF (COG)", table_body_style),
        ],
        [
            Paragraph("2", table_body_style),
            Paragraph("Dark-Spot Detection", table_body_style),
            Paragraph("Adaptive Local Thresholding + Risk Scoring", table_body_style),
            Paragraph("GeoJSON Polygons & Metrics", table_body_style),
        ],
        [
            Paragraph("3", table_body_style),
            Paragraph("Drift Back-tracking", table_body_style),
            Paragraph("Lagrangian 5,000 Particle Dispersion + KDE", table_body_style),
            Paragraph("50%/90% Density Contours", table_body_style),
        ],
        [
            Paragraph("4", table_body_style),
            Paragraph("AIS Reconstruction", table_body_style),
            Paragraph("Track Interpolation & Transponder Dark Check", table_body_style),
            Paragraph("Buffered GeoJSON Lines", table_body_style),
        ],
        [
            Paragraph("5", table_body_style),
            Paragraph("Vessel Attribution", table_body_style),
            Paragraph("12-Feature Renormalized Weighting Model", table_body_style),
            Paragraph("Ranked Candidate Scores", table_body_style),
        ],
        [
            Paragraph("6", table_body_style),
            Paragraph("Monte Carlo Audit", table_body_style),
            Paragraph("Bootstrap CI & Common-Mode Resampling", table_body_style),
            Paragraph("Separation Verdict & CI Bounds", table_body_style),
        ],
    ]
    t_pipeline = Table(pipeline_data, colWidths=[35, 110, 210, 149])
    t_pipeline.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), primary_color),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("GRID", (0, 0), (-1, -1), 0.5, border_color),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, light_bg]),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(t_pipeline)
    story.append(Spacer(1, 12))

    # 2. Ingestion & Radiometry
    story.append(Paragraph("2. Ingestion & Radiometry Processing", h1_style))
    story.append(
        Paragraph("<b>2.1 Windowed Satellite Ingestion (ingest_scene)</b>", h2_style)
    )
    story.append(
        Paragraph(
            "Located in <code>varuna_ml/ingest/preprocess.py</code>. Fetches radar imagery for an Area of Interest (AOI) "
            "directly from Microsoft Planetary Computer without downloading full satellite swaths (~2 GB down to ~15 MB). "
            "It uses GDAL HTTP Range Requests to pull only the GeoTIFF tiles covering the requested AOI and writes Cloud-Optimized GeoTIFFs (COGs) to MinIO/S3.",
            body_style,
        )
    )

    story.append(
        Paragraph(
            "<b>2.2 Operator Upload Radiometry Validation (probe_radiometry)</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "Located in <code>varuna_ml/ingest/adopt.py</code>. Probes value distributions of custom GeoTIFF uploads:",
            body_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Linear Sigma0 (Valid):</b> Values 0.0 to 5.0. Accepted directly for backscatter detection.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Decibels dB (Rejected):</b> Values < 0 dB (e.g. -25 to -5 dB). Detector converts to dB internally; uploading dB imagery causes double-logarithm errors.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Uncalibrated DN (Rejected):</b> Values > 5.0 or 8-bit integers (0-255). Standard images/quicklooks lack calibrated radar physics.",
            bullet_style,
        )
    )

    # 3. Dark Spot Detection
    story.append(Paragraph("3. Dark-Spot (Oil Slick) Detection Engine", h1_style))
    story.append(
        Paragraph("<b>3.1 Linear Backscatter to Decibels (to_db)</b>", h2_style)
    )
    story.append(
        Paragraph(
            "Formula: <i>dB = 10 * log10(sigma0)</i>. Oil damps short capillary waves, causing strong negative backscatter contrast.",
            body_style,
        )
    )

    story.append(
        Paragraph(
            "<b>3.2 Hybrid Land Masking (land_mask_from_backscatter & coastline_mask)</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "Located in <code>varuna_ml/detect/landmask.py</code>. Bright land (> -8 dB) is masked alongside Natural Earth 10m vector land polygons. "
            "A deliberate <b>500m land buffer</b> is grown outward into the water to absorb coastline vector error, protecting against near-shore false positives.",
            body_style,
        )
    )

    story.append(
        Paragraph("<b>3.3 Adaptive Local Segmentation (segment)</b>", h2_style)
    )
    story.append(
        Paragraph(
            "Downsamples the scene by 32x, applies a 9x9 median filter to estimate local sea background intensity (bg), "
            "interpolates back to full resolution, and flags dark pixels: <i>DarkPixel = (db < bg - contrast_db)</i> (default 3.0 dB).",
            body_style,
        )
    )

    story.append(Paragraph("<b>3.4 Morphological Cleanup & Risk Scoring</b>", h2_style))
    story.append(
        Paragraph(
            "Applies morphological opening (r=2) to remove speckle, closing (r=4) to join slick fragments, and drops regions < 500 px (0.05 km²). "
            "Scores look-alike risk using elongation, convexity, contrast, and area, gated by wind speed suitability (4-9 m/s optimal).",
            body_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Confidence Equation:</b><br/>"
            "<code>Confidence = 0.40*ContrastTerm + 0.35*(1-Risk) + 0.15*WindTerm + 0.10*SizeTerm</code>",
            code_style,
        )
    )

    # 4. Backward Drift Simulation
    story.append(Paragraph("4. Backward Lagrangian Drift Simulation", h1_style))
    story.append(
        Paragraph(
            "Located in <code>varuna_ml/drift/backtrack.py</code>. Backward particle tracking runs 5,000 particles backwards in time (-15 min timesteps) "
            "from the slick footprint to calculate a probability surface of where the spill originated.",
            body_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Particle Velocity Equation:</b><br/>"
            "<code>dx/dt = u_current + alpha * R(theta) * u_wind + RandomWalk(Kh)</code><br/>"
            "• <b>alpha (Wind Drift):</b> Sampled per particle ~ U(0.02, 0.04) [2-4% of wind speed]<br/>"
            "• <b>theta (Ekman Deflection):</b> Sampled per particle ~ U(0°, 20°) [Right in NH, Left in SH]<br/>"
            "• <b>Kh (Horizontal Diffusivity):</b> 10 m²/s (Random walk sigma = sqrt(2 * Kh * dt))",
            code_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Bilinear Coastal Renormalization:</b> In ocean models, land cells are NaN. Standard samplers return NaN when touching a single land cell, "
            "reducing near-shore current to 0 m/s. VARUNA's sampler renormalizes weights strictly over finite (wet) grid nodes, preserving true near-shore velocities.",
            body_style,
        )
    )

    # 5. Multi-Feature Vessel Attribution
    story.append(Paragraph("5. 12-Feature Vessel Attribution Engine", h1_style))
    story.append(
        Paragraph(
            "Located in <code>apps/api/src/modules/attribution/features.ts</code>. Scores vessel candidates across 12 explainable features.",
            body_style,
        )
    )

    feat_data = [
        [
            Paragraph("Key", table_header_style),
            Paragraph("Feature Name", table_header_style),
            Paragraph("W", table_header_style),
            Paragraph("Mathematical Logic & Condition", table_header_style),
        ],
        [
            Paragraph("F1", table_body_style),
            Paragraph("Spatial Proximity", table_body_style),
            Paragraph("0.18", table_body_style),
            Paragraph(
                "exp(-d / 8) where d is km distance to origin zone.", table_body_style
            ),
        ],
        [
            Paragraph("F2", table_body_style),
            Paragraph("Temporal Alignment", table_body_style),
            Paragraph("0.16", table_body_style),
            Paragraph(
                "Fraction of vessel fixes inside release window.", table_body_style
            ),
        ],
        [
            Paragraph("F3", table_body_style),
            Paragraph("Track Intersection", table_body_style),
            Paragraph("0.14", table_body_style),
            Paragraph(
                "1.0 if track crosses origin zone, else 1/(1 + d/3).", table_body_style
            ),
        ],
        [
            Paragraph("F4", table_body_style),
            Paragraph("Heading Alignment", table_body_style),
            Paragraph("0.10", table_body_style),
            Paragraph(
                "cos²(angle_diff) vs slick axis. (N/A if elongation < 2.5).",
                table_body_style,
            ),
        ],
        [
            Paragraph("F5", table_body_style),
            Paragraph("AIS Dark Period", table_body_style),
            Paragraph("0.10", table_body_style),
            Paragraph(
                "Transponder silence in window: min(1, gap / 120 min).",
                table_body_style,
            ),
        ],
        [
            Paragraph("F6", table_body_style),
            Paragraph("Speed Consistency", table_body_style),
            Paragraph("0.08", table_body_style),
            Paragraph(
                "Optimal for discharge underway (4 - 14 knots).", table_body_style
            ),
        ],
        [
            Paragraph("F7", table_body_style),
            Paragraph("Vessel Type Prior", table_body_style),
            Paragraph("0.07", table_body_style),
            Paragraph(
                "Tanker=1.0, Cargo=0.7, Fishing/Tug=0.35, Passenger=0.3.",
                table_body_style,
            ),
        ],
        [
            Paragraph("F8", table_body_style),
            Paragraph("Origin Density", table_body_style),
            Paragraph("0.05", table_body_style),
            Paragraph(
                "KDE origin probability mass along track line.", table_body_style
            ),
        ],
        [
            Paragraph("F9", table_body_style),
            Paragraph("Draught Change", table_body_style),
            Paragraph("0.04", table_body_style),
            Paragraph(
                "Reported draught drop across release window (cargo/slops).",
                table_body_style,
            ),
        ],
        [
            Paragraph("F10", table_body_style),
            Paragraph("Slick Axis Continuity", table_body_style),
            Paragraph("0.03", table_body_style),
            Paragraph(
                "Alignment of track bearing with long axis of slick.", table_body_style
            ),
        ],
        [
            Paragraph("F11", table_body_style),
            Paragraph("Manoeuvre Anomaly", table_body_style),
            Paragraph("0.03", table_body_style),
            Paragraph(
                "Average course changes (delta COG) near origin zone.", table_body_style
            ),
        ],
        [
            Paragraph("F12", table_body_style),
            Paragraph("Prior Incidents", table_body_style),
            Paragraph("0.02", table_body_style),
            Paragraph(
                "Confirmed prior spill records for MMSI: min(1, count / 3).",
                table_body_style,
            ),
        ],
    ]
    t_feat = Table(feat_data, colWidths=[25, 110, 30, 339])
    t_feat.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), primary_color),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("GRID", (0, 0), (-1, -1), 0.5, border_color),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, light_bg]),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(t_feat)
    story.append(Spacer(1, 10))

    story.append(
        Paragraph("<b>5.2 Data Missingness & Renormalization Rule</b>", h2_style)
    )
    story.append(
        Paragraph(
            "Features carry three statuses: <code>MEASURED</code>, <code>MISSING</code>, and <code>NOT_APPLICABLE</code>. "
            "Weights are renormalised strictly over measured features so candidates with missing AIS features are not penalized artificially:",
            body_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Score Renormalization Formula:</b><br/>"
            "<code>Score = 100 * Sum(Normalised_i * Weight_i) / Sum(Weight_measured)</code>",
            code_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Confidence Floor & Tiers:</b> Measured features < 4 -> <code>INSUFFICIENT_EVIDENCE</code>. "
            "Score >= 70 -> <code>STRONG</code>, >= 40 -> <code>MODERATE</code>, >= 20 -> <code>WEAK</code>. "
            "If drift forcing was missing, origin estimate is degraded and tier is capped at <code>MODERATE</code>.",
            body_style,
        )
    )

    # 6. Monte Carlo Verification
    story.append(Paragraph("6. Monte Carlo Verification & Rank Separation", h1_style))
    story.append(
        Paragraph(
            "<b>6.1 Single-Vessel Bootstrap Confidence Intervals (bootstrapCi)</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "Runs 300 Monte Carlo draws perturbing origin zone scaling (+/- 8%) and AIS fix positions to output 5th to 95th percentile confidence bounds per vessel.",
            body_style,
        )
    )

    story.append(
        Paragraph(
            "<b>6.2 Common-Mode Resampling & Rank Separation (rankSeparation)</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "Located in <code>apps/api/src/modules/attribution/separation.ts</code>. Standard bootstrap resamples candidates independently, "
            "which treats origin uncertainty as separate accidents per vessel. VARUNA uses <b>common-mode resampling</b>: "
            "it perturbs the origin zone <b>once per iteration for the entire field</b>.",
            body_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Distinguishability Decision Rule:</b><br/>"
            "If Leader Win Share P(Leader > Runner-Up) >= 90%, the leader is <b>Statistically Distinguishable</b>. "
            "If < 90%, the verdict explicitly states that candidates are <b>Not Separable</b> under measurement noise.",
            callout_style,
        )
    )

    doc.build(story, canvasmaker=NumberedCanvas)
    print(f"PDF generated successfully at {filename}")


if __name__ == "__main__":
    out_pdf = sys.argv[1] if len(sys.argv) > 1 else "PROJECT_PROTOTYPE_EXPLANATION.pdf"
    build_pdf(out_pdf)
