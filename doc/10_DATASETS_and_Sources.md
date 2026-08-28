# 10 — Datasets & Data Sources

**Product:** VARUNA
**Problem Statement:** SIH26143
**Document version:** 1.0

> Every dataset in this document is **real observational data**. This document exists so
> that any team member can obtain every input the system needs without guessing, and so
> that any evaluator can verify our sources independently.
>
> Governing policy: [13_REAL_DATA_POLICY.md](13_REAL_DATA_POLICY.md).

---

## 10.1 Data requirement summary

| # | Category | Needed for | Volume (MVP) | Cost |
|---|---|---|---|---|
| 1 | Labelled SAR oil-spill imagery | Training M1 | ~1,100 patches, ~2 GB | Free |
| 2 | Sentinel-1 SAR scenes | Detection on real incidents | 5–20 scenes, ~1 GB each | Free |
| 3 | Sentinel-2 optical scenes | Optional look-alike disambiguation, before/after context | 5–10 scenes | Free |
| 4 | Historical AIS positions | Vessel trajectories | 10⁶–10⁷ rows | Free |
| 5 | Live AIS stream | Phase-2 monitoring | continuous | Free tier |
| 6 | Ocean surface currents | Drift back-tracking | ~200 MB per incident | Free |
| 7 | 10 m winds | Drift + detectability gate | ~50 MB per incident | Free |
| 8 | Coastline vectors | Land masking | ~500 MB global | Free |
| 9 | Bathymetry | Map context | ~1 GB | Free |
| 10 | Vessel registry | Identity resolution | varies | Free tier |
| 11 | Validated incident records | Ground truth for M1 + M3 | ~50–200 incidents | Free |
| 12 | Digital elevation model | SAR terrain correction | ~2 GB regional | Free |

**Total MVP footprint: roughly 40–60 GB.** Everything required for the MVP is free.

---

## 10.2 Category 1 — Labelled SAR oil-spill imagery (M1 training)

### 10.2.1 PRIMARY: MKLab / CERTH Oil Spill Detection Dataset

**This is the single most important dataset in the project.**

| Field | Value |
|---|---|
| **Full name** | Oil Spill Detection Dataset |
| **Publisher** | MKLab, Information Technologies Institute, CERTH (Greece) |
| **Paper** | Krestenitis, M., Orfanidis, G., Ioannidis, K., Avgerinakis, K., Vrochidis, S., Kompatsiaris, I. (2019). *Oil Spill Identification from Satellite Images Using Deep Neural Networks.* **Remote Sensing, 11(15), 1762.** |
| **Access** | `https://mklab.iti.gr/results/oil-spill-detection-dataset/` — request form; approval typically within a few days |
| **Content** | ~1,112 annotated Sentinel-1 SAR image patches with pixel-level masks |
| **Classes** | Exactly our five: sea surface, oil spill, look-alike, ship, land |
| **Provenance of labels** | Derived from **EMSA CleanSeaNet verified events** — expert-confirmed real incidents |
| **Splits** | Train/test splits provided by the authors |
| **Size** | ~2 GB |
| **Licence** | Research use; citation required |
| **Real data?** | ✅ Real Sentinel-1 acquisitions, real expert annotations |

**Why it is irreplaceable:** it is the only widely available dataset with the explicit
`look_alike` class. Without it we would be forced into binary oil/not-oil, which
[07_AIML §7.2.1](07_AIML_Specification.md) explains would produce an unacceptable
false-positive rate.

**Action for the team:** submit the request form **in week 1**. Approval is not instant and
the entire ML workstream depends on it. Have the fallback below queued in parallel.

### 10.2.2 SECONDARY: SOS / Deep-SAR Oil Spill datasets

| Field | Value |
|---|---|
| Content | Real SAR oil-spill annotations from **GaoFen-3**, **Sentinel-1** and **PALSAR** |
| Use | Cross-sensor generalisation testing — does a model trained on Sentinel-1 transfer? |
| Access | Published via the associated papers' data-availability statements and mirrored on public dataset hosts |
| Real data? | ✅ |

### 10.2.3 TERTIARY: Kaggle / Zenodo / Hugging Face mirrors

Several mirrors of oil-spill SAR datasets exist on Kaggle, Zenodo and the Hugging Face Hub.

