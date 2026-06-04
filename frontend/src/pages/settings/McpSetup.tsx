import { Check, Copy, ExternalLink, Terminal } from 'lucide-react';
import { FC, useState } from 'react';

import { SettingsLayout } from './SettingsLayout';

const serverOrigin = import.meta.env.DEV
  ? 'http://localhost:8080'
  : window.location.origin;

const GITHUB_URL = 'https://github.com/logsonic/logsonic';
const GITHUB_MCP_URL = `${GITHUB_URL}/tree/main/mcp`;

const CopyBlock: FC<{ label: string; value: string }> = ({ label, value }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 6, gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ls-text-2)' }}>{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center"
          style={{
            gap: 4,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 11,
            color: copied ? 'var(--ls-ok)' : 'var(--ls-text-3)',
            padding: '2px 4px',
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 14px',
          background: 'var(--ls-bg-2)',
          border: '1px solid var(--ls-border)',
          borderRadius: 'var(--ls-radius)',
          fontSize: 12,
          fontFamily: 'var(--ls-font-mono)',
          color: 'var(--ls-text)',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {value}
      </pre>
    </div>
  );
};

const Section: FC<{ title: string; badge?: string; children: React.ReactNode }> = ({ title, badge, children }) => (
  <div style={{ marginBottom: 24 }}>
    <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--ls-text)', letterSpacing: '-0.01em' }}>
        {title}
      </h3>
      {badge && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: 4,
            background: 'var(--ls-accent-soft)',
            color: 'var(--ls-accent)',
            border: '1px solid var(--ls-accent-border)',
            letterSpacing: '0.03em',
          }}
        >
          {badge}
        </span>
      )}
    </div>
    {children}
  </div>
);

const httpConfig = JSON.stringify(
  { mcpServers: { logsonic: { url: `${serverOrigin}/mcp` } } },
  null,
  2,
);

const binaryConfig = JSON.stringify(
  {
    mcpServers: {
      logsonic: {
        command: '/path/to/logsonic',
        args: ['mcp'],
        env: { LOGSONIC_URL: serverOrigin },
      },
    },
  },
  null,
  2,
);

const agentInstructions = `You have access to a LogSonic MCP server.
LogSonic is a local log analytics engine — logs are indexed in time-sharded
Bleve indices. Every log line has _timestamp (RFC3339), _src (source name),
_raw (original line), and any fields the Grok parser extracted.

Standard workflow for each new question:
1. ping       — confirm server is reachable
2. log_info   — discover available sources and date range
3. query_logs — run the search (constrain by source + time window)

Available tools: ping, log_info, query_logs, list_grok_patterns,
test_grok_pattern, logsonic_url, log_distribution.

Full playbook (query syntax, recipes, pitfalls): ${GITHUB_MCP_URL}/blob/main/SKILLS.md`;

const configLocation = (
  <div
    style={{
      background: 'var(--ls-bg-2)',
      border: '1px solid var(--ls-border)',
      borderRadius: 'var(--ls-radius)',
      padding: '8px 12px',
      fontSize: 12,
      color: 'var(--ls-text-2)',
    }}
  >
    <strong style={{ color: 'var(--ls-text)' }}>Config file location:</strong>
    <br />
    macOS: <code className="ls-mono-inline">~/Library/Application Support/Claude/claude_desktop_config.json</code>
    <br />
    Windows: <code className="ls-mono-inline">%APPDATA%\Claude\claude_desktop_config.json</code>
  </div>
);

const McpSetup: FC = () => (
  <SettingsLayout>
    <div style={{ marginBottom: 4 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--ls-text)' }}>
        MCP Integration
      </h2>
      <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: 'var(--ls-text-2)' }}>
        Connect Claude Desktop, Cursor, Windsurf, or any MCP-capable AI client to query your LogSonic data.{' '}
        <a
          href={GITHUB_MCP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center"
          style={{ gap: 3, color: 'var(--ls-accent)', fontSize: 12.5 }}
        >
          View source on GitHub <ExternalLink size={11} />
        </a>
      </p>
    </div>

    {/* Option A — HTTP */}
    <div
      style={{
        background: 'var(--ls-panel)',
        border: '1px solid var(--ls-border)',
        borderRadius: 'var(--ls-radius-lg)',
        padding: '16px 20px',
        marginBottom: 16,
      }}
    >
      <Section title="Option A — HTTP transport" badge="Recommended">
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--ls-text-2)', lineHeight: 1.6 }}>
          LogSonic exposes the MCP server at <code className="ls-mono-inline">/mcp</code> on its HTTP port — no binary
          path, no extra install. Works with any MCP client that supports the Streamable HTTP transport (Claude Desktop,
          Cursor, Windsurf updated after March 2025).
        </p>
        <CopyBlock label="claude_desktop_config.json / mcp.json" value={httpConfig} />
        {configLocation}
      </Section>
    </div>

    {/* Option B — binary stdio */}
    <div
      style={{
        background: 'var(--ls-panel)',
        border: '1px solid var(--ls-border)',
        borderRadius: 'var(--ls-radius-lg)',
        padding: '16px 20px',
        marginBottom: 16,
      }}
    >
      <Section title="Option B — binary stdio" badge="Fallback">
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--ls-text-2)', lineHeight: 1.6 }}>
          Use this if your client doesn't support HTTP transport yet. The MCP server is built into the{' '}
          <code className="ls-mono-inline">logsonic</code> binary — downloaded binary or Homebrew install already has it.
          Run <code className="ls-mono-inline">which logsonic</code> to find the path.
        </p>
        <CopyBlock label="claude_desktop_config.json / mcp.json" value={binaryConfig} />
        {configLocation}
      </Section>
    </div>

    {/* Verify */}
    <div
      style={{
        background: 'var(--ls-panel)',
        border: '1px solid var(--ls-border)',
        borderRadius: 'var(--ls-radius-lg)',
        padding: '16px 20px',
        marginBottom: 16,
      }}
    >
      <Section title="Verify the connection">
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ls-text-2)', lineHeight: 1.6 }}>
          Restart your MCP client after adding the config. For Option A, a quick check:{' '}
          <code className="ls-mono-inline">curl {serverOrigin}/mcp</code> should return a JSON-RPC response.
          For Option B, the client's MCP log should show{' '}
          <code className="ls-mono-inline">[logsonic-mcp] connected to LogSonic at {serverOrigin}</code>.
          If not, make sure LogSonic is running first.
        </p>
      </Section>
    </div>

    {/* Agent instructions */}
    <div
      style={{
        background: 'var(--ls-panel)',
        border: '1px solid var(--ls-border)',
        borderRadius: 'var(--ls-radius-lg)',
        padding: '16px 20px',
        marginBottom: 20,
      }}
    >
      <Section title="Instructions for agents">
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--ls-text-2)', lineHeight: 1.6 }}>
          Paste this into your AI client's system prompt so the model knows the workflow without trial and error.
          The full playbook is in{' '}
          <a href={`${GITHUB_MCP_URL}/blob/main/SKILLS.md`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ls-accent)' }}>
            mcp/SKILLS.md
          </a>.
        </p>
        <CopyBlock label="Agent instructions (short form)" value={agentInstructions} />
      </Section>
    </div>

    <div className="flex items-center" style={{ gap: 8 }}>
      <Terminal size={13} style={{ color: 'var(--ls-text-3)' }} />
      <span style={{ fontSize: 12, color: 'var(--ls-text-3)' }}>
        The MCP server starts automatically when your AI client calls a tool — no separate process to manage.
      </span>
    </div>
  </SettingsLayout>
);

export default McpSetup;
