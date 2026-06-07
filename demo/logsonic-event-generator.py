#!/usr/bin/env python3
"""Generate an endless stream of synthetic LogSonic-friendly events."""

from __future__ import annotations

import argparse
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TextIO


GROK_PATTERN = (
    'ts=%{TIMESTAMP_ISO8601:timestamp} '
    'level=%{WORD:level} '
    'service=%{WORD:service} '
    'host=%{DATA:host} '
    'status=%{NUMBER:status} '
    'latency_ms=%{NUMBER:latency_ms} '
    'request_id=%{DATA:request_id} '
    'user=%{DATA:user} '
    'route=%{DATA:route} '
    'msg="%{GREEDYDATA:message}"'
)

SERVICES = ("gateway", "orders", "billing", "search", "auth", "worker")
ROUTES = (
    "/api/orders",
    "/api/cart",
    "/api/checkout",
    "/api/search",
    "/api/session",
    "/jobs/reconcile",
)
HOSTS = ("edge-01", "edge-02", "app-01", "app-02", "worker-01")
USERS = tuple(f"user-{1000 + i}" for i in range(120))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate structured synthetic log events forever. Pipe stdout into "
            "`logsonic tail -`, or write to a file that LogSonic follows with "
            "`logsonic tail -f`."
        )
    )
    parser.add_argument(
        "--rate",
        type=float,
        default=5.0,
        help="events per second to emit (default: 5)",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=0,
        help="number of events to emit; 0 means forever (default: 0)",
    )
    parser.add_argument(
        "--output",
        default="-",
        help="file to append to, or '-' for stdout (default: '-')",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="seed for repeatable event choices",
    )
    parser.add_argument(
        "--start-seq",
        type=int,
        default=1,
        help="first request sequence number (default: 1)",
    )
    parser.add_argument(
        "--print-grok",
        action="store_true",
        help="print the Grok pattern for these events and exit",
    )
    args = parser.parse_args()

    if args.print_grok:
        return args
    if args.rate <= 0:
        parser.error("--rate must be greater than 0")
    if args.count < 0:
        parser.error("--count must be 0 or greater")
    if args.start_seq < 1:
        parser.error("--start-seq must be 1 or greater")
    return args


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def choose_level(rng: random.Random) -> str:
    roll = rng.random()
    if roll < 0.04:
        return "ERROR"
    if roll < 0.14:
        return "WARN"
    if roll < 0.22:
        return "DEBUG"
    return "INFO"


def event_line(seq: int, rng: random.Random) -> str:
    service = rng.choice(SERVICES)
    route = rng.choice(ROUTES)
    host = rng.choice(HOSTS)
    user = rng.choice(USERS)
    level = choose_level(rng)

    if level == "ERROR":
        status = rng.choice((500, 502, 503, 504))
        latency = rng.randint(850, 1800)
        message = f"{service} upstream timeout while handling {route}"
    elif level == "WARN":
        status = rng.choice((409, 429, 499))
        latency = rng.randint(220, 700)
        message = f"{service} throttled request burst on {route}"
    elif level == "DEBUG":
        status = rng.choice((200, 202, 204))
        latency = rng.randint(5, 45)
        message = f"{service} cache probe for {route}"
    else:
        status = rng.choice((200, 201, 202, 204))
        latency = rng.randint(20, 180)
        message = f"{service} completed {route}"

    return " ".join(
        (
            f"ts={timestamp()}",
            f"level={level}",
            f"service={service}",
            f"host={host}",
            f"status={status}",
            f"latency_ms={latency}",
            f"request_id=req-{seq:08d}",
            f"user={user}",
            f"route={route}",
            f'msg="{message}"',
        )
    )


def open_output(path: str) -> tuple[TextIO, bool]:
    if path == "-":
        return sys.stdout, False

    output_path = Path(path).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    return output_path.open("a", encoding="utf-8", buffering=1), True


def write_line(stream: TextIO, line: str) -> None:
    try:
        print(line, file=stream, flush=True)
    except BrokenPipeError:
        raise SystemExit(0) from None


def main() -> int:
    args = parse_args()
    if args.print_grok:
        print(GROK_PATTERN)
        return 0

    rng = random.Random(args.seed)
    stream, should_close = open_output(args.output)
    interval = 1.0 / args.rate
    next_emit = time.monotonic()
    emitted = 0
    seq = args.start_seq

    try:
        while args.count == 0 or emitted < args.count:
            write_line(stream, event_line(seq, rng))
            emitted += 1
            seq += 1
            next_emit += interval
            sleep_for = next_emit - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
    except KeyboardInterrupt:
        return 0
    finally:
        if should_close:
            stream.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
