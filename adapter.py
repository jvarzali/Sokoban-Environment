import argparse

from env import SokobanEnv
from src.env_sdk import serve

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8765)
    a = p.parse_args()
    serve(SokobanEnv, host=a.host, port=a.port)
