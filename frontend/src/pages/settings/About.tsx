import { ExternalLink, Github } from 'lucide-react';
import { FC } from 'react';

import pkg from '../../../package.json';

import { SettingsLayout } from './SettingsLayout';

import { CopyableValue } from '@/components/settings/CopyableValue';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/utils';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';

const SOURCE_URL = 'https://github.com/logsonic/logsonic';


const About: FC = () => {
  const { systemInfo } = useSystemInfoStore();

  const apiBase = import.meta.env.DEV ? 'http://localhost:8080/api/v1' : '/api/v1';
  const storageDir = systemInfo?.storage_info?.storage_directory;
  const storageSize = systemInfo?.storage_info?.storage_size_bytes;

  // Server build identity wins; the bundle's package.json version is only
  // the fallback while /info has not loaded (or in dev, where both say dev).
  const serverVersion = systemInfo?.app?.version;
  const versionLabel = serverVersion && serverVersion !== 'dev' ? serverVersion : `v${pkg.version}`;
  const commit = systemInfo?.app?.commit;

  const staticRows: [string, string][] = [
    ['Version', commit ? `${versionLabel} (${commit.slice(0, 12)})` : versionLabel],
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

      {/* Storage location card */}
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
        <div
          className="flex items-center justify-between"
          style={{ gap: 16, padding: '10px 0' }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text)', flexShrink: 0 }}>Index location</span>
          {storageDir ? (
            <CopyableValue value={storageDir} />
          ) : (
            <span className="ls-mono-inline" style={{ color: 'var(--ls-text-3)' }}>loading…</span>
          )}
        </div>
        <div
          className="flex items-center justify-between"
          style={{ gap: 16, padding: '10px 0', borderTop: '1px solid var(--ls-border-subtle)' }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ls-text)', flexShrink: 0 }}>Index size</span>
          <span className="ls-mono-inline">
            {storageSize != null ? formatBytes(storageSize) : '…'}
          </span>
        </div>
      </div>

      {/* App metadata card */}
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
        {staticRows.map(([k, v], i) => (
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
