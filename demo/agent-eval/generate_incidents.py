#!/usr/bin/env python3
"""Generate a synthetic multi-service day of logs with three subtle incidents.

The logs look like an ordinary shop: an API gateway, an auth/SSH host,
payments, orders and browser telemetry. Three problems are hidden in them as
minor hints, mostly at INFO or WARN level, among routine noise and loud but
harmless errors:

* intrusion   -- slow password guessing against a service account from one
                 /24, one successful password login, a sudo pg_dump and large
                 admin exports from the same IP.
* payment     -- after a config reload, JPY charges are sent with the amount
                 multiplied by 100 and declined with psp_code=invalid_amount,
                 logged with the same message as ordinary card declines.
* ui          -- web release 5.8.0 breaks the Place order button on Safari
                 17: a TypeError on /checkout/payment, the button stays
                 disabled, and those sessions never submit a checkout.

Decoys: internet SSH scanners all day, ad-blocker resource errors, benign
ResizeObserver warnings, a periodic Redis timeout ERROR and a three-minute
search reindex ERROR burst.

Logs go to <out>/logs (import this directory); the answer key goes to
<out>/ground-truth.json, outside the import directory. Output is
deterministic for a given --seed.

With --clean the same day is generated with the decoys and the benign change
events (the 11:32 payments config reload, the web 5.8.0 rollout) but none of
the three problems, to measure false positives.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

DAY = datetime(2026, 10, 27, tzinfo=timezone.utc)
START = DAY.replace(hour=6)
END = DAY.replace(hour=18)

# Incident timing.
BRUTE_START = DAY.replace(hour=13, minute=41)
BRUTE_LOGIN = DAY.replace(hour=14, minute=6, second=12)
ATTACKER_IP = "185.220.101.47"
ATTACKER_NET = "185.220.101."
FX_RELOAD = DAY.replace(hour=11, minute=32, second=5)
WEB_RELEASE = DAY.replace(hour=9, minute=15)
REINDEX_BURST = DAY.replace(hour=8, minute=0)

# False in --clean mode: generate the noise and change events, not the faults.
INJECT = True

USERS = [f"cust-{i:05d}" for i in range(4000)]
STAFF = ["deploy", "ci-runner", "akira", "maria", "jonas"]
INTERNAL = ["10.0.4.17", "10.0.4.18", "10.0.6.22", "10.0.8.15", "10.0.9.3"]
CURRENCIES = [("EUR", 0.46), ("USD", 0.30), ("GBP", 0.14), ("SEK", 0.04), ("JPY", 0.025), ("CHF", 0.035)]
BROWSERS = [("Chrome 130", 0.52), ("Safari 17.6", 0.19), ("Firefox 131", 0.11), ("Edge 130", 0.09), ("Mobile Safari 17.6", 0.09)]
ROUTES = ["/", "/search", "/product", "/cart", "/checkout/shipping", "/checkout/payment", "/account"]
API_PATHS = [
    ("GET", "/api/v1/products", 0.34), ("GET", "/api/v1/search", 0.22), ("GET", "/api/v1/cart", 0.14),
    ("POST", "/api/v1/cart/items", 0.08), ("POST", "/api/v1/checkout", 0.05), ("GET", "/api/v1/account", 0.06),
    ("GET", "/healthz", 0.08), ("GET", "/internal/admin/metrics", 0.03),
]
UAS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "kube-probe/1.30",
]


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def pick(rng: random.Random, weighted):
    r = rng.random()
    for item in weighted:
        value, weight = item[:-1], item[-1]
        r -= weight
        if r <= 0:
            return value if len(value) > 1 else value[0]
    last = weighted[-1][:-1]
    return last if len(last) > 1 else last[0]


def ticks(rng: random.Random, start: datetime, end: datetime, per_second: float):
    """Poisson arrivals with a mild daytime traffic curve."""
    t = start
    while True:
        hour = t.hour + t.minute / 60
        load = 0.6 + 0.8 * max(0.0, 1 - abs(hour - 13) / 7)
        t += timedelta(seconds=rng.expovariate(per_second * load))
        if t >= end:
            return
        yield t


def public_ip(rng: random.Random) -> str:
    return f"{rng.choice([31, 46, 62, 77, 88, 91, 109, 145, 176, 188, 212, 217])}.{rng.randrange(256)}.{rng.randrange(256)}.{rng.randrange(1, 255)}"


class Out:
    def __init__(self):
        self.rows: dict[str, list[tuple[datetime, dict]]] = {}

    def add(self, source: str, t: datetime, level: str, service: str, message: str, **fields):
        row = {"timestamp": iso(t), "level": level, "service": service, "message": message}
        row.update(fields)
        self.rows.setdefault(source, []).append((t, row))

    def write(self, directory: Path) -> dict[str, int]:
        directory.mkdir(parents=True, exist_ok=True)
        counts = {}
        for source, rows in self.rows.items():
            rows.sort(key=lambda item: item[0])
            with open(directory / source, "w") as f:
                for _, row in rows:
                    f.write(json.dumps(row, separators=(",", ":")) + "\n")
            counts[source] = len(rows)
        return counts


def gateway(out: Out, rng: random.Random, attacker_requests: list):
    for t in ticks(rng, START, END, 2.2):
        method, path = pick(rng, API_PATHS)
        internal = path.startswith("/internal") or path == "/healthz"
        ip = rng.choice(INTERNAL) if internal else public_ip(rng)
        ua = UAS[3] if path == "/healthz" else rng.choice(UAS[:3])
        status = 200
        r = rng.random()
        if r < 0.012:
            status = 404
        elif r < 0.016:
            status = 499
        elif r < 0.019:
            status = 502
        if method == "POST" and status == 200:
            status = 201
        latency = int(rng.lognormvariate(3.3, 0.5))
        size = int(rng.lognormvariate(7.5, 0.9))
        level = "WARN" if status >= 500 else "INFO"
        out.add("api-gateway.jsonl", t, level, "gateway", f"{method} {path} {status} {latency}ms",
                method=method, path=path, status=status, latency_ms=latency, bytes=size, client_ip=ip,
                user_agent=ua, request_id=f"req-{rng.getrandbits(48):012x}")
    for t, path, size in attacker_requests:
        latency = 8000 + rng.randrange(9000)
        out.add("api-gateway.jsonl", t, "INFO", "gateway", f"GET {path} 200 {latency}ms",
                method="GET", path=path, status=200, latency_ms=latency, bytes=size, client_ip=ATTACKER_IP,
                user_agent="python-requests/2.31.0", request_id=f"req-{rng.getrandbits(48):012x}")


def auth(out: Out, rng: random.Random, truth: dict):
    host = "bastion-01"
    # Routine staff logins with keys from the internal network.
    for t in ticks(rng, START, END, 0.012):
        user = rng.choice(STAFF)
        ip = rng.choice(INTERNAL)
        port = rng.randrange(40000, 65000)
        pid = rng.randrange(2000, 60000)
        out.add("auth.jsonl", t, "INFO", "sshd", f"Accepted publickey for {user} from {ip} port {port} ssh2: ED25519 SHA256:{rng.getrandbits(64):016x}",
                host=host, pid=pid, user=user, src_ip=ip, auth_method="publickey", event="login_success")
        out.add("auth.jsonl", t + timedelta(seconds=1), "INFO", "sshd", f"pam_unix(sshd:session): session opened for user {user}(uid={1000 + STAFF.index(user)}) by (uid=0)",
                host=host, pid=pid, user=user, event="session_open")
        out.add("auth.jsonl", t + timedelta(minutes=rng.randrange(2, 50)), "INFO", "sshd", f"pam_unix(sshd:session): session closed for user {user}",
                host=host, pid=pid, user=user, event="session_close")
    # The backup job's normal key login, every two hours.
    for h in range(6, 18, 2):
        t = DAY.replace(hour=h, minute=5, second=rng.randrange(60))
        out.add("auth.jsonl", t, "INFO", "sshd", f"Accepted publickey for svc-backup from 10.0.8.15 port {rng.randrange(40000, 65000)} ssh2: ED25519 SHA256:9c1e44a07b2f3d10",
                host=host, pid=rng.randrange(2000, 60000), user="svc-backup", src_ip="10.0.8.15", auth_method="publickey", event="login_success")
    # Background internet noise: scanners guessing nonexistent users.
    for t in ticks(rng, START, END, 0.02):
        ip = public_ip(rng)
        user = rng.choice(["admin", "root", "test", "oracle", "ubuntu", "pi", "git", "user"])
        level = "INFO"
        if user == "root":
            msg = f"Failed password for root from {ip} port {rng.randrange(1024, 65000)} ssh2"
        else:
            msg = f"Failed password for invalid user {user} from {ip} port {rng.randrange(1024, 65000)} ssh2"
        out.add("auth.jsonl", t, level, "sshd", msg, host=host, pid=rng.randrange(2000, 60000), user=user, src_ip=ip, auth_method="password", event="login_failure")
    if not INJECT:
        return []
    # Fault: slow password guessing against a real service account from one
    # /24, rotating addresses, about one attempt every 35 seconds.
    t = BRUTE_START
    attempts = 0
    while t < BRUTE_LOGIN - timedelta(seconds=20):
        ip = ATTACKER_NET + str(rng.choice([12, 19, 33, 47, 58, 61, 77, 102]))
        out.add("auth.jsonl", t, "INFO", "sshd", f"Failed password for svc-backup from {ip} port {rng.randrange(30000, 60000)} ssh2",
                host=host, pid=rng.randrange(2000, 60000), user="svc-backup", src_ip=ip, auth_method="password", event="login_failure")
        attempts += 1
        t += timedelta(seconds=rng.randrange(25, 46))
    pid = 48213
    out.add("auth.jsonl", BRUTE_LOGIN, "INFO", "sshd", f"Accepted password for svc-backup from {ATTACKER_IP} port 40022 ssh2",
            host=host, pid=pid, user="svc-backup", src_ip=ATTACKER_IP, auth_method="password", event="login_success")
    out.add("auth.jsonl", BRUTE_LOGIN + timedelta(seconds=1), "INFO", "sshd", "pam_unix(sshd:session): session opened for user svc-backup(uid=996) by (uid=0)",
            host=host, pid=pid, user="svc-backup", event="session_open")
    sudo_at = BRUTE_LOGIN + timedelta(minutes=1, seconds=18)
    out.add("auth.jsonl", sudo_at, "INFO", "sudo", "svc-backup : TTY=pts/3 ; PWD=/home/svc-backup ; USER=root ; COMMAND=/usr/bin/pg_dump --all --file=/tmp/.cache/db.sql",
            host=host, user="svc-backup", event="sudo")
    out.add("auth.jsonl", BRUTE_LOGIN + timedelta(minutes=9, seconds=40), "INFO", "sshd", "pam_unix(sshd:session): session closed for user svc-backup",
            host=host, pid=pid, user="svc-backup", event="session_close")
    exports = []
    for i, table in enumerate(["customers", "payment_methods", "orders"]):
        at = BRUTE_LOGIN + timedelta(minutes=3 + 2 * i, seconds=rng.randrange(60))
        exports.append((at, f"/internal/admin/export?table={table}&format=csv", rng.randrange(38_000_000, 61_000_000)))
    truth["intrusion"] = {
        "kind": "security / intrusion",
        "summary": f"Slow password guessing ({attempts} failures, rotating {ATTACKER_NET}0/24) against valid service account svc-backup, "
                   f"then 'Accepted password' from {ATTACKER_IP} at {iso(BRUTE_LOGIN)}, sudo pg_dump --all, and three large "
                   "/internal/admin/export downloads (customers, payment_methods, orders) from the same IP with python-requests.",
        "sources": ["auth.jsonl", "api-gateway.jsonl"],
        "window": [iso(BRUTE_START), iso(exports[-1][0] + timedelta(seconds=30))],
        "key_time": iso(BRUTE_LOGIN),
        "required": ["svc-backup", ATTACKER_IP],
        "supporting": ["185.220.101", "pg_dump", "/internal/admin/export", "python-requests", "Accepted password"],
        "detect_terms": ["brute", "password guess", "credential", "intrusion", "compromis", "unauthori", "exfiltrat", "attack", "suspicious login"],
        "evidence_query": 'user:"svc-backup"',
        "brute_force_attempts": attempts,
    }
    return exports


def payments(out: Out, rng: random.Random, truth: dict):
    host_of = lambda: rng.choice(["pay-1", "pay-2", "pay-3"])
    jpy_failures = 0
    jpy_after = 0
    out.add("payments.jsonl", FX_RELOAD, "INFO", "payments", "config reloaded: build=2026.10.27-2 fx_table=v2 minor_units=static",
            host="pay-2", event="config_reload", build="2026.10.27-2")
    for t in ticks(rng, START, END, 0.55):
        currency = pick(rng, CURRENCIES)
        if currency == "JPY":
            amount = rng.randrange(800, 40000)  # zero-decimal currency
        else:
            amount = rng.randrange(500, 25000)
        brand = rng.choice(["visa", "visa", "mastercard", "mastercard", "amex"])
        order = f"ord-{rng.getrandbits(40):010x}"
        fields = dict(host=host_of(), order_id=order, currency=currency, card_brand=brand, processor="adyen", event="charge")
        broken = INJECT and currency == "JPY" and t >= FX_RELOAD
        if broken:
            jpy_after += 1
            # The regression treats JPY as a two-decimal currency.
            fields["amount_minor"] = amount * 100
            out.add("payments.jsonl", t, "WARN", "payments", f"charge declined order={order} psp_code=invalid_amount",
                    psp_code="invalid_amount", result="declined", latency_ms=int(rng.lognormvariate(5.0, 0.3)), **fields)
            jpy_failures += 1
            continue
        fields["amount_minor"] = amount
        r = rng.random()
        if r < 0.031:
            code = rng.choice(["insufficient_funds", "insufficient_funds", "do_not_honor", "expired_card", "incorrect_cvc"])
            out.add("payments.jsonl", t, "WARN", "payments", f"charge declined order={order} psp_code={code}",
                    psp_code=code, result="declined", latency_ms=int(rng.lognormvariate(5.0, 0.3)), **fields)
        else:
            out.add("payments.jsonl", t, "INFO", "payments", f"charge authorized order={order}",
                    psp_code="authorised", result="authorized", latency_ms=int(rng.lognormvariate(5.0, 0.3)), **fields)
    for t in ticks(rng, START, END, 0.01):
        out.add("payments.jsonl", t, "INFO", "payments", "settlement batch flushed", host=host_of(), event="settlement", batch=rng.randrange(1000, 9999))
    if not INJECT:
        return
    truth["payment"] = {
        "kind": "payment failure",
        "summary": f"After 'config reloaded: build=2026.10.27-2 fx_table=v2' at {iso(FX_RELOAD)}, every JPY charge "
                   f"({jpy_failures} of {jpy_after}) is declined with psp_code=invalid_amount and amount_minor 100x the normal JPY range. "
                   "Logged as an ordinary 'charge declined' WARN like normal card declines; only the psp_code differs.",
        "sources": ["payments.jsonl"],
        "window": [iso(FX_RELOAD), iso(END)],
        "key_time": iso(FX_RELOAD),
        "required": ["JPY", "invalid_amount"],
        "supporting": ["fx_table=v2", "2026.10.27-2", "config reload", "amount_minor", "11:32"],
        "detect_terms": ["payment", "charge", "declin"],
        "evidence_query": 'psp_code:"invalid_amount"',
        "jpy_failures": jpy_failures,
    }


def orders(out: Out, rng: random.Random):
    for t in ticks(rng, START, END, 0.45):
        order = f"ord-{rng.getrandbits(40):010x}"
        out.add("orders.jsonl", t, "INFO", "orders", f"order {order} created items={rng.randrange(1, 6)}",
                host=rng.choice(["orders-1", "orders-2"]), order_id=order, event="order_created")
    # Loud but harmless: periodic cache timeouts with a successful retry.
    for t in ticks(rng, START, END, 1 / 280):
        out.add("orders.jsonl", t, "ERROR", "orders", f"redis GET cart:{rng.getrandbits(32):08x} timed out after 50ms; retry succeeded",
                host=rng.choice(["orders-1", "orders-2"]), event="cache_timeout")
    for i in range(180):
        t = REINDEX_BURST + timedelta(seconds=i)
        out.add("orders.jsonl", t, "ERROR", "search-indexer", f"reindex shard {i % 6} failed: index write lock held by another process; retrying",
                host="indexer-1", event="reindex_retry")
    out.add("orders.jsonl", REINDEX_BURST + timedelta(seconds=185), "INFO", "search-indexer", "reindex completed: 6 shards, 412,880 documents",
            host="indexer-1", event="reindex_done")


def web(out: Out, rng: random.Random, truth: dict):
    broken_sessions = 0
    type_errors = 0
    for t in ticks(rng, START, END, 0.16):
        session = f"s-{rng.getrandbits(40):010x}"
        browser = pick(rng, BROWSERS)
        rollout = min(1.0, max(0.0, (t - WEB_RELEASE).total_seconds() / 3600))
        version = "5.8.0" if rng.random() < rollout else "5.7.3"
        os_name = "macOS 14" if browser == "Safari 17.6" else ("iOS 17" if browser.startswith("Mobile") else rng.choice(["Windows 11", "macOS 14", "Linux"]))
        base = dict(session_id=session, browser=browser, os=os_name, app_version=version)
        at = t
        steps = rng.choice([2, 3, 4, 5, 6, 7])
        for route in ROUTES[: min(steps, len(ROUTES))]:
            at += timedelta(seconds=rng.randrange(2, 40))
            out.add("web-client.jsonl", at, "INFO", "web", f"page_view {route}", route=route, event="page_view",
                    lcp_ms=int(rng.lognormvariate(7.2, 0.35)), **base)
            if rng.random() < 0.05:
                out.add("web-client.jsonl", at + timedelta(milliseconds=300), "WARN", "web", "ResizeObserver loop completed with undelivered notifications.",
                        route=route, event="console_warn", **base)
            if rng.random() < 0.04:
                out.add("web-client.jsonl", at + timedelta(milliseconds=500), "WARN", "web",
                        "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT https://www.googletagmanager.com/gtm.js",
                        route=route, event="console_error", **base)
        if steps < 6:
            continue
        # The session reached /checkout/payment.
        at += timedelta(seconds=rng.randrange(10, 60))
        safari = "Safari" in browser
        if INJECT and version == "5.8.0" and safari:
            broken_sessions += 1
            if rng.random() < 0.7:
                type_errors += 1
                out.add("web-client.jsonl", at, "WARN", "web",
                        "Uncaught TypeError: undefined is not an object (evaluating 'n.paymentMethod.billingAddress')",
                        route="/checkout/payment", event="console_error", component="PaymentForm", **base)
            for _ in range(rng.randrange(1, 4)):
                at += timedelta(seconds=rng.randrange(1, 6))
                out.add("web-client.jsonl", at, "INFO", "web", "click #place-order ignored: button disabled",
                        route="/checkout/payment", event="click", target="#place-order", **base)
            continue
        out.add("web-client.jsonl", at, "INFO", "web", "click #place-order", route="/checkout/payment", event="click", target="#place-order", **base)
        out.add("web-client.jsonl", at + timedelta(milliseconds=rng.randrange(300, 1200)), "INFO", "web", "checkout_submitted",
                route="/checkout/payment", event="checkout_submitted", **base)
    if not INJECT:
        return
    truth["ui"] = {
        "kind": "UI bug",
        "summary": f"Web release 5.8.0 (rolled out from {iso(WEB_RELEASE)} over an hour) breaks /checkout/payment on Safari 17.6 "
                   f"(desktop and mobile): {type_errors} 'TypeError ... n.paymentMethod.billingAddress' console errors, "
                   f"'click #place-order ignored: button disabled', and {broken_sessions} sessions never reach checkout_submitted.",
        "sources": ["web-client.jsonl"],
        "window": [iso(WEB_RELEASE), iso(END)],
        "key_time": iso(WEB_RELEASE),
        "required": ["Safari", "5.8.0"],
        "supporting": ["paymentMethod", "place-order", "/checkout/payment", "TypeError", "button disabled", "checkout_submitted"],
        "detect_terms": ["TypeError", "checkout", "button", "UI", "frontend", "front-end", "browser", "client"],
        "evidence_query": '+app_version:"5.8.0" +route:"/checkout/payment" +browser:Safari',
        "broken_sessions": broken_sessions,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="/tmp/logsonic-agent-eval", help="output directory (default %(default)s)")
    parser.add_argument("--seed", type=int, default=2710)
    parser.add_argument("--clean", action="store_true", help="no planted problems; measures false positives")
    args = parser.parse_args()
    global INJECT
    INJECT = not args.clean
    rng = random.Random(args.seed)
    out = Out()
    truth: dict = {}
    exports = auth(out, rng, truth)
    gateway(out, rng, exports)
    payments(out, rng, truth)
    orders(out, rng)
    web(out, rng, truth)
    root = Path(args.out)
    counts = out.write(root / "logs")
    truth["_meta"] = {"seed": args.seed, "clean": args.clean, "span": [iso(START), iso(END)], "rows": counts, "total_rows": sum(counts.values()),
                      "decoys": ["internet SSH scanners (invalid users, root)", "redis timeout ERRORs with successful retry",
                                 f"search reindex ERROR burst at {iso(REINDEX_BURST)} (3 minutes, self-resolved)",
                                 "ResizeObserver and ERR_BLOCKED_BY_CLIENT console noise", "ordinary card declines (~3%)", "gateway 502/499/404s",
                                 f"payments config reload at {iso(FX_RELOAD)} (benign)", f"web 5.8.0 rollout from {iso(WEB_RELEASE)} (benign)"]}
    (root / "ground-truth.json").write_text(json.dumps(truth, indent=2) + "\n")
    print(json.dumps({"logs": str(root / "logs"), "ground_truth": str(root / "ground-truth.json"), "rows": counts, "total": sum(counts.values())}, indent=2))


if __name__ == "__main__":
    main()
