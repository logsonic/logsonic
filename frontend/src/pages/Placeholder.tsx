import { Header } from '@/components/Home/Header';
import { LeftRail } from '@/components/Shell/LeftRail';
import { StatusBar } from '@/components/Shell/StatusBar';
import { Bell, Bookmark, Settings as SettingsIcon } from 'lucide-react';
import { ReactNode } from 'react';

interface PlaceholderProps {
  title: string;
  description: string;
  icon: ReactNode;
}

const PlaceholderShell = ({ title, description, icon }: PlaceholderProps) => (
  <div
    className="flex h-screen"
    style={{ background: 'var(--ls-bg-1)', color: 'var(--ls-text)' }}
  >
    <LeftRail />
    <div className="flex-1 flex flex-col min-w-0">
      <Header />
      <main
        className="flex-1 overflow-auto"
        style={{ background: 'var(--ls-bg-1)' }}
      >
        <div className="max-w-3xl mx-auto px-7 py-12">
          <div className="flex items-start gap-4 mb-6">
            <div
              className="grid place-items-center rounded-[10px]"
              style={{
                width: 44,
                height: 44,
                background: 'var(--ls-accent-softer)',
                color: 'var(--ls-accent-text)',
                border: '1px solid var(--ls-accent-border)',
              }}
            >
              {icon}
            </div>
            <div>
              <h1
                className="font-semibold tracking-tight"
                style={{ fontSize: 22, letterSpacing: '-0.015em', margin: 0 }}
              >
                {title}
              </h1>
              <p style={{ color: 'var(--ls-text-2)', fontSize: 13, margin: '4px 0 0' }}>
                {description}
              </p>
            </div>
          </div>
          <div
            className="rounded-[10px] p-6"
            style={{
              background: 'var(--ls-panel)',
              border: '1px solid var(--ls-border)',
              boxShadow: 'var(--ls-shadow-sm)',
            }}
          >
            <p style={{ color: 'var(--ls-text-2)', fontSize: 13 }}>
              Coming soon. The {title.toLowerCase()} surface is part of the in-progress redesign.
            </p>
          </div>
        </div>
      </main>
      <StatusBar />
    </div>
  </div>
);

export const SavedPage = () => (
  <PlaceholderShell
    title="Saved searches"
    description="Bookmark queries you reach for often, share them with teammates, and pin them to dashboards."
    icon={<Bookmark size={20} strokeWidth={1.7} />}
  />
);

export const AlertsPage = () => (
  <PlaceholderShell
    title="Alerts"
    description="Threshold-based alerts on saved queries with sparklines and routing rules."
    icon={<Bell size={20} strokeWidth={1.7} />}
  />
);

export const SettingsPage = () => (
  <PlaceholderShell
    title="Settings"
    description="Storage, indexing, AI, theme, and keyboard preferences."
    icon={<SettingsIcon size={20} strokeWidth={1.7} />}
  />
);