> **Mandatory check before use:** many "oil spill" datasets circulating on hosting sites are
> re-uploads with the original licence and provenance stripped, and some contain
> **synthetic or augmented-to-death** samples. Before any such dataset enters our manifest,
> we must identify the original publication, confirm the imagery is real satellite
> acquisition, and record the licence. A dataset whose origin cannot be established is
> **rejected** — see [13_REAL_DATA_POLICY §13.3](13_REAL_DATA_POLICY.md).

### 10.2.4 Our own labels (Phase 2)

Analyst corrections captured in `spill_detections.reviewHistory` become training data:
real Sentinel-1 imagery with real expert annotation, each carrying the reviewing user and
timestamp. This closes the loop and is the only sustainable path to region-specific
performance in Indian waters.

---

## 10.3 Category 2–3 — Satellite imagery

### 10.3.1 Sentinel-1 (SAR) — the primary sensor

| Route | Details | Credential | Best for |
|---|---|---|---|
| **Copernicus Data Space Ecosystem (CDSE)** | `dataspace.copernicus.eu` — the official ESA distribution point since the retirement of the old Open Access Hub. OData and STAC APIs, plus S3 access. Full archive. | OAuth2 client ID + secret (free) | Catalogue search; authoritative source |
| **Microsoft Planetary Computer** | `planetarycomputer.microsoft.com` — STAC API. Hosts **Sentinel-1 RTC** (Radiometrically Terrain Corrected), which is **already preprocessed** | Free; optional subscription key raises rate limits | **Fastest path.** Skips ~10 minutes of SNAP processing per scene |
| **ASF DAAC (Alaska Satellite Facility)** | `search.asf.alaska.edu`, `asf_search` Python library | NASA Earthdata Login (free) | Excellent search API; good fallback |
| **AWS Open Data** | Sentinel-1 in S3 | AWS credentials; some buckets requester-pays | Bulk processing on AWS |

**Product to request:** `S1A/S1B/S1C_IW_GRDH_1SDV` — Interferometric Wide swath, Ground
Range Detected, High resolution, dual polarisation VV+VH. This is the standard product for
maritime oil-spill work.

```python
# Route A — Planetary Computer (recommended: pre-processed RTC)
import pystac_client, planetary_computer
cat = pystac_client.Client.open(
    "https://planetarycomputer.microsoft.com/api/stac/v1",
    modifier=planetary_computer.sign_inplace)
items = cat.search(
    collections=["sentinel-1-rtc"],
    intersects=aoi_geojson,
    datetime="2023-08-10/2023-08-20",
).item_collection()

# Route B — ASF DAAC
import asf_search as asf
results = asf.geo_search(
    platform=asf.PLATFORM.SENTINEL1,
    processingLevel=asf.PRODUCT_TYPE.GRD_HD,
    beamMode=asf.BEAMMODE.IW,
    intersectsWith=aoi_wkt,
    start="2023-08-10", end="2023-08-20")
results.download(path="./data/scenes",
                 session=asf.ASFSession().auth_with_creds(user, pw))
```

### 10.3.2 Sentinel-2 (optical) — supplementary

| Route | Credential | Note |
|---|---|---|
| CDSE | Same OAuth2 | Full archive |
| Element 84 Earth Search (`earth-search.aws.element84.com/v1`) | **None** | Cloud-Optimised GeoTIFFs on AWS, no key required — the easiest optical route |
| Planetary Computer | Optional key | — |

Use L2A (surface reflectance). Filter to under ~20% cloud. Optical is opportunistic: most
acquisitions over a spill will be cloudy, which is exactly why SAR is primary.

### 10.3.3 Landsat 8/9 — occasional

USGS EarthExplorer / M2M API (free account). Longer revisit; useful for historical
incidents predating Sentinel-2.

### 10.3.4 Indian sources — ISRO / NRSC

| Source | Content | Access |
|---|---|---|
| **Bhoonidhi** (`bhoonidhi.nrsc.gov.in`) | ISRO EO data distribution: RISAT series, **EOS-04** (C-band SAR), Oceansat, Resourcesat | Free account registration; no public REST API key — download via portal |
| **Bhuvan** (`bhuvan.nrsc.gov.in`) | Geoportal, WMS/WMTS services | Open |

**Status:** EOS-04 C-band SAR is directly relevant to oil-spill detection in Indian waters
and is the natural Phase-3 extension. For the MVP we use Sentinel-1 because it has an
automatable API, a global free archive, and a matching labelled training set. This is a
tooling decision, and the document says so rather than implying Indian data is unsuitable.

---

## 10.4 Category 4–5 — AIS data

This is the category most likely to constrain which incident we can demonstrate. **Choose
the demo incident based on AIS availability, not the other way round.**

