from fastapi.testclient import TestClient

from varuna_ml.main import app

client = TestClient(app)


def test_health_ok():
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "varuna-ml"
    assert set(["gpu", "modelLoaded", "forcingCacheAge"]).issubset(body.keys())


def test_root_identifies_service():
    res = client.get("/")
    assert res.status_code == 200
    assert res.json()["name"] == "varuna-ml"


def test_provenance_has_no_fabricated_source_type():
    from varuna_ml.provenance import SourceType
    import typing

    members = set(typing.get_args(SourceType))
    for forbidden in {"MOCK", "SYNTHETIC", "FAKE", "DEMO", "TEST", "PLACEHOLDER"}:
        assert forbidden not in members
