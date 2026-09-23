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
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#4A5568"))

        # Header (pages > 1)
        if self._pageNumber > 1:
            self.drawString(
                54,
                750,
                "VARUNA — Master Presentation, Algorithm & Technical Viva Guide (SIH26143)",
            )
            self.setStrokeColor(colors.HexColor("#CBD5E0"))
            self.setLineWidth(0.5)
            self.line(54, 742, 558, 742)

        # Footer
        page_str = f"Page {self._pageNumber} of {page_count}"
        self.drawRightString(558, 36, page_str)
        self.drawString(
            54, 36, "VARUNA SIH26143 — Technical Master Guide & Presentation Dossier"
        )
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

    primary_color = colors.HexColor("#1A365D")  # Navy
    secondary_color = colors.HexColor("#2B6CB0")  # Medium Blue
    dark_neutral = colors.HexColor("#2D3748")
    light_bg = colors.HexColor("#F7FAFC")
    border_color = colors.HexColor("#E2E8F0")

    title_style = ParagraphStyle(
        "DocTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=26,
        textColor=primary_color,
        alignment=0,
        spaceAfter=6,
    )

    subtitle_style = ParagraphStyle(
        "DocSubTitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=11,
        leading=15,
        textColor=secondary_color,
        spaceAfter=15,
    )

    h1_style = ParagraphStyle(
        "H1",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=14,
        leading=18,
        textColor=primary_color,
        spaceBefore=14,
        spaceAfter=8,
        keepWithNext=True,
    )

    h2_style = ParagraphStyle(
        "H2",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=15,
        textColor=secondary_color,
        spaceBefore=10,
        spaceAfter=5,
        keepWithNext=True,
    )

    body_style = ParagraphStyle(
        "Body",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=13.5,
        textColor=dark_neutral,
        spaceAfter=6,
    )

    bullet_style = ParagraphStyle(
        "Bullet", parent=body_style, leftIndent=12, firstLineIndent=-8, spaceAfter=3
    )

    code_style = ParagraphStyle(
        "CodeBlock",
        parent=styles["Normal"],
        fontName="Courier",
        fontSize=8,
        leading=10.5,
        textColor=colors.HexColor("#1A202C"),
        backColor=colors.HexColor("#EDF2F7"),
        borderColor=border_color,
        borderWidth=1,
        borderPadding=6,
        spaceBefore=4,
        spaceAfter=6,
    )

    callout_style = ParagraphStyle(
        "Callout",
        parent=body_style,
        fontName="Helvetica-Oblique",
        fontSize=9,
        leading=12.5,
        textColor=colors.HexColor("#2C5282"),
        backColor=colors.HexColor("#EBF8FF"),
        borderColor=colors.HexColor("#3182CE"),
        borderWidth=1,
        borderPadding=6,
        spaceBefore=6,
        spaceAfter=8,
    )

    table_header_style = ParagraphStyle(
        "TableHeader",
        fontName="Helvetica-Bold",
        fontSize=8.5,
        leading=10.5,
        textColor=colors.white,
        alignment=1,
    )

    table_body_style = ParagraphStyle(
        "TableBody",
        fontName="Helvetica",
        fontSize=8,
        leading=10.5,
        textColor=dark_neutral,
    )

    story = []

    # Title Banner
    story.append(Paragraph("VARUNA Master Technical Guide & PPT Dossier", title_style))
    story.append(
        Paragraph(
            "Vessel Attribution through Remote-Sensing & Unified Navigational Analytics<br/><b>Smart India Hackathon 2026 — Problem Statement SIH26143</b>",
            subtitle_style,
        )
    )
    story.append(
        HRFlowable(width="100%", thickness=2, color=primary_color, spaceAfter=12)
    )

    # Executive Summary
    story.append(Paragraph("Executive Summary & Core Problem", h1_style))
    story.append(
        Paragraph(
            "<b>VARUNA</b> is an automated end-to-end intelligence system that detects satellite-observed ocean oil spills, "
            "back-tracks their physical release zone using ocean currents and winds, correlates real AIS vessel trajectories, "
            "and computes a statistically validated <b>Investigative Priority Score (0–100)</b> with bootstrap confidence intervals. "
            "Crucially, VARUNA solves the 'footprint fallacy' — acknowledging that ocean currents drift oil miles away from its release location "
            "in the 6–24 hours between dumping and satellite overpass.",
            body_style,
        )
    )

    # Part 1: Algorithmic Specification
    story.append(Paragraph("Part 1: Complete Algorithmic Specification", h1_style))

    story.append(
        Paragraph("1.1 SAR Radiometric Calibration & Speckle Filtering", h2_style)
    )
    story.append(
        Paragraph(
            "• <b>Radiometric Calibration (Sigma-0):</b> Converts raw Digital Numbers (DN) to backscatter coefficient sigma0: <i>sigma0 = (DN^2 / K) * sin(theta)</i>.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Decibel Scaling:</b> Converts sigma0 to dB: <i>dB = 10 * log10(sigma0 + 1e-7)</i> to transform log-distributed backscatter into a normal distribution for AI.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Refined Lee Filter (7x7):</b> Uses local variance to smooth multiplicative speckle noise while preserving sharp oil-slick boundaries.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Robust Scaling:</b> Scales each channel between its 2nd and 98th percentiles over water to prevent ship-bright outliers from compressing slick contrast.",
            bullet_style,
        )
    )

    story.append(
        Paragraph("1.2 Deep Learning Multi-Class Segmentation (Model M1)", h2_style)
    )
    story.append(
        Paragraph(
            "• <b>5 Physical Classes:</b> Sea, Oil Spill, Look-Alike (low wind, algae), Ship, Land.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>3-Channel Input:</b> [VV_dB, VH_dB, VV_dB - VH_dB].", bullet_style
        )
    )
    story.append(
        Paragraph(
            "• <b>Cosine-Hann 2D Tiled Blending:</b> Eliminates border seam artifacts during sliding-window inference over 256x256 tiles by applying a 2D cosine weight matrix.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Composite Loss Function:</b> Total Loss = 0.5 * Dice Loss + 0.5 * Focal Loss (tackles severe class imbalance where oil < 2% of pixels).",
            bullet_style,
        )
    )

    story.append(
        Paragraph(
            "1.3 Backward Lagrangian Stochastic Drift Simulation (Model M2)", h2_style
        )
    )
    story.append(
        Paragraph(
            "• <b>Stochastic Particle Stepper:</b> Integrates 5,000 particles backwards in time (-15 min timesteps):",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "<code>dx/dt = u_current + alpha * R(theta) * u_wind + RandomWalk(Kh)</code>",
            code_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Parameters:</b> Wind drift factor alpha ~ U(0.02, 0.04); Ekman deflection theta ~ U(0°, 20°); Horizontal diffusivity Kh = 10 m²/s.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>2D Gaussian KDE:</b> Estimates origin probability density surface and exports 50% (core) and 90% (expanded) confidence contours.",
            bullet_style,
        )
    )
    story.append(
        Paragraph(
            "• <b>Prior Clear-Scene Bounding:</b> Tightens estimated release window using the timestamp of the prior clean satellite overpass.",
            bullet_style,
        )
    )

    story.append(
        Paragraph("1.4 14-Feature Additive Attribution Engine (Model M3)", h2_style)
    )
    story.append(
        Paragraph(
            "Scores vessel candidates across 14 independent spatial, temporal, kinematic, and behavioural features:",
            body_style,
        )
    )

    feat_data = [
        [
            Paragraph("Code", table_header_style),
            Paragraph("Feature Name", table_header_style),
            Paragraph("W", table_header_style),
            Paragraph("Mathematical Logic & Condition", table_header_style),
        ],
        [
            Paragraph("F1", table_body_style),
            Paragraph("Spatial Proximity", table_body_style),
            Paragraph("0.18", table_body_style),
            Paragraph(
                "exp(-d / 8) where d is distance (km) to origin zone centroid.",
                table_body_style,
            ),
        ],
        [
            Paragraph("F2", table_body_style),
            Paragraph("Temporal Alignment", table_body_style),
            Paragraph("0.16", table_body_style),
            Paragraph(
                "Fraction of vessel fixes falling inside release window.",
                table_body_style,
            ),
        ],
        [
            Paragraph("F3", table_body_style),
            Paragraph("Track Intersection", table_body_style),
            Paragraph("0.14", table_body_style),
            Paragraph(
                "1.0 if track intersects origin zone; else 1 / (1 + d / 3).",
                table_body_style,
            ),
        ],
        [
            Paragraph("F4", table_body_style),
            Paragraph("Heading Alignment", table_body_style),
            Paragraph("0.10", table_body_style),
            Paragraph(
                "cos²(heading - slick_axis). (N/A if elongation < 2.5).",
                table_body_style,
            ),
        ],
        [
            Paragraph("F5", table_body_style),
            Paragraph("AIS Dark Period", table_body_style),
            Paragraph("0.10", table_body_style),
            Paragraph(
                "Transponder silence in window: min(1, gap_minutes / 120).",
                table_body_style,
            ),
        ],
        [
            Paragraph("F6", table_body_style),
            Paragraph("Speed Consistency", table_body_style),
            Paragraph("0.08", table_body_style),
            Paragraph(
                "Optimal for illegal discharge underway (4 - 14 knots).",
                table_body_style,
            ),
        ],
        [
            Paragraph("F7", table_body_style),
            Paragraph("Vessel Type Risk", table_body_style),
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
                "KDE origin probability mass along vessel track line.", table_body_style
            ),
        ],
        [
            Paragraph("F9", table_body_style),
            Paragraph("Draught Change", table_body_style),
            Paragraph("0.04", table_body_style),
            Paragraph(
                "Reported draught drop across release window (slops/cargo).",
                table_body_style,
            ),
        ],
        [
            Paragraph("F10", table_body_style),
            Paragraph("Slick Axis Continuity", table_body_style),
            Paragraph("0.03", table_body_style),
            Paragraph(
                "Alignment of track segment with long axis of slick.", table_body_style
            ),
        ],
        [
            Paragraph("F11", table_body_style),
            Paragraph("Manoeuvre Anomaly", table_body_style),
            Paragraph("0.03", table_body_style),
            Paragraph(
                "Course change variance (delta COG) near origin zone.", table_body_style
            ),
        ],
        [
            Paragraph("F12", table_body_style),
            Paragraph("AIS Dark Anomaly", table_body_style),
            Paragraph("0.01", table_body_style),
            Paragraph(
                "Flagged AIS silence > 30 mins in release window.", table_body_style
            ),
        ],
        [
            Paragraph("F13", table_body_style),
            Paragraph("Destination Risk", table_body_style),
            Paragraph("0.005", table_body_style),
            Paragraph("High-risk port route prior.", table_body_style),
        ],
        [
            Paragraph("F14", table_body_style),
            Paragraph("Historic Violations", table_body_style),
            Paragraph("0.005", table_body_style),
            Paragraph(
                "Confirmed prior spill incident records for MMSI.", table_body_style
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
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(t_feat)
    story.append(Spacer(1, 8))

    story.append(
        Paragraph("1.5 Missing-Feature Renormalization & Guardrails", h2_style)
    )
    story.append(
        Paragraph(
            "<b>Renormalization Equation:</b> <i>Score = 100 * Sum(w_i * f_i) / Sum(w_measured)</i>.<br/>"
            "We divide strictly by the sum of weights of <i>measured</i> features. Missing data never acts as false exoneration.<br/>"
            "<b>Floor Safeguard:</b> If fewer than 6 features are measured, the output is hard-locked to <code>INSUFFICIENT_EVIDENCE</code>.",
            callout_style,
        )
    )

    story.append(
        Paragraph("1.6 Monte Carlo Bootstrap & Common-Mode Rank Separation", h2_style)
    )
    story.append(
        Paragraph(
            "• <b>500 Joint Bootstrap Iterations:</b> Resamples particle cloud and perturbed AIS tracks to output 5th/95th percentile confidence bounds.<br/>"
            "• <b>Common-Mode Rank Separation:</b> Origin uncertainty is perturbed <i>once per iteration across all candidates</i> to accurately test if Candidate #1 statistically leads Candidate #2 (Leader Win Share >= 90%).",
            body_style,
        )
    )

    # Part 2: PPT Slide Structure
    story.append(Spacer(1, 10))
    story.append(Paragraph("Part 2: PPT Slide-by-Slide Structure", h1_style))

    ppt_data = [
        [
            Paragraph("Slide #", table_header_style),
            Paragraph("Slide Title", table_header_style),
            Paragraph("Visual & Technical Content", table_header_style),
        ],
        [
            Paragraph("Slide 1", table_body_style),
            Paragraph("Title & Overview", table_body_style),
            Paragraph(
                "Project VARUNA — Vessel Attribution System. Problem SIH26143.",
                table_body_style,
            ),
        ],
        [
            Paragraph("Slide 2", table_body_style),
            Paragraph("The Operational Challenge", table_body_style),
            Paragraph(
                "The 18-hour gap between release & satellite overpass; why simple distance fails.",
                table_body_style,
            ),
        ],
        [
            Paragraph("Slide 3", table_body_style),
            Paragraph("End-to-End Architecture", table_body_style),
            Paragraph(
                "4-Tier Diagram: Providers → Ingest/ML → Drift/AIS → Web Workspace.",
                table_body_style,
            ),
        ],
        [
            Paragraph("Slide 4", table_body_style),
            Paragraph("Preprocessing & Segmentation", table_body_style),
            Paragraph(
                "8-step SAR calibration table + U-Net 5-class model (Oil vs Look-Alike).",
                table_body_style,
            ),
        ],
        [
            Paragraph("Slide 5", table_body_style),
            Paragraph("Backward Drift Engine", table_body_style),
            Paragraph(
                "5,000 Particle RK Stepper equation, CMEMS/ERA5 integration, 50%/90% origin fields.",
                table_body_style,
            ),
        ],
        [
            Paragraph("Slide 6", table_body_style),
            Paragraph("14-Feature Attribution", table_body_style),
            Paragraph(
                "Evidence waterfall breakdown, missing-feature renormalization formula, CIs.",
                table_body_style,
            ),
        ],
        [
            Paragraph("Slide 7", table_body_style),
            Paragraph("Prototype Showcase", table_body_style),
            Paragraph(
                "Screenshots of 3D Space-Time Prism, Evidence Waterfall, Audit Inspector.",
                table_body_style,
            ),
        ],
        [
            Paragraph("Slide 8", table_body_style),
            Paragraph("Guardrails & Impact", table_body_style),
            Paragraph(
                "Zero mock data policy, INSUFFICIENT_EVIDENCE tier, automated PDF reports.",
                table_body_style,
            ),
        ],
    ]
    t_ppt = Table(ppt_data, colWidths=[45, 120, 339])
    t_ppt.setStyle(
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
    story.append(t_ppt)

    # Part 3: Presentation Script
    story.append(Spacer(1, 10))
    story.append(
        Paragraph("Part 3: Word-for-Word Presentation Speech Script", h1_style)
    )
    story.append(
        Paragraph(
            '<i>"Respected judges, I will now walk you through the core technical architecture and mathematical engine powering <b>VARUNA</b>.<br/><br/>'
            "When a satellite captures a scene over the ocean, raw SAR data arrives as uncalibrated digital numbers full of multiplicative speckle noise and terrain distortion. Our pipeline first executes an 8-step preprocessing chain: we apply precise orbit files, perform thermal noise removal, calibrate raw intensity to physical sigma-nought decibels, and apply a 7x7 Refined Lee filter to suppress noise while keeping slick borders sharp.<br/><br/>"
            "Next, our Model M1 — a U-Net semantic segmentation network — classifies every pixel into five distinct physical classes. Unlike traditional binary detectors that cause false alarms, VARUNA explicitly separates real oil slicks from look-alikes like low-wind zones or algal films.<br/><br/>"
            "Now comes our core differentiator: <b>Backward Lagrangian Drift Modeling</b>. A slick seen at 2 PM was likely dumped at 2 AM. If you simply measure vessel proximity to the observed slick, you will accuse an innocent downstream ship while letting the culprit escape. VARUNA seeds 5,000 stochastic particles inside the slick polygon and integrates them <b>backwards in time</b> using a 4th-order Runge-Kutta stepper driven by real CMEMS ocean currents and ERA5 surface winds. We sample wind-drift factors between 2% and 4% and Ekman deflection angles up to 20° per particle. A 2D Gaussian Kernel Density estimation then converts this cloud into an <b>Origin Probability Field</b> with 50% and 90% confidence contours.<br/><br/>"
            "Finally, our Attribution Engine evaluates every candidate vessel against 14 independent spatial, temporal, kinematic, and behavioural features. To ensure fair scoring, we use <b>Missing Feature Renormalization</b> — dividing only by the weights of features actually measured so that missing data never acts as false exoneration. We run 500 joint bootstrap iterations to calculate a 90% confidence interval for every score.<br/><br/>"
            "If fewer than 6 features are measured, VARUNA refuses to guess and explicitly flags the result as <b>INSUFFICIENT_EVIDENCE</b>.<br/><br/>"
            'Thank you, and we welcome your technical questions."</i>',
            callout_style,
        )
    )

    # Part 4: Judge Q&A Guide
    story.append(Spacer(1, 10))
    story.append(
        Paragraph("Part 4: Technical Judge Q&A Guide (Top Viva Questions)", h1_style)
    )

    story.append(
        Paragraph(
            "<b>Q1: How do you handle look-alikes like low wind or algae that mimic oil on SAR?</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Answer:</b> 1) 5-Class U-Net model trained with dual-polarization (VV/VH) log ratios. 2) ERA5 Wind-Suitability Gate (validates wind between 3–10 m/s). 3) Multi-term confidence reporting (model, look-alike risk, wind suitability, shape plausibility).",
            body_style,
        )
    )

    story.append(
        Paragraph(
            "<b>Q2: Why use Backward Lagrangian Drift instead of forward drift?</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Answer:</b> Forward drift predicts where oil goes. Backward drift answers where the oil <b>came from</b>. By stepping backwards from satellite observation to the estimated release window, we calculate the Origin Probability Surface and correlate vessel tracks against where ships actually were at the moment of dumping.",
            body_style,
        )
    )

    story.append(
        Paragraph(
            "<b>Q3: What happens if a vessel turned off its AIS transponder (AIS Dark Period)?</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Answer:</b> In VARUNA, transponder silence is scored as a <b>behavioural evidence signal (F5/F12)</b> rather than missing data. An AIS gap overlapping the release window near the origin zone adds to the score (weighted at 0.10) and flags an AIS_DARK_PERIOD anomaly.",
            body_style,
        )
    )

    story.append(
        Paragraph(
            "<b>Q4: How do you handle missing data so a vessel isn't penalized or falsely cleared?</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Answer:</b> We use Missing-Feature Renormalization: <i>Score = 100 * Sum(w_i * f_i) / Sum(w_measured)</i>. We only divide by the sum of weights of <i>measured</i> features. If fewer than 6 features are measured, the system defaults to INSUFFICIENT_EVIDENCE.",
            body_style,
        )
    )

    story.append(
        Paragraph(
            "<b>Q5: How do you know your system isn't using fake or mock data?</b>",
            h2_style,
        )
    )
    story.append(
        Paragraph(
            "<b>Answer:</b> Every document enforces a required <code>provenance</code> sub-document (provider, datasetId, externalId, timestamp, licence, checksum). Unprovenanced data is rejected by Mongoose hooks, stripped by API serializers, and flagged in red on the React UI dashboard.",
            body_style,
        )
    )

    doc.build(story, canvasmaker=NumberedCanvas)
    print(f"PDF generated successfully at {filename}")


if __name__ == "__main__":
    out_pdf = (
        sys.argv[1]
        if len(sys.argv) > 1
        else "e:/SIH/doc/docs/VARUNA_Master_Presentation_and_Algorithm_Guide.pdf"
    )
    build_pdf(out_pdf)
