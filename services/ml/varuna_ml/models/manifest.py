"""Dataset manifest validation — 07_AIML 7.4.5, 13_REAL_DATA_POLICY 13.6 check 5.

`validate_manifest()` is called before any training run and REFUSES TO START on an
incomplete entry. That ordering is the point: it is trivially easy to train on whatever
happens to be on disk and only afterwards wonder where it came from, at which point the
resulting weights cannot be defended. Failing before the first epoch makes the provenance
question unavoidable.

An entry must carry a citation, a licence, a retrieval timestamp, a checksum, `real_data:
true` and `synthetic_content: none`. The augmentation list is cross-checked against a
forbidden set, because a label-altering augmentation (pasting slicks, GAN synthesis) would
inject fabricated observations into training while every individual file still looked real.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

REQUIRED_ENTRY_FIELDS = (
    "id",
    "provider",
    "citation",
    "licence",
    "retrieved_at",
    "sha256",
    "real_data",
    "synthetic_content",
)

# Augmentations that change what the image asserts about the world, rather than how it is
# presented. These fabricate observations (13_REAL_DATA_POLICY 13.3.3).
FORBIDDEN_AUGMENTATIONS = frozenset(
    {"gan_synthesis", "diffusion_synthesis", "pasted_slicks", "simulated_ais", "copy_paste"}
)

PENDING_MARKERS = frozenset({"PENDING_DOWNLOAD", "PENDING", "TODO", "TBD", ""})


@dataclass
class ManifestReport:
    ok: bool
    entries: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def raise_if_invalid(self) -> None:
        if not self.ok:
            raise ValueError(
                "dataset manifest is not usable for training:\n  - " + "\n  - ".join(self.errors)
            )


def validate_manifest(path: Path, *, require_downloaded: bool = True) -> ManifestReport:
    """Validate a dataset manifest.

    `require_downloaded=False` allows a manifest that declares an intended dataset whose
    archive has not yet been fetched — the state a project is in before acquisition. Such a
    manifest is valid to hold, but training must call with the default `True`, so a run
    cannot begin against `sha256: PENDING_DOWNLOAD`.
    """
    report = ManifestReport(ok=True)

    if not path.exists():
        report.ok = False
        report.errors.append(f"manifest not found at {path}")
        return report

    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        report.ok = False
        report.errors.append(f"manifest is not valid YAML: {e}")
        return report

    root = doc.get("dataset_manifest")
    if not isinstance(root, dict):
        report.ok = False
        report.errors.append("missing top-level `dataset_manifest` mapping")
        return report

    entries = root.get("entries") or []
    if not entries:
        report.ok = False
        report.errors.append("manifest declares no entries — there is nothing to train on")
        return report

    report.entries = len(entries)

    for i, entry in enumerate(entries):
        label = entry.get("id", f"entry[{i}]")

        for fieldname in REQUIRED_ENTRY_FIELDS:
            if fieldname not in entry:
                report.errors.append(f"{label}: missing required field `{fieldname}`")

        if entry.get("real_data") is not True:
            report.errors.append(f"{label}: `real_data` must be true")

        synthetic = entry.get("synthetic_content")
        if synthetic not in (None, "none"):
            report.errors.append(
                f"{label}: `synthetic_content` is {synthetic!r}; only 'none' is permitted"
            )

        citation = str(entry.get("citation", "")).strip()
        if len(citation) < 20:
            report.errors.append(
                f"{label}: `citation` is missing or too short to identify a source"
            )

        licence = str(entry.get("licence", "")).strip()
        if not licence:
            report.errors.append(f"{label}: `licence` is required")

        for fieldname in ("sha256", "retrieved_at"):
            value = str(entry.get(fieldname, "")).strip().upper()
            if value in PENDING_MARKERS:
                msg = f"{label}: `{fieldname}` is a placeholder ({entry.get(fieldname)!r})"
                if require_downloaded:
                    report.errors.append(
                        msg + " — the archive has not been retrieved, so training cannot start"
                    )
                else:
                    report.warnings.append(msg + " — acceptable only before acquisition")

        split = entry.get("split")
        if isinstance(split, dict):
            total = sum(float(v) for v in split.values())
            if abs(total - 1.0) > 1e-6:
                report.errors.append(f"{label}: split fractions sum to {total}, not 1.0")

        strategy = str(entry.get("split_strategy", "")).lower()
        if strategy and "random tile" in strategy and "never" not in strategy:
            # Random-tile splitting leaks the same scene into train and test, inflating
            # every metric (07_AIML 7.2.12).
            report.errors.append(
                f"{label}: split_strategy appears to permit random-tile splitting, which leaks "
                "adjacent pixels between train and test"
            )

    aug = root.get("augmentation") or {}
    permitted = {str(a).lower() for a in (aug.get("permitted") or [])}
    forbidden_used = permitted & FORBIDDEN_AUGMENTATIONS
    if forbidden_used:
        report.errors.append(
            f"permitted augmentations include forbidden entries: {sorted(forbidden_used)}"
        )

    if root.get("assertion") != "no_synthetic_samples":
        report.warnings.append("manifest does not carry the `no_synthetic_samples` assertion")

    report.ok = not report.errors
    return report
