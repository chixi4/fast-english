from __future__ import annotations

import contextlib
import socket
import threading
import time
from collections.abc import Iterator

import uvicorn
from fastapi import FastAPI


def _pick_free_port(host: str = "127.0.0.1") -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind((host, 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


@contextlib.contextmanager
def run_live_server(app: FastAPI, host: str = "127.0.0.1") -> Iterator[str]:
    port = _pick_free_port(host)
    config = uvicorn.Config(
        app=app,
        host=host,
        port=port,
        log_level="warning",
        access_log=False,
        lifespan="on",
    )
    server = uvicorn.Server(config=config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    timeout_at = time.time() + 10.0
    while time.time() < timeout_at:
        if bool(server.started):
            break
        if not thread.is_alive():
            raise RuntimeError("live server thread exited before startup")
        time.sleep(0.05)
    else:
        raise RuntimeError("live server startup timeout")

    try:
        yield f"http://{host}:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5.0)
