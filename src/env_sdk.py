"""Minimal local stand-in for the Mesocosm env SDK.

The real deployment imports `BaseEnv`, `StepResult`, and `serve` from the
Mesocosm SDK. This shim provides the same surface so the environment can be
developed, unit-tested, and exercised by hand (`curl health/reset/step/close`)
without the full framework installed. Swap this module for the real SDK at
submission time; `env.py` and `adapter.py` need no changes.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
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
    """Base class for an episodic environment."""

    def reset(self, seed=None, **params):  # pragma: no cover - overridden
        raise NotImplementedError

    def step(self, action):  # pragma: no cover - overridden
        raise NotImplementedError

    def close(self):
        return None


class _ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """HTTP server that handles each request in its own thread."""
    daemon_threads = True


def serve(env_cls, host: str = "0.0.0.0", port: int = 8765):
    """Serve a single env instance, serialising concurrent episodes.

    The platform runs all episodes concurrently and calls /reset for each
    one before sending any steps. Without serialisation every episode ends
    up sharing the same env state, producing garbage results.

    Fix: /reset acquires a lock that is only released by /close (or when a
    step returns terminated/truncated). Because the platform waits for the
    /reset response before sending steps, blocking /reset is enough to make
    episodes queue up and run one at a time.

    Endpoints (all JSON bodies):
      GET  /health  -> {"status": "ok"}
      POST /reset   {seed?, ...params}  -> {"observation": <obs>}
      POST /step    {"action": "N"}     -> StepResult.to_dict()
      POST /close   -> {"closed": true}
    """
    env = env_cls()
    episode_lock = threading.Lock()

    def _release():
        try:
            episode_lock.release()
        except RuntimeError:
            pass  # already released — that's fine

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
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
            # Accept both /cmd and /envs/{id}/cmd (platform proxy may add prefix)
            parts = self.path.strip("/").split("/")
            endpoint = "/" + (parts[2] if len(parts) >= 3 and parts[0] == "envs" else parts[0])
            data = self._read_json()
            try:
                if endpoint == "/reset":
                    # Block until the previous episode finishes.
                    # The platform won't send steps until it gets this response,
                    # so holding the lock here serialises episodes end-to-end.
                    episode_lock.acquire()
                    try:
                        seed = data.pop("seed", None)
                        obs = env.reset(seed=seed, **data)
                        self._send(200, {"observation": obs})
                    except Exception:
                        _release()
                        raise
                elif endpoint == "/step":
                    result = env.step(data.get("action", ""))
                    self._send(200, result.to_dict())
                    # Release early if the episode is naturally over so the
                    # next /reset doesn't have to wait for a /close that may
                    # never come.
                    if result.terminated or result.truncated:
                        _release()
                elif endpoint == "/close":
                    env.close()
                    _release()
                    self._send(200, {"closed": True})
                else:
                    self._send(404, {"error": "not found"})
            except Exception as exc:
                self._send(500, {"error": str(exc)})

    httpd = _ThreadingHTTPServer((host, port), Handler)
    print(f"serving {env_cls.__name__} on http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _release()
        env.close()
        httpd.server_close()
