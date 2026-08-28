"""Content-addressed model registry — 07_AIML 7.7, 13_REAL_DATA_POLICY C9.

A model is identified by the SHA-256 of its weights, not by a name or a version string. The
reason is evidentiary: a report says "detected by model 3f9a2c…", and that hash must resolve
to exactly one artefact forever. Names get reused; hashes do not.

Registration REFUSES an entry that cannot state:
  - the SHA-256 of the artefact it describes
  - metrics measured on a real, held-out test split
  - the dataset manifest hash those metrics came from
  - the git SHA of the code that produced it
  - `realDataOnly: true`

A model with no measured metrics can still be registered — the classical detector is such a
case — but it must say so explicitly with `metrics: null` and a stated reason. What is
forbidden is a placeholder number that looks like a measurement.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path


class RegistryError(ValueError):
    """Raised when an entry would misrepresent how a model was evaluated."""


@dataclass
class ModelMetrics:
    """Metrics on the held-out real test split — 07_AIML 7.2.12.

    Pixel accuracy is deliberately absent: on a scene that is 99% sea, a model predicting
    "no oil" everywhere scores 99% and is useless. It must never be reported.
    """

    oil_iou: float
    oil_dice_f1: float
    oil_precision: float
    oil_recall: float
    mean_iou: float
    look_alike_to_oil_fp_rate: float
    boundary_f1_2px: float | None = None
    per_scene_detection_rate: float | None = None
    seeds: int = 1
    std: dict | None = None


@dataclass
class ModelEntry:
    sha256: str
    name: str
    version: str
    architecture: str
    """None only for a detector that was not trained; the reason is then mandatory."""
    metrics: dict | None
    metrics_absent_reason: str | None
    dataset_manifest_sha256: str | None
    git_sha: str
    registered_at: str
    input_bands: list[str]
    classes: list[str]
    real_data_only: bool = True
    notes: str = ""
    latency_budget: dict = field(default_factory=dict)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def current_git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        return "unknown"


def register_model(
    registry_path: Path,
    *,
    sha256: str,
    name: str,
    version: str,
    architecture: str,
    input_bands: list[str],
    classes: list[str],
    metrics: ModelMetrics | None = None,
    metrics_absent_reason: str | None = None,
    dataset_manifest_sha256: str | None = None,
    notes: str = "",
    latency_budget: dict | None = None,
) -> ModelEntry:
    """Add or replace an entry. Raises rather than record an unverifiable claim."""
    if not sha256 or len(sha256) != 64:
        raise RegistryError("a model must be content-addressed by a full SHA-256")

    if metrics is None and not metrics_absent_reason:
        raise RegistryError(
            "metrics are absent, so metrics_absent_reason is required — a model with no "
            "measured performance must say so rather than leaving the field blank"
        )
    if metrics is not None and not dataset_manifest_sha256:
        raise RegistryError(
            "metrics were supplied without a dataset manifest hash; a metric that cannot be "
            "traced to the data it was measured on is not a measurement"
        )

    entry = ModelEntry(
        sha256=sha256,
        name=name,
        version=version,
        architecture=architecture,
        metrics=asdict(metrics) if metrics else None,
        metrics_absent_reason=metrics_absent_reason,
        dataset_manifest_sha256=dataset_manifest_sha256,
        git_sha=current_git_sha(),
        registered_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        input_bands=input_bands,
        classes=classes,
        real_data_only=True,
        notes=notes,
        latency_budget=latency_budget or {},
    )

    registry = load_registry(registry_path)
    registry[sha256] = asdict(entry)
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(json.dumps(registry, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return entry


def load_registry(registry_path: Path) -> dict:
    if not registry_path.exists():
        return {}
    return json.loads(registry_path.read_text(encoding="utf-8"))


def get_model(registry_path: Path, sha256: str) -> dict | None:
    return load_registry(registry_path).get(sha256)


def promotion_allowed(
    candidate: ModelMetrics,
    deployed: ModelMetrics | None,
    *,
    min_oil_iou: float = 0.55,
    max_look_alike_fp: float = 0.20,
) -> tuple[bool, str]:
    """CI model-evaluation gate — 03_ARCHITECTURE 3.10, Phase 5 exit criteria.

    A model may not be promoted if it fails the MVP floor, or if it regresses against the
    currently deployed model on either the oil-IoU or the look-alike false-positive rate.
    The second condition matters more than it looks: a model can raise IoU while calling
    more look-alikes oil, which produces a system that accuses more innocent vessels.
    """
    if candidate.oil_iou < min_oil_iou:
        return False, f"oil IoU {candidate.oil_iou:.3f} is below the MVP floor {min_oil_iou}"
    if candidate.look_alike_to_oil_fp_rate > max_look_alike_fp:
        return (
            False,
            f"look-alike to oil FP rate {candidate.look_alike_to_oil_fp_rate:.3f} exceeds "
            f"{max_look_alike_fp}",
        )
    if deployed is not None:
        if candidate.oil_iou < deployed.oil_iou:
            return (
                False,
                f"oil IoU regressed: {candidate.oil_iou:.3f} < deployed {deployed.oil_iou:.3f}",
            )
        if candidate.look_alike_to_oil_fp_rate > deployed.look_alike_to_oil_fp_rate:
            return (
                False,
                "look-alike false positives regressed: "
                f"{candidate.look_alike_to_oil_fp_rate:.3f} > deployed "
                f"{deployed.look_alike_to_oil_fp_rate:.3f}",
            )
    return True, "meets the floor and does not regress against the deployed model"
