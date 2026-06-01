"""Minimal local stand-in for the Mesocosm env SDK.

The real deployment imports `BaseEnv`, `StepResult`, and `serve` from the
Mesocosm SDK. This shim provides the same surface so the environment can be
developed, unit-tested, and exercised by hand (`curl health/reset/step/close`)
without the full framework installed. Swap this module for the real SDK at
submission time; `env.py` and `adapter.py` need no changes.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any


@dataclass
class StepResult:
    """Outcome of one environment step."""
    observation: Any
    reward: float
    terminated: bool
    truncated: bool
    info: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "observation": self.observation,
            "reward": self.reward,
            "terminated": self.terminated,
            "truncated": self.truncated,
            "info": self.info,
        }


class BaseEnv:
    """Base class for an episodic environment.

    Subclasses implement `reset(self, seed=None, **params) -> observation`
    and `step(self, action) -> StepResult`.
    """

    def reset(self, seed=None, **params):  # pragma: no cover - overridden
        raise NotImplementedError

    def step(self, action):  # pragma: no cover - overridden
        raise NotImplementedError

    def close(self):
        """Release any resources. Default is a no-op."""
        return None


def serve(env_cls, host: str = "0.0.0.0", port: int = 8765):
    """Serve env instances over a tiny JSON/HTTP protocol.

    Supports two URL formats:
      Flat:    /reset  /step  /close          (local dev / simple callers)
      Prefixed: /envs/{session-id}/reset  etc. (platform proxy adds a session ID
                                               in the path — used for isolation)

    In the prefixed form the session-id is used as a key so each concurrent
    episode gets its own SokobanEnv instance and they can't corrupt each other.

    Endpoints (all JSON bodies):
      GET  /health  -> {"status": "ok"}
      POST /reset   {seed?, ...params}  -> {"observation": <obs>}
      POST /step    {"action": "N"}     -> StepResult.to_dict()
      POST /close   -> {"closed": true}
    """
    import threading
    _envs: dict = {}          # session_key -> env instance
    _default_env = env_cls()  # used when no session id is present
    _lock = threading.Lock()

    def _get_or_create(session_key):
        with _lock:
            if session_key not in _envs:
                _envs[session_key] = env_cls()
            return _envs[session_key]

    def _parse_route(path):
        """Return (session_key, endpoint) from either /cmd or /envs/{id}/cmd."""
        parts = path.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "envs":
            return parts[1], "/" + parts[2]   # ("/envs/abc123/step" -> "abc123", "/step")
        return None, "/" + parts[0]           # ("/step" -> None, "/step")

    _env = _default_env  # kept for the flat (no session) path

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):  # quiet by default
            pass

        def _send(self, code: int, payload: dict):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length", 0) or 0)
            if not length:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8")) if raw else {}
            except json.JSONDecodeError:
                return {}

        def do_GET(self):
            if self.path.rstrip("/") in ("", "/health"):
                self._send(200, {"status": "ok"})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            session_key, endpoint = _parse_route(self.path)
            env = _get_or_create(session_key) if session_key else _env
            data = self._read_json()
            try:
                if endpoint == "/reset":
                    seed = data.pop("seed", None)
                    obs = env.reset(seed=seed, **data)
                    self._send(200, {"observation": obs})
                elif endpoint == "/step":
                    result = env.step(data.get("action", ""))
                    self._send(200, result.to_dict())
                elif endpoint == "/close":
                    env.close()
                    if session_key:
                        with _lock:
                            _envs.pop(session_key, None)
                    self._send(200, {"closed": True})
                else:
                    self._send(404, {"error": "not found"})
            except Exception as exc:  # surface errors to the client
                self._send(500, {"error": str(exc)})

    httpd = HTTPServer((host, port), Handler)
    print(f"serving {env_cls.__name__} on http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        env.close()
        httpd.server_close()
