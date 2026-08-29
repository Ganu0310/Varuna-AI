import { Link } from 'react-router-dom';

/**
 * `/guide` — what the features do, in the order you would use them.
 *
 * Written as a working guide rather than a feature list, because the pipeline is sequential
 * and most confusion comes from meeting a step out of order: an empty candidate list is not a
 * bug, it is a missing origin estimate two steps back.
 *
 * It also states, plainly, what the system cannot do. A user who discovers the limits by
 * hitting them wastes an afternoon and distrusts everything else; a user told up front that
 * AIS covers US waters only will choose a different area, or accept that attribution is not
 * available for theirs.
 */
export function GuidePage() {
  return (
    <main className="page guide">
      <h1>How to use VARUNA</h1>
      <p className="guide-lede">
        VARUNA links an oil slick seen from space to the vessels that were near it. It ranks
        investigative leads — it does not determine responsibility, and every screen is built to
        keep that distinction visible.
      </p>

      <nav className="guide-toc">
        <a href="#chain">The chain</a>
        <a href="#start">Starting an investigation</a>
        <a href="#reading">Reading a result</a>
        <a href="#views">The three views</a>
        <a href="#limits">What it cannot do</a>
        <a href="#terms">Terms</a>
      </nav>

      <section id="chain" className="card">
        <h2>The chain</h2>
        <p>
          Five steps, strictly in order. Each needs the one before it, and the server refuses a step
          whose precondition is missing rather than producing a weaker answer.
        </p>
        <ol className="guide-chain">
          <li>
            <strong>Find a scene.</strong> Search real satellite catalogues for a Sentinel-1
            acquisition covering your area and time.
          </li>
          <li>
            <strong>Ingest it.</strong> The scene is downloaded, windowed to your area, and the
            detector runs automatically. You get dark-feature candidates with a confidence and a
            look-alike risk.
          </li>
          <li>
            <strong>Review the detections.</strong> Confirm or reject. An unreviewed detection is
            drawn differently from a confirmed one everywhere it appears, including in the dossier.
          </li>
          <li>
            <strong>Back-track to an origin.</strong> A drift ensemble runs backwards from the slick
            through real current and wind fields, producing a release area and a release time
            window.
          </li>
          <li>
            <strong>Correlate AIS.</strong> Every vessel transmitting in that area during that
            window is scored across twelve evidence features and ranked.
          </li>
        </ol>
        <p className="field-hint">
          The <strong>Progress</strong> panel in each workspace shows which of these has run and
          what to do next.
        </p>
      </section>

      <section id="start" className="card">
        <h2>Starting an investigation</h2>
        <p>
          <Link to="/investigations/new">New investigation</Link> needs three things: a name, an
          area, and a UTC time window.
        </p>
        <h3>The area</h3>
        <p>
          Easiest is to pick from <strong>Known areas</strong> — each entry is somewhere a slick has
          actually been observed, and each states whether AIS is available there. Otherwise type a
          bounding box as <code>west,south,east,north</code>, for example{' '}
          <code>144.55,13.3,144.95,13.6</code>. GeoJSON also works. The area readout shows the size
          against the 50,000 km² limit as you type.
        </p>
        <h3>The window</h3>
        <p>
          Up to 30 days, in UTC. Keep it tight around the suspected incident: a wider window means
          more vessels to consider and a weaker discrimination between them.
        </p>
        <p className="field-hint">
          <strong>Search catalogues</strong> before creating. It is a live query against real
          providers, and it tells you whether any imagery exists for that area and window at all.
        </p>
      </section>

      <section id="reading" className="card">
        <h2>Reading a result</h2>
        <h3>Scores are not probabilities</h3>
        <p>
          A score of 70 does not mean a 70% chance of responsibility. Scores are{' '}
          <strong>uncalibrated weighted evidence</strong>, comparable between candidates in one
          report and not between reports. Calibration needs validated incidents the project does not
          yet have.
        </p>
        <h3>Unmeasured is not zero</h3>
        <p>
          Each candidate is scored on twelve features, and any that could not be measured are shown
          hatched rather than hidden. The score is renormalised over the measured features only, so
          a missing feature neither helps nor harms — but a candidate scored on six features is a
          weaker case than one scored on twelve, and the count is always shown. Below six the score
          is withheld entirely.
        </p>
        <h3>Tiers</h3>
        <p>
          <span className="token tier-strong">STRONG</span>{' '}
          <span className="token tier-moderate">MODERATE</span>{' '}
          <span className="token tier-weak">WEAK</span>{' '}
          <span className="token tier-insufficient_evidence">INSUFFICIENT EVIDENCE</span>
        </p>
        <p>
          If the origin estimate is DEGRADED, every candidate is capped at MODERATE however high its
          score. A degraded origin is a proximity buffer, and proximity cannot separate a
          discharging vessel from ordinary passing traffic.
        </p>
        <h3>Click into the evidence</h3>
        <p>
          Open <strong>Evidence</strong> on any candidate for the per-feature breakdown, then click
          a feature name to see what was actually measured, in what unit, and from which
          observations. The vessel panel shows how much identity the AIS archive really supports —
          usually a number and a flag, and nothing else.
        </p>
      </section>

      <section id="views" className="card">
        <h2>The three views</h2>
        <h3>Dossier</h3>
        <p>
          The printable report. Uncertainty and Provenance are mandatory sections and cannot be
          removed — the server refuses a report without them. Exports (GeoJSON, CSV, run manifest)
          let someone check the finding without trusting this interface.
        </p>
        <h3>Space–time prism</h3>
        <p>
          Time as the vertical axis, so a vessel track becomes a helix and the release estimate
          becomes a slab. Where a helix passes through the slab, that vessel was in the plausible
          release area <em>during</em> the plausible release window. On a flat map two vessels
          crossing the same water twelve hours apart look identical; here they do not.
        </p>
        <h3>Slick relief</h3>
        <p>
          The SAR image as 3D terrain. A slick appears as a basin because oil damps waves and
          returns less energy. <strong>The relief is backscatter, not sea-surface height.</strong>{' '}
          Drag the exaggeration to 0 to check a basin is really in the data.
        </p>
      </section>

      <section id="limits" className="card">
        <h2>What it cannot do</h2>
        <ul className="guide-limits">
          <li>
            <strong>AIS covers US waters only.</strong> The free bulk archive is NOAA Marine
            Cadastre. Elsewhere you will get imagery and detections and then no candidates — not
            because no vessel was there, but because we cannot see who was.
          </li>
          <li>
            <strong>A vessel not transmitting cannot be considered at all.</strong> A high rank may
            reflect sparse coverage rather than strong evidence.
          </li>
          <li>
            <strong>The detector cannot tell oil from a look-alike by texture.</strong> It finds
            dark features and scores how oil-like their shape and context are. Measured on a
            held-out split it fires on 68% of scenes containing a look-alike, and — importantly —
            reports low look-alike risk when it does. Treat a detection as a lead to verify.
          </li>
          <li>
            <strong>No wind data is configured</strong>, so the wind-suitability term is unknown.
            Below about 3 m/s the sea goes dark on its own and detection is close to meaningless.
          </li>
          <li>
            <strong>Ocean-current coverage has gaps.</strong> When no forcing covers the incident
            date, back-tracking falls back to footprint proximity and says so.
          </li>
        </ul>
      </section>

      <section id="terms" className="card">
        <h2>Terms</h2>
        <dl className="kv guide-terms">
          <dt>AOI</dt>
          <dd>Area of interest — the box or polygon you are investigating.</dd>
          <dt>SAR / σ⁰</dt>
          <dd>
            Synthetic aperture radar, and its calibrated backscatter. Oil damps small waves, so a
            slick returns less energy and looks dark.
          </dd>
          <dt>Look-alike</dt>
          <dd>
            Anything else that looks dark on radar: low-wind zones, biogenic films, rain cells, wind
            shadows.
          </dd>
          <dt>MMSI</dt>
          <dd>
            A vessel's radio identity in AIS. On its own it is a number, not an identification.
          </dd>
          <dt>Dark period</dt>
          <dd>
            A gap in a vessel's AIS transmission. A gap over the release area during the release
            window is one of the strongest signals in the model.
          </dd>
          <dt>Provenance</dt>
          <dd>
            The record of where a value came from. Every object carries one; anything without one is
            removed rather than displayed.
          </dd>
        </dl>
      </section>
    </main>
  );
}
