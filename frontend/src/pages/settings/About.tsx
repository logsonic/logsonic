import { ExternalLink, Github } from 'lucide-react';
import { FC } from 'react';

import pkg from '../../../package.json';

import { SettingsLayout } from './SettingsLayout';

import { Button } from '@/components/ui/button';

const SOURCE_URL = 'https://github.com/logsonic/logsonic';

const About: FC = () => {
  // Truthful, runtime-derivable facts only — no fabricated build metadata.
  const apiBase = import.meta.env.DEV ? 'http://localhost:8080/api/v1' : '/api/v1';

  const rows: [string, string][] = [
    ['Version', `v${pkg.version}`],
    ['License', 'MIT'],
    ['API endpoint', apiBase],
    ['Source', 'github.com/logsonic/logsonic'],
  ];

  return (
    <SettingsLayout>
      <div style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--ls-text)' }}>
          About LogSonic
        </h2>
        <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: 'var(--ls-text-2)' }}>
          Open-source local log viewer. No accounts, no telemetry, no cloud.
        </p>
      </div>

      <div
        style={{
          background: 'var(--ls-panel)',
          border: '1px solid var(--ls-border)',
          borderRadius: 'var(--ls-radius-lg)',
          boxShadow: 'var(--ls-shadow-sm)',
          padding: '6px 16px',
          marginBottom: 14,
        }}
      >
        {rows.map(([k, v], i) => (
          <div
            key={k}
            className="flex items-center justify-between"
            style={{
              gap: 16,
              padding: '10px 0',
              borderTop: i > 0 ? '1px solid var(--ls-border-subtle)' : 'none',
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text)' }}>{k}</span>
            <span className="ls-mono-inline">{v}</span>
          </div>
        ))}
      </div>

      <div className="flex" style={{ gap: 8 }}>
        <Button variant="outline" size="sm" asChild>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            <Github className="h-3.5 w-3.5" /> View on GitHub
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={`${SOURCE_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3.5 w-3.5" /> License
          </a>
        </Button>
      </div>
    </SettingsLayout>
  );
};

export default About;
