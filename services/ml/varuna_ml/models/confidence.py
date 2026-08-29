"""Detection confidence — 07_AIML 7.2.11.

The whole point of this module is that confidence is returned as FOUR SEPARATE TERMS, never
collapsed into one opaque number before it reaches the analyst. A single "0.61" tells nobody
whether the detection is weak because the model was unsure, because the sea was glassy, or
because the shape looks like a rain cell — and those three cases demand different responses.

    overall = 0.40*model + 0.25*separation + 0.20*wind + 0.15*shape

The weights favour the model/separation terms because they measure the observation itself,
while wind and shape are context. Every term, and its raw input, is carried through to the
UI and the PDF so a reviewer can see which one is dragging the score.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class ConfidenceBreakdown:
    """Four independent terms plus the combined value."""

    model_term: float
    separation_term: float
    wind_term: float
    shape_term: float
    overall: float

    # the raw inputs, so the UI can show "4.2 dB" rather than only "0.42"
    mean_oil_probability: float | None
    contrast_db: float | None
    wind_ms: float | None
    look_alike_risk: float | None
    wind_known: bool


def wind_suitability(u10_ms: float | None) -> float:
    """Piecewise trapezoid over 10 m wind speed — 07_AIML 7.2.3.

        < 2 or > 14 m/s -> 0.05   sea is glassy, or the slick is re-roughened away
        2-3, 12-14      -> 0.30   marginal
        4-9             -> 1.00   the detectability sweet spot
        otherwise       -> 0.70

    An UNKNOWN wind returns 0.5, not 1.0: absence of a measurement is not evidence of good
    conditions, and defaulting it high would silently inflate every confidence score in a
    region where the wind chain is unavailable.
    """
    if u10_ms is None:
        return 0.5
    if u10_ms < 2.0 or u10_ms > 14.0:
        return 0.05
    if u10_ms < 3.0 or u10_ms > 12.0:
        return 0.30
    if 4.0 <= u10_ms <= 9.0:
        return 1.00
    return 0.70


def detection_confidence(
    mean_oil_probability: float | None,
    contrast_db: float | None,
    wind_ms: float | None,
    look_alike_risk: float | None,
) -> ConfidenceBreakdown:
    """Combine the four terms, keeping each one visible.

    `mean_oil_probability` is None for the classical detector, which produces no calibrated
    per-pixel probability. Rather than substituting a fabricated value, the model term falls
    back to the separation evidence — and `mean_oil_probability` stays None in the output so
    the UI can show that this detector does not provide one.
    """
    # Separation: how much darker than the local sea background. ~10 dB is unambiguous.
    separation_term = _clamp((contrast_db or 0.0) / 10.0)

    # Model: a learned detector supplies a calibrated probability. The classical detector
    # does not, so it defers to separation instead of inventing a number.
    model_term = (
        _clamp(mean_oil_probability) if mean_oil_probability is not None else separation_term
    )

    wind_term = wind_suitability(wind_ms)
    shape_term = _clamp(1.0 - (look_alike_risk if look_alike_risk is not None else 0.5))

    overall = _clamp(
        0.40 * model_term + 0.25 * separation_term + 0.20 * wind_term + 0.15 * shape_term
    )

    return ConfidenceBreakdown(
        model_term=round(model_term, 3),
        separation_term=round(separation_term, 3),
        wind_term=round(wind_term, 3),
        shape_term=round(shape_term, 3),
        overall=round(overall, 3),
        mean_oil_probability=(
            round(mean_oil_probability, 3) if mean_oil_probability is not None else None
        ),
        contrast_db=round(contrast_db, 2) if contrast_db is not None else None,
        wind_ms=round(wind_ms, 2) if wind_ms is not None else None,
        look_alike_risk=round(look_alike_risk, 3) if look_alike_risk is not None else None,
        wind_known=wind_ms is not None,
    )


def _clamp(x: float | None) -> float:
    if x is None:
        return 0.0
    return max(0.0, min(1.0, float(x)))


def confidence_to_dict(c: ConfidenceBreakdown) -> dict:
    return asdict(c)
