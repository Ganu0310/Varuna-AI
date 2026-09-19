# VARUNA — demo script (5–10 min)

**Prep:** `docker compose up -d` and wait for `docker compose ps` to show all services up.
Either run `pnpm demo` beforehand (fastest — it prints a ready workspace URL and a login),
or do the click-through live using the steps below. `pnpm demo:reset` clears state between
rehearsals.

---

**Opening line:**
> "VARUNA is an investigative decision-support system for marine oil spills. It starts from
> a real satellite radar observation and ends with a ranked list of candidate vessels — and
> it never states more certainty than the evidence supports."

### 1 — Open VARUNA
Go to `http://localhost:5173`, sign in. Note the three-way **dark / light / system** theme
control in the top bar.

### 2 — Launch the Sentinel‑1 demo
Open the pre-built investigation (or *New investigation* → AOI `144.55,13.30,144.95,13.60`,
window `2025‑09‑20 … 2025‑09‑23`).
> "Area of interest: Apra Harbour, Guam. Time window around 21 September 2025."

### 3 — The satellite scene
Workspace → **Scenes & detections**. Point at the scene card:
> "Sentinel‑1C, RTC, VV+VH, EPSG:32655, 10 m, from Microsoft Planetary Computer. This is a
> real Copernicus acquisition — the product id is right here."
The greyscale SAR backscatter is the actual raster the detector ran on, tiled straight from
object storage.

### 4 — The detected spill
> "The classical dark-spot detector found 13 anomalous low-backscatter features. The largest
> is about 1.20 km², detector confidence 0.61, look-alike risk 0.24, centred near
> 13.449 N, 144.669 E."
Click the top detection → its polygon highlights, metrics and provenance open. Stress:
> "This ran live just now — nothing here is pre-computed."

### 5 — Origin back-track
**Origin** tab → select the top detection → **Run back-tracking**.
> "VARUNA tries a backward drift ensemble against real ocean-current and wind fields. For
> this date no keyless current model has coverage, so it degrades — explicitly — to a
> footprint-proximity zone and tells you it cannot distinguish upstream from downstream.
> That honesty is the point."

### 6 — AIS correlation
**AIS** tab shows the coverage assessment first:
> "133 positions, 4 vessels, median 5-minute reporting, spanning only 8% of the window — a
> high-ranked candidate here may reflect sparse coverage, not strong evidence."
The AIS layer here is a **synthetic demo slice**, labelled as such.

### 7 — Candidate vessels
**Origin** tab → **Rank candidate vessels** → **Candidates** tab.
> "Every vessel with AIS in the release envelope is scored across twelve evidence features,
> renormalised over the ones that could actually be measured. MMSI 538005123 ranks first —
> it transited the slick area with a 45-minute AIS gap over it."
Point at the tiers:
> "All four are capped at MODERATE. Because the origin estimate is degraded, the ranking is
> not allowed to look more confident than that."

### 8 — Origin panel
> "Method: FOOTPRINT_PROXIMITY. Status: DEGRADED. Release window: WIDE. The reason is
> printed, not buried."

### 9 — Uncertainty
Throughout: scores are labelled scores, not probabilities; unmeasured features say
`NOT_APPLICABLE`; degraded inputs propagate to a capped tier.

### 10 — Dossier
**Dossier**. Walk the sections: Satellite scenes → Detections → Origin estimate → AIS
evidence base → Candidate vessels → Uncertainty → Data sources / Provenance → Limitations →
Audit trail. Show **Print / Save as PDF** and the GeoJSON / CSV / manifest exports.

### 11 — Provenance
Open any evidence item → every figure links back to a provider product, a processing step,
or a source AIS fix. The AIS provenance says *"VARUNA synthetic demo AIS"* — it never claims
to be NOAA.

### 12 — Limitations (closing)
> "Real satellite observation. Derived detections. A degraded origin estimate that says so.
> Synthetic AIS that says so. An evidence-weighted ranking of leads — not a verdict. And
> everything traces back to source. That's VARUNA."

---

### If something misbehaves live
- Scene won't ingest → Planetary Computer rate limit; wait ~30 s and retry, or use the
  pre-staged run from `pnpm demo`.
- Panel looks stale after a job → refresh the page; the data is correct, the socket refresh
  is the gap.
- Start clean → `pnpm demo:reset && pnpm demo`.
