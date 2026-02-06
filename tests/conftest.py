from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _load_main(tmp_path: Path):
    os.environ["APP_DB_PATH"] = str(tmp_path / "app.db")
    os.environ["APP_AUTH_DB_PATH"] = str(tmp_path / "auth.db")
    os.environ["APP_REQUIRE_LOGIN"] = "0"
    os.environ["APP_MULTIUSER_BY_IDENTITY"] = "0"
    os.environ["APP_DEV_USER_IDENTITY"] = ""

    os.environ["AI_MOCK"] = "1"
    os.environ["AI_API_KEY"] = ""
    os.environ["AI_BASE_URL"] = "http://example.invalid/v1"

    # Ensure tests aren't blocked by any local .env basic auth.
    os.environ["APP_BASIC_AUTH_USER"] = ""
    os.environ["APP_BASIC_AUTH_PASS"] = ""

    if "app.main" in sys.modules:
        main = importlib.reload(sys.modules["app.main"])
    else:
        import app.main as main  # type: ignore
    return main


@pytest.fixture()
def main_module(tmp_path: Path):
    main = _load_main(tmp_path)
    yield main


@pytest.fixture()
def client(main_module):
    with TestClient(main_module.app) as c:
        yield c