### 10.4.1 FREE BULK HISTORICAL — the best options

#### NOAA Marine Cadastre AIS (United States) ⭐ recommended

| Field | Value |
|---|---|
| **URL** | `marinecadastre.gov/ais/` |
| **Coverage** | US coastal waters and EEZ |
| **Period** | 2009 → present |
| **Resolution** | **1-minute** decimated positions |
| **Format** | Daily CSV (zipped), organised by UTM zone / date |
| **Fields** | MMSI, BaseDateTime, LAT, LON, SOG, COG, Heading, VesselName, IMO, CallSign, VesselType, Status, Length, Width, Draft, Cargo |
| **Credential** | **None** — direct HTTP download |
| **Licence** | US Government public domain |
| **Volume** | ~1–3 GB per day nationally; a single UTM zone slice is far smaller |

This is the highest-quality free historical AIS archive in existence. If a suitable US-waters
incident exists, this is the path of least resistance for the MVP.

#### Danish Maritime Authority AIS (Denmark) ⭐ recommended

| Field | Value |
|---|---|
| **URL** | `web.ais.dk/aisdata/` |
| **Coverage** | Danish waters and surrounding Baltic/North Sea |
| **Period** | 2006 → present |
| **Format** | Daily CSV, one file per day |
| **Credential** | **None** — open directory listing, direct download |
| **Licence** | Open data |
| **Note** | Very high vessel density (the Danish straits are among the busiest waterways in the world), which makes for a genuinely challenging and impressive correlation demonstration |

#### Norwegian Coastal Administration / BarentsWatch (Norway)

| Field | Value |
|---|---|
| **Coverage** | Norwegian waters, including offshore |
| **Access** | Kystverket open AIS data; BarentsWatch API |
| **Credential** | Free account for some endpoints |
| **Note** | Includes satellite AIS (AISSat) for open-ocean coverage |

#### Finnish Transport Agency — Digitraffic

| Field | Value |
|---|---|
| **URL** | `meri.digitraffic.fi` |
| **Access** | Free REST + MQTT, **no key** |
| **Coverage** | Finnish waters, live and recent history |

### 10.4.2 FREE API — Global Fishing Watch ⭐

| Field | Value |
|---|---|
| **URL** | `globalfishingwatch.org/our-apis/` — gateway at `gateway.api.globalfishingwatch.org` |
| **Credential** | Free API token after registration (state your research/hackathon purpose) |
| **Provides** | Vessel identity search, **AIS-derived events** (encounters, loitering, port visits, **gaps**), 4Wings gridded activity |
| **Coverage** | Global |
| **Licence** | Free for non-commercial use with attribution |
| **Limitation** | Event-oriented rather than raw position-stream oriented; the raw-track endpoints have usage limits |

Especially valuable because their **gap events** are methodologically adjacent to our F5
`ais_dark_period` feature, providing external corroboration of the approach.

### 10.4.3 FREE LIVE STREAM — AISStream.io

| Field | Value |
|---|---|
| **URL** | `aisstream.io` |
| **Credential** | Free API key |
| **Protocol** | WebSocket; subscribe by bounding box and message type |
| **Coverage** | Terrestrial AIS network — good coastal coverage, limited open-ocean |
| **Use** | Phase-2 live monitoring only. **Not usable for historical incident reconstruction.** |

```python
import asyncio, json, websockets

async def stream(api_key, bbox):
    async with websockets.connect("wss://stream.aisstream.io/v0/stream") as ws:
        await ws.send(json.dumps({
            "APIKey": api_key,
            "BoundingBoxes": [bbox],                    # [[lat1,lon1],[lat2,lon2]]
            "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
        }))
        async for msg in ws:
            yield json.loads(msg)
```

### 10.4.4 CONDITIONAL — AISHub

Free **only if you contribute your own AIS receiver feed**. Without hardware and a
contributed stream, this is not available. Listed for completeness; not part of our plan.

### 10.4.5 PAID — not required for MVP

| Service | Note |
|---|---|
| **MarineTraffic API** | Credit-based; good global coverage; useful for vessel identity enrichment |
| **Spire Maritime** | Satellite AIS with genuine open-ocean coverage; runs an academic/research access programme worth applying to |
| **VesselFinder**, **Datalastic** | Commercial alternatives |

### 10.4.6 AIS field reference (what we normalise to)

