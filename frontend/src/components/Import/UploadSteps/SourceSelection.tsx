import { LogSourceProvider } from '@/components/Import/types';
import { useImportStore } from '@/stores/useImportStore';
import { FC } from 'react';
interface SourceSelectionProps {
  providers: LogSourceProvider[];
  selectedSource: string | null;
  onSelectSource: (source: string) => void;
}

export const SourceSelection: FC<SourceSelectionProps> = ({
  providers,
  selectedSource,
  onSelectSource,
}) => {
  const { setImportSource } = useImportStore();

  const handleSelectSource = (source: string) => {
    setImportSource(source);
    onSelectSource(source);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col" style={{ gap: 10 }}>
        <h2
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ls-text)',
            letterSpacing: '-0.005em',
          }}
        >
          Choose a source
        </h2>

        <div className="grid grid-cols-2 gap-3">
          {providers.map(provider => {
            const isSelected = selectedSource === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => handleSelectSource(provider.id)}
                className="flex items-center transition-all"
                style={{
                  padding: '14px 14px',
                  gap: 12,
                  borderRadius: 8,
                  cursor: 'pointer',
                  border: `1px solid ${isSelected ? 'var(--ls-accent)' : 'var(--ls-border)'}`,
                  background: isSelected ? 'var(--ls-accent-softer)' : 'var(--ls-panel)',
                  textAlign: 'left',
                  boxShadow: isSelected
                    ? '0 0 0 3px var(--ls-accent-softer)'
                    : 'var(--ls-shadow-sm)',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.borderColor = 'var(--ls-border-strong)';
                    e.currentTarget.style.background = 'var(--ls-bg-1)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.borderColor = 'var(--ls-border)';
                    e.currentTarget.style.background = 'var(--ls-panel)';
                  }
                }}
              >
                <div
                  className="flex items-center justify-center flex-shrink-0"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    background: isSelected ? 'var(--ls-accent-soft)' : 'var(--ls-bg-2)',
                    border: `1px solid ${isSelected ? 'var(--ls-accent-border)' : 'var(--ls-border)'}`,
                  }}
                >
                  <provider.icon
                    size={18}
                    style={{ color: isSelected ? 'var(--ls-accent)' : 'var(--ls-text-2)' }}
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: 'var(--ls-text)',
                      marginBottom: 1,
                    }}
                  >
                    {provider.name}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ls-text-3)' }}>
                    {provider.id === 'cloudwatch'
                      ? 'Stream logs from AWS CloudWatch'
                      : 'Drop or pick local .log / .txt / .json files'}
                  </div>
                </div>

                <div
                  className="flex-shrink-0 flex items-center justify-center"
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    border: `1.5px solid ${isSelected ? 'var(--ls-accent)' : 'var(--ls-border-strong)'}`,
                    background: 'transparent',
                  }}
                >
                  {isSelected && (
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: 'var(--ls-accent)',
                      }}
                    />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {!selectedSource && (
        <div
          style={{
            padding: '24px',
            textAlign: 'center',
            border: '1px dashed var(--ls-border-strong)',
            borderRadius: 8,
            background: 'var(--ls-bg-1)',
          }}
        >
          <p style={{ fontSize: 12.5, color: 'var(--ls-text-3)' }}>
            Pick a source above to continue.
          </p>
        </div>
      )}
    </div>
  );
};

export default SourceSelection;
