from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field

SourceType = Literal[
    "SATELLITE_SCENE",
    "AIS_ARCHIVE",
    "AIS_API",
    "AIS_STREAM",
    "OCEAN_MODEL",
    "ATMOSPHERIC_MODEL",
    "COASTLINE_VECTOR",
    "VESSEL_REGISTRY",
    "HUMAN_ANNOTATION",
    "DERIVED",
]


class Provenance(BaseModel):
    """Pydantic mirror of packages/shared Provenance (02_TRD §2.4.1). No MOCK/SYNTHETIC/TEST
    member exists by design (13_REAL_DATA_POLICY §13.4). Every ML response carries one."""

    sourceType: SourceType
    provider: str = Field(min_length=1)
    datasetId: str = Field(min_length=1)
    externalId: str = Field(min_length=1)
    retrievedAt: str
    licence: str = Field(min_length=1)
    accessUrl: str | None = None
    checksum: str | None = None
    derivedFrom: list[str] = Field(default_factory=list)
    processingManifestId: str | None = None


def derived(external_id: str, parents: list[str], dataset_id: str = "varuna-ml") -> Provenance:
    """Provenance for a value this service computed from real inputs (sourceType DERIVED,
    with derivedFrom pointing at the parent provenance IDs — 13_REAL_DATA_POLICY §13.5.1)."""
    return Provenance(
        sourceType="DERIVED",
        provider="VARUNA",
        datasetId=dataset_id,
        externalId=external_id,
        retrievedAt=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        licence="internal",
        derivedFrom=parents,
    )