| Field | Type | Notes |
|---|---|---|
| `mmsi` | integer, 9 digits | First 3 digits are the MID country code — used for flag inference and validity checking |
| `t` | ISO-8601 UTC | Position timestamp |
| `lat`, `lon` | decimal degrees | WGS84 |
| `sog` | knots | Speed over ground; `102.3` is the "not available" sentinel |
| `cog` | degrees true, 0–359.9 | Course over ground; `360.0` is the "not available" sentinel |
| `heading` | degrees true | True heading; `511` is the "not available" sentinel |
| `navStatus` | integer | ITU-R M.1371 code (0 = under way using engine, 1 = at anchor, 5 = moored, …) |
| `imo`, `name`, `callsign`, `shipType`, `dimensions`, `draught`, `destination`, `eta` | from AIS Message 5 | Static and voyage data, broadcast less frequently |

> **Sentinel values must be mapped to `null`, never stored as numbers.** A vessel recorded
> at 102.3 knots or heading 511° would corrupt kinematic filtering and every speed-related
> feature. This normalisation is part of FR-4.2.

---

## 10.5 Category 6–7 — Environmental data (drift)

### 10.5.1 Ocean surface currents — Copernicus Marine Service (CMEMS) ⭐

| Field | Value |
|---|---|
| **URL** | `marine.copernicus.eu` |
| **Credential** | Free username + password |
| **Primary product** | `GLOBAL_ANALYSISFORECAST_PHY_001_024` — Global Ocean Physics Analysis and Forecast |
| **Variables** | `uo`, `vo` (eastward/northward sea water velocity) at the surface layer |
| **Resolution** | 1/12° (~8 km), hourly |
| **Reanalysis alternative** | `GLOBAL_MULTIYEAR_PHY_001_030` for older historical incidents |
| **Client** | `copernicusmarine` Python toolbox |

```python
import copernicusmarine as cm
cm.subset(
    dataset_id="cmems_mod_glo_phy_anfc_0.083deg_PT1H-m",
    variables=["uo", "vo"],
    minimum_longitude=lon_min, maximum_longitude=lon_max,
    minimum_latitude=lat_min,  maximum_latitude=lat_max,
    start_datetime="2023-08-13T00:00:00", end_datetime="2023-08-15T00:00:00",
    minimum_depth=0, maximum_depth=1,
    output_filename="currents.nc",
)
```

### 10.5.2 Ocean currents — fallbacks

| Source | Access | Note |
|---|---|---|
| **HYCOM** | `hycom.org` — OPeNDAP/NetCDF, **no key** | Global, good historical coverage |
| **OSCAR** (NASA PO.DAAC) | Earthdata login | 5-day mean surface currents; too coarse for short-horizon back-tracking but useful as a sanity check |
| **INCOIS** | `incois.gov.in` | Indian Ocean currents; the right regional source for Phase 3 |

### 10.5.3 Winds — ERA5 via Copernicus Climate Data Store ⭐

| Field | Value |
|---|---|
| **URL** | `cds.climate.copernicus.eu` |
| **Credential** | Free account; UID + API key placed in `~/.cdsapirc` |
| **Dataset** | `reanalysis-era5-single-levels` |
| **Variables** | `10m_u_component_of_wind`, `10m_v_component_of_wind` |
| **Resolution** | 0.25° (~28 km), hourly, global, 1940 → present |
| **Latency** | ~5 days behind real time (it is a reanalysis) |

```python
import cdsapi
cdsapi.Client().retrieve('reanalysis-era5-single-levels', {
    'product_type': 'reanalysis',
    'variable': ['10m_u_component_of_wind', '10m_v_component_of_wind'],
    'year': '2023', 'month': '08', 'day': ['13','14','15'],
    'time': [f'{h:02d}:00' for h in range(24)],
    'area': [lat_max, lon_min, lat_min, lon_max],     # N, W, S, E
    'format': 'netcdf',
}, 'winds.nc')
```

**Winds serve two distinct purposes** and both are essential:
1. The wind-drift term in the back-tracking model.
2. The **detectability gate** — wind speed at acquisition determines whether SAR could
   reliably see oil at all ([07_AIML §7.2.3](07_AIML_Specification.md)).

### 10.5.4 Winds — near-real-time fallback

**NOAA NOMADS / GFS** (`nomads.ncep.noaa.gov`) — free, **no key**, global forecast and
analysis at 0.25°. Use when ERA5's 5-day latency is too slow (Phase-2 monitoring).

---

## 10.6 Category 11 — Validated incidents (ground truth) ⭐

Needed for: end-to-end validation, M3 attribution labels, and the demo.

### 10.6.1 Incident record sources

