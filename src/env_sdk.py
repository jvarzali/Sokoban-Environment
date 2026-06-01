"""Local stand-in for the Mesocosm env SDK.

The real SDK (bench_common.env_sdk.server) routes every /reset, /step, and
/close call by episode_id and keeps one env instance per episode so concurrent
episodes never share state.  This shim replicates that behaviour so that the
platform's parallel episodes work correctly.

Endpoints (all JSON bodies):
  GET  /health
  POST /reset   {"episode_id": "...", "seed": N, ...}  -> {"observation": obs}
  POST /step    {"episode_id": "...", "action": "N"}   -> StepResult dict
  POST /close   {"episode_id": "..."}                  -> {"closed": true}
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

_EPISODE_TTL_SECONDS = 3600.0


@dataclass
class StepResult:
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
    def reset(self, seed=None, **params):  # pragma: no cover
        raise NotImplementedError

    def step(self, action):  # pragma: no cover
        raise NotImplementedError

    def close(self):
        return None


def serve(env_cls, host: str = "0.0.0.0", port: int = 8765):
    # One env instance per episode_id — mirrors bench_common.env_sdk.server
    _episodes: dict[str, Any] = {}
    _last_seen: dict[str, float] = {}

    def _touch(ep: str) -> None:
        _last_seen[ep] = time.monotonic()

    def _reap() -> None:
        cutoff = time.monotonic() - _EPISODE_TTL_SECONDS
        stale = [ep for ep, ts in _last_seen.items() if ts < cutoff]
        for ep in stale:
            env = _episodes.pop(ep, None)
            _last_seen.pop(ep, None)
            if env:
                try:
                    env.close()
                except Exception:
                    pass

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
                self._send(200, {"status": "ok", "episodes": len(_episodes)})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            # Accept /cmd and /envs/{id}/cmd path formats
            parts = self.path.strip("/").split("/")
            endpoint = "/" + (parts[2] if len(parts) >= 3 and parts[0] == "envs"
                               else parts[0])
            data = self._read_json()

            # episode_id is sent by the platform in the request body
            episode_id = data.get("episode_id", "__default__")

            try:
                _reap()

                if endpoint == "/reset":
                    # Close any existing env for this episode
                    existing = _episodes.pop(episode_id, None)
                    if existing:
                        try:
                            existing.close()
                        except Exception:
                            pass
                    env = env_cls()
                    _episodes[episode_id] = env
                    _touch(episode_id)
                    seed = data.get("seed")
                    params = {k: v for k, v in data.items()
                              if k not in ("episode_id", "seed")}
                    obs = env.reset(seed=seed, **params)
                    self._send(200, {"observation": obs})

                elif endpoint == "/step":
                    env = _episodes.get(episode_id)
                    if env is None:
                        self._send(404, {"error": f"no episode {episode_id!r}"})
                        return
                    _touch(episode_id)
                    result = env.step(data.get("action", ""))
                    self._send(200, result.to_dict())

                elif endpoint == "/close":
                    env = _episodes.pop(episode_id, None)
                    _last_seen.pop(episode_id, None)
                    if env:
                        try:
                            env.close()
                        except Exception:
                            pass
                    self._send(200, {"closed": True})

                else:
                    self._send(404, {"error": "not found"})

            except Exception as exc:
                self._send(500, {"error": str(exc)})

    httpd = HTTPServer((host, port), Handler)
    print(f"serving {env_cls.__name__} on http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for env in _episodes.values():
            try:
                env.close()
            except Exception:
                pass
        httpd.server_close()
