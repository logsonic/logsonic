# Agent security

## Scope and threat model

Reviewed the embedded agent's HTTP boundary, model/tool loop, local and remote
imports, CloudWatch CLI boundary, MCP integration, browser rendering and approval
lifecycle. Tests use disposable indices, synthetic logs and hostile model fixtures;
no real AWS account, production MCP service, or private logs are used.

An attacker may control log text, model replies, MCP metadata/results or a foreign
web page. A model reply is an action proposal, never authorization. The trusted
operator controls LogSonic's local page and hand-edited MCP configuration.
Local processes and a compromised operator browser remain outside this boundary.

## Findings and controls

| Finding | Control |
| --- | --- |
| External MCP calls could disclose data or perform writes on model authority alone | Every external MCP call requires explicit approval, including tools claiming to be read-only |
| Log text could steer the model into importing paths or URLs (a URL query is an exfiltration channel) | Imports run without a prompt only when the user's own messages contain the exact path, URL or CloudWatch log group as a whole token; anything else requires approval |
| Model could request a runtime tool absent from its advertised set | Server checks the per-turn advertised tool set before dispatch |
| DNS rebinding and cross-site request defense depended on surrounding middleware | Agent routes independently require loopback peer and Host, valid local Origin and reject cross-site fetch metadata |
| Markdown images could leak evidence in a remote image URL | Agent replies render image alt text without an image element; links require user navigation and suppress referrers |
| Vulnerable runtime and dependency versions | Go/Docker toolchain and affected network/frontend dependencies patched; unused Zod removed, including its build chunk entry |

The gate targets what prompt injection can abuse, not everything the agent does.
Searches, viewer changes, `save_view` and `ui_save_workspace` stay automatic: they
are local, visible and reversible. Approval is asked only for external MCP tools
and for imports the user did not name. Unknown/unadvertised tools cannot execute.
MCP read-only annotations and tool descriptions cannot bypass approval.

"Named" means the argument appears in a user-role message of the current request
(tool results and assistant text do not count). For local paths, the `~/` form and
the absolute form both count. A model-added query string or a shorter URL prefix
does not match. A user sentence that names a path in order to refuse it ("do not
import ~/x") still counts as naming it; that is a model misreading, not injection,
and the import shows as a step the user can undo.

## Approval contract

Streaming chat emits `approval_required` with `id`, `tool`, `input`, and `reason`.
The UI shows the reason, tool and exact arguments, and offers **Deny**, **Approve
all for this investigation** and **Approve once**. Denial tells the agent not to
retry the call.

`POST /api/v1/agent/approve` accepts `{id, approve}` for one call,
or `{id, approve:true, approve_all:true}` to cover later sensitive calls in the
current stream. Subsequent turns in the same investigation send `approve_all:true`
in the streaming chat body while the operator's grant remains active. The UI
shows the active grant and **Require approvals** revokes it; revoking during a
stream also stops that stream. Stop alone retains the investigation grant.
Grants survive closing and reopening the dock in the same page, but remain only
in browser memory. A new investigation starts without a grant, and a full reload
clears all grants. They are never included in model messages or localStorage.

The ID is a
cryptographically random 192-bit capability, scoped to one pending call in one
server instance. It is sent only to the client, never model messages or persisted
history. The server holds the actual arguments while waiting and consumes the ID
once. A pending approval waits as long as the chat request (ten minutes) and is
removed on cancellation. At most 64 approvals may wait per instance. Denial,
timeout, malformed requests, cancellation and replay cannot authorize execution.
Nonstreaming requests fail calls that need approval with a tool error; API clients
must use streaming and the approval endpoint.
There is no model-callable approval tool. An all-tools grant is a deliberate
operator choice for one investigation and can allow prompt-injected sensitive
calls without another review; use **Require approvals** to restore per-call review.

Approval confirms a call, not its safety. Operators must inspect the destination
and arguments, particularly when an external tool receives log excerpts. Once an
external side effect has begun, Stop cannot promise to undo it.

## Reproduce

From the repository root:

```sh
(cd backend && go test ./...)
(cd backend && go test -race ./pkg/server/handlers -run 'TestAgentApproval|TestAgentLoop' -count=1)
(cd frontend && npm test && npm run build && npx tsc --noEmit)
(cd frontend && npm audit)
(cd backend && govulncheck ./...)
(cd backend && go build -o "$(node -p 'require("os").tmpdir()')/logsonic-security-bin" .)
node demo/agent-security-e2e.mjs
```

The browser harness starts its own model fixture, backend and Vite server on
loopback ports and stops them on exit. It writes screenshots and a JSON report
to a newly created temporary folder (printed on completion). `LOGSONIC_BIN`
names the backend binary (default: `logsonic-security-bin` in the OS temp folder; build it as `logsonic-security-bin.exe` on Windows); `ARTIFACTS` overrides the artifact folder.
It deliberately requests an import of a path the user never named, checks no
import before approval or after denial, then verifies approved data reaches the
actual index. Its 14 checks also cover forged/replayed approval, Stop, capability
persistence, all-tools grants, a user-named import and a workspace save that run
without prompts, and a Markdown data-exfiltration image. It is deterministic boundary validation,
not a benchmark of a live model's resistance to prompt injection.

Regression coverage also exercises local credential and symlink/root escapes,
private and mapped IPv6 SSRF, API-key redirect protection, strict message roles,
request/output/round/tool limits, OpenAI and Anthropic formats, streaming and UI
acknowledgements. Real remote redirect/DNS infrastructure and live AWS side effects
are not exercised by this local test run.

## Current design guidance and limits

The design applies [OWASP excessive-agency guidance](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)
and [provider guidance on approvals, untrusted content and least privilege](https://platform.claude.com/docs/en/managed-agents/secure-deployment-risks).
These recommend independent enforcement and minimal tool permissions. Passing
these checks is not proof that an agent is immune to prompt injection or meets
a universal “state of the art” certification.

Remaining deployment considerations:

- Selected evidence and prompts are sent to the configured model. There is no
  comprehensive secret/PII redaction pipeline or per-record outbound DLP policy.
- MCP stdio programs start from trusted local configuration and run as the user;
  approval gates tool calls, not initialization/handshake behavior. They are not
  OS-sandboxed and may inherit non-model credentials. Use minimal environment,
  allowlisted tools and dedicated accounts for powerful servers.
- Conversation/action history is browser-local and removable, not a durable,
  tamper-evident security audit ledger. There is no multi-user identity or RBAC.
- A directory approval binds its path, not a filesystem snapshot; contents may
  change before reading. Existing credential/root and regular-file checks still
  apply. Approval does not permit blocked credential paths or private downloads.
- Existing indexed logs remain readable by the agent. Prompt-only protections
  cannot guarantee safe conclusions or prevent all disclosure to the chosen model.

These limits matter before deploying beyond the local, single-operator model.

## Viewer/workspace integration follow-up

The agent can inspect viewer settings and the options supported by the UI, list
and inspect workspaces, and suggest saving reusable configurations. A suggestion
alone does not create a workspace. `ui_save_workspace` uses the existing viewer
save path and runs without a prompt, like the workspace menu. Workspace discovery
and timezone/layout display changes are automatic too. Unrecognized UI commands remain denied. The browser harness
exercises the full model proposal, backend tool authorization, UI command validation,
frontend bridge, saved-workspace API and persisted viewer configuration together.
