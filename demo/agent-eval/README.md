# Agent detection eval

Checks whether the agent can find small, deliberately hidden problems in a
realistic volume of logs, pin each one down, and save a view of it.

`generate_incidents.py` writes one synthetic day (06:00–18:00 UTC on
2026-10-27, about 189,000 JSON lines) from five services: `api-gateway`,
`auth`, `payments`, `orders` and `web-client`. Three problems are hidden in it,
mostly at INFO or WARN level:

| Problem | Hint in the logs |
|---|---|
| Intrusion | ~40 `Failed password for svc-backup` from rotating 185.220.101.x addresses, one `Accepted password for svc-backup from 185.220.101.47`, a `sudo ... pg_dump --all`, and three large `/internal/admin/export` downloads from the same IP with `python-requests`. |
| Payment failure | After `config reloaded: build=2026.10.27-2 fx_table=v2` at 11:32, every JPY charge is declined with `psp_code=invalid_amount` and an amount 100× too large. Same `charge declined` WARN as ordinary card declines. |
| UI bug | Web release 5.8.0 breaks the Place order button on Safari 17.6: a rare `TypeError ... n.paymentMethod.billingAddress`, `click #place-order ignored: button disabled`, and no `checkout_submitted` for those sessions. |

Decoys: SSH scanners all day, ad-blocker and ResizeObserver console noise,
ordinary card declines, gateway 4xx/5xx, a periodic Redis timeout ERROR and a
three-minute search reindex ERROR burst that resolves itself. File names do not
hint at the problems. The answer key is written to `ground-truth.json`, outside
the directory the agent imports.

`run-eval.mjs` drives the real agent dock in Chromium with two prompts, each in
a fresh investigation:

- **blind**: import the directory, find every real problem, pinpoint it and
  save a view for each; no hint about what is wrong.
- **hinted**: data already imported; check specifically for an intrusion,
  payment failures and a client-side UI bug.

For each problem it scores:

- **detected**: the answer names the kind of problem and at least one of its
  identifiers;
- **pinpointed**: the answer contains every required identifier (for example
  `svc-backup` and `185.220.101.47`), a time inside the problem window, and a
  tool result contains a required identifier (the claim came from evidence);
- **views**: workspaces the agent saved whose rows carry the problem's
  identifiers. Each view is opened in the UI and screenshotted.

A problem no agent view covers gets a view built from the ground truth, named
`[ground truth] ...` so it is never mistaken for an agent finding.

## False-positive control

`generate_incidents.py --clean` writes the same day with all the decoys but
none of the three problems. It keeps two benign change events as bait: the
11:32 payments config reload (`minor_units=static`, with no effect) and the
web 5.8.0 rollout (no bug). On a clean dataset `run-eval.mjs` adds one
follow-up turn per prompt, with no tool calls allowed, asking the agent to
list each problem it confirmed as `PROBLEM: <severity> | <title>`. Any claim
of medium severity or higher counts as a false positive. Low and info findings
and saved views are reported too.

```sh
python3 demo/agent-eval/generate_incidents.py --clean --out /tmp/logsonic-agent-eval-clean
# start a backend with -storage /tmp/logsonic-agent-eval-clean/index, then:
EVAL_DIR=/tmp/logsonic-agent-eval-clean node demo/agent-eval/run-eval.mjs
```

## Run

Use a fresh index; reimporting appends duplicates. Start the proxy as in
[../agent-README.md](../agent-README.md), then:

```sh
python3 demo/agent-eval/generate_incidents.py          # writes /tmp/logsonic-agent-eval
cd backend && go build -o /tmp/logsonic-agent-eval-bin . && cd ..
/tmp/logsonic-agent-eval-bin -host 127.0.0.1 -port 8098 -auto-port=false -storage /tmp/logsonic-agent-eval/index
# second terminal
cd frontend && PORT=5174 VITE_API_BASE_URL=http://127.0.0.1:8098 npm run dev -- --host 127.0.0.1 --port 5174
# third terminal, from the repository root
node demo/agent-eval/run-eval.mjs
```

Output goes to `/tmp/logsonic-agent-eval/artifacts`: `report.md` (score
matrix and both answers), `report.json`, each turn's steps, answer and view
screenshots, and a video. `MODES=hinted` runs one prompt, `HEADLESS=0` shows
the browser, `--seed` on the generator changes the data.

The synthetic data tests the agent's tools and method, not real-world
diagnostic accuracy. Selected log evidence is sent to Claude through the local
proxy.
