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

    One env instance is created per seed so concurrent episodes from the
    platform don't corrupt each other's state. /step is routed to whichever
    env was most recently reset by the same remote address.

    Endpoints (all JSON bodies):
      GET  /health  -> {"status": "ok"}
      POST /reset   {seed?, ...params}  -> {"observation": <obs>}
      POST /step    {"action": "N"}     -> StepResult.to_dict()
      POST /close   -> {"closed": true}
    """
    import threading
    envs: dict = {}      # seed -> env instance
    client_seed: dict = {}  # client_address -> last seed reset by that client
    lock = threading.Lock()

    def get_env_for_client(client_address):
        with lock:
            seed = client_seed.get(client_address)
            if seed is not None and seed in envs:
                return envs[seed]
        # Fall back to a default env if no session tracked
        with lock:
            if "default" not in envs:
                envs["default"] = env_cls()
            return envs["default"]

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
            route = self.path.rstrip("/")
            data = self._read_json()
            client = self.client_address
            try:
                if route == "/reset":
                    seed = data.pop("seed", None)
                    with lock:
                        key = seed if seed is not None else "default"
                        if key not in envs:
                            envs[key] = env_cls()
                        env = envs[key]
                        client_seed[client] = key
                    obs = env.reset(seed=seed, **data)
                    self._send(200, {"observation": obs})
                elif route == "/step":
                    env = get_env_for_client(client)
                    result = env.step(data.get("action", ""))
                    self._send(200, result.to_dict())
                elif route == "/close":
                    env = get_env_for_client(client)
                    env.close()
                    with lock:
                        key = client_seed.pop(client, None)
                        if key is not None:
                            envs.pop(key, None)
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