| Source | Content | Access |
|---|---|---|
| **NOAA IncidentNews** (`incidentnews.noaa.gov`) | US spill incidents with dates, locations, vessel names, volumes, narratives | Free, browsable |
| **NOAA NESDIS Marine Pollution Surveillance Reports** | Analyst-confirmed satellite slick detections with coordinates and times | Free |
| **ITOPF** (`itopf.org`) | Tanker spill statistics and detailed case studies | Free |
| **Cedre** (`cedre.fr`) | French spill database with technical case files | Free |
| **EMSA CleanSeaNet case pages** | Published enforcement cases, including [the Maersk Kiera case where satellite imagery was primary evidence in a UK court](https://emsa.europa.eu/csn-menu/csn-service/oil-spill-detection-examples/286-oil-spill-detection-examples/1873-oil-spill-detection-examples-maersk-kiera-february-2012.html) | Free |
| **National maritime authority reports** | Investigation reports naming confirmed sources | Varies |
| **Indian Coast Guard / MoEFCC** | Indian incident records under NOS-DCP | Public reporting varies |

### 10.6.2 Candidate demo incidents

Selection criteria, in priority order:
**(a)** Sentinel-1 coverage within a few days of the event ·
**(b)** free historical AIS coverage for the region ·
**(c)** publicly documented source or credible investigation ·
**(d)** a clear slick signature.

| Incident | Date | Location | S-1 coverage | Free AIS | Assessment |
|---|---|---|---|---|---|
| **Sanchi** collision + spill | Jan 2018 | East China Sea | ✅ | ⚠️ GFW only | Well documented; open-ocean AIS is the constraint |
| **Wakashio** grounding | Jul–Aug 2020 | Mauritius | ✅ | ⚠️ GFW only | Very well documented; heavily studied with Sentinel-1 |
| **Ennore / Chennai** collision | Jan 2017 | Bay of Bengal, India | ✅ (S-1 only) | ⚠️ limited | **Highest national relevance**; verify AIS availability early |
| **X-Press Pearl** fire + spill | May 2021 | Sri Lanka | ✅ | ⚠️ | Regionally relevant |
| **MV Princess Empress** sinking | Feb 2023 | Philippines | ✅ | ⚠️ | Recent, well documented |
| **Any Danish-waters discharge** | 2018–2025 | Baltic / North Sea | ✅ | ✅ **DMA open AIS** | ⭐ **Best technical fit.** Dense traffic makes correlation genuinely hard and therefore genuinely impressive |
| **Any US-waters incident** | 2015–2025 | US EEZ | ✅ | ✅ **Marine Cadastre** | ⭐ **Best data fit.** 1-minute AIS is the highest quality available free |

> **Recommendation:** build and validate the MVP on a **Danish- or US-waters incident**
> where free 1-minute AIS exists, then demonstrate the same pipeline on the **Ennore /
> Chennai** incident for national relevance, being explicit about the AIS coverage
> difference. Showing the same pipeline under two data regimes — one rich, one sparse — is
> a stronger demonstration than hiding the sparse case.

---

## 10.7 Categories 8, 9, 12 — Supporting geodata

| # | Data | Source | Credential | Use |
|---|---|---|---|---|
| 8 | **Coastline vectors** | OSM coastlines (`osmdata.openstreetmap.de/data/coastlines.html`) or **GSHHG** (`soest.hawaii.edu/pwessel/gshhg/`) | None | Land masking; excluding coastal false positives |
| 9 | **Bathymetry** | **GEBCO** (`gebco.net`) — global 15-arcsecond grid | Free registration | Map context; identifying shallow-water look-alike zones |
| 12 | **DEM for terrain correction** | **SRTM 1 Arc-Second** via USGS/OpenTopography, or **Copernicus DEM 30 m** | Earthdata / free | Required by the SNAP Range-Doppler terrain correction step |
| — | **Basemap tiles** | MapLibre demo styles, **Protomaps** (self-hostable), MapTiler, Stadia | None / free tier | Map background |
| — | **Marine protected areas** | **Protected Planet** (`protectedplanet.net`) | Free | Impact context in the report |
| — | **MMSI MID country codes** | ITU MID table | None | Flag inference and MMSI validation |
| — | **Offshore infrastructure** | Global Energy Monitor; national hydrographic offices | Free | Distinguishing platform sources from vessel sources |
| — | **Known natural seeps** | Published seep inventories (e.g. Gulf of Mexico) | Free | Excluding natural sources from attribution |

---

## 10.8 Data acquisition plan

| Week | Action | Owner | Blocking? |
|---|---|---|---|
| 1 | Submit MKLab/CERTH dataset request | ML | ⚠️ **Yes — do this first** |
| 1 | Register: CDSE, NASA Earthdata, CMEMS, CDS (ERA5), GFW, AISStream | DevOps | ⚠️ Yes |
| 1 | Download Marine Cadastre + Danish DMA AIS samples; confirm schemas | Data | Yes |
| 1 | Shortlist 3 demo incidents; **verify S-1 and AIS coverage for each** | Data | ⚠️ Yes |
| 2 | Download SRTM/Copernicus DEM and GSHHG coastlines for the demo region | ML | Yes |
| 2 | Pull Sentinel-1 scenes for the shortlisted incidents (incident date **and** a prior clear date) | ML | Yes |
| 2 | Pull CMEMS currents + ERA5 winds for the incident windows | ML | Yes |
| 3 | Build the dataset manifest; run `validate_manifest` | ML | Yes |
| 3 | Ingest the AIS slice into MongoDB time-series; benchmark the envelope query | Backend | Yes |
| 4 | Assemble validated-incident ground truth for M3 | Data | No (Phase 2 calibration) |
| 4 | Pre-stage all demo data into MinIO via `pnpm run stage:demo` | DevOps | ⚠️ Yes for demo safety |

**Critical path:** the MKLab dataset request and the demo-incident coverage verification.
Both can silently consume a week if left late.

---

## 10.9 Storage, licensing and citation

### 10.9.1 Storage plan

```
data/
├── raw/
│   ├── training/mklab-certh-oil-spill/     # ~2 GB
│   ├── scenes/{productId}/                 # ~1 GB each
│   ├── ais/{source}/{yyyy-mm}/             # CSV as downloaded
│   └── env/{incident}/currents.nc, winds.nc
├── processed/
│   ├── cog/{productId}/                    # analysis-ready COGs
│   ├── tiles/                              # training tiles
│   └── ais.parquet                         # normalised, partitioned by month
└── manifests/
    ├── dataset_manifest.yaml               # drives training; validated at run start
    └── provenance/*.json                   # one per raw artefact
```

Raw downloads are **never** modified in place. Every processed artefact records the SHA-256
of its input.

### 10.9.2 Licence and attribution register

| Dataset | Licence | Required attribution |
|---|---|---|
| Sentinel-1 / Sentinel-2 | Free, full, open (Copernicus) | "Contains modified Copernicus Sentinel data [year]" |
| CMEMS | Free with registration | "Generated using E.U. Copernicus Marine Service Information" |
| ERA5 | Copernicus licence | "Contains modified Copernicus Climate Change Service information [year]" |
| MKLab/CERTH dataset | Research use | Cite Krestenitis et al. (2019) |
| Marine Cadastre AIS | US public domain | Courtesy attribution |
| Danish DMA AIS | Open data | Attribute the Danish Maritime Authority |
| Global Fishing Watch | Non-commercial, attribution | "Data from Global Fishing Watch" |
| GEBCO | Free, attribution | GEBCO Compilation Group |
| GSHHG | LGPL | Cite Wessel & Smith |
| OpenStreetMap | ODbL | "© OpenStreetMap contributors" |
| Landsat | US public domain | USGS courtesy |

**Every one of these attributions appears in the report's Data Provenance appendix and in
the application footer.** This is both a licence obligation and a demonstration of the
real-data policy.

---

## 10.10 What we will do when data is missing

| Situation | Response | Never |
|---|---|---|
| No Sentinel-1 coverage for the incident date | Widen the window; try Sentinel-2; state the gap in the report | Substitute a scene from a different date and present it as the incident |
| No AIS for the region | Report `NO_AIS_COVERAGE`, list every source queried with its coverage | Generate plausible vessel tracks |
| No current data for the date | Run `DEGRADED` in footprint-proximity mode with a visible banner | Invent a current field or assume zero drift silently |
| MKLab dataset request not yet approved | Train on the secondary real datasets; state the reduced training set in the report | Generate synthetic slicks to fill the gap |
| Too few validated incidents for calibration | Ship uncalibrated with every score labelled `UNCALIBRATED` | Fabricate validation cases to make a calibration curve |
| A dataset's provenance cannot be established | Reject it | Use it and hope no one asks |

This table is the operational form of the real-data policy. It is the answer to the
question *"but what did you do when you couldn't get the data?"* — and the answer is
always: say so.
