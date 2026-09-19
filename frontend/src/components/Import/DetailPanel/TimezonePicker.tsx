import { FC, useMemo, useState } from 'react';

import { getFormattedTimezones } from '@/components/common/TimezoneSelectorCommon';

interface TimezonePickerProps {
  // null = auto (as captured / detected)
  value: string | null;
  onChange: (tz: string | null) => void;
  maxHeight?: number;
}

// Zones surfaced first, before the full IANA list; the handoff's dozen
// plus the browser's own zone.
const COMMON = [
  'UTC',
  'Europe/Zurich',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'America/Sao_Paulo',
];

/**
 * Searchable IANA timezone list shared by the Timestamp tab's TZ tile and
 * the Options tab's Force timezone select -- both edit the same per-file
 * value.
 */
export const TimezonePicker: FC<TimezonePickerProps> = ({ value, onChange, maxHeight = 190 }) => {
  const [query, setQuery] = useState('');
  const zones = useMemo(() => {
    const all = getFormattedTimezones().filter((z) => z.id !== 'auto' && z.id !== 'Local');
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const first = [local, ...COMMON].filter((id, i, arr) => arr.indexOf(id) === i);
    const byId = new Map(all.map((z) => [z.id, z]));
    const head = first.map((id) => byId.get(id)).filter((z): z is NonNullable<typeof z> => !!z);
    const rest = all.filter((z) => !first.includes(z.id));
    return [...head, ...rest];
  }, []);
  const q = query.trim().toLowerCase();
  const shown = q ? zones.filter((z) => z.displayName.toLowerCase().includes(q)) : zones;

  return (
    <div>
      <input
        className="ls-imp-input"
        placeholder="Search timezones…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search timezones"
        autoFocus
      />
      <div className="flex flex-wrap" style={{ gap: 6, marginTop: 8, maxHeight, overflow: 'auto' }}>
        {!q && (
          <button
            type="button"
            className={`ls-imp-opt${value == null ? ' ls-imp-opt--selected' : ''}`}
            onClick={() => onChange(null)}
          >
            Auto
            <small>from detection</small>
          </button>
        )}
        {shown.slice(0, q ? 60 : 40).map((z) => {
          const offset = z.displayName.match(/\((GMT[^)]*)\)\s*$/)?.[1] ?? '';
          return (
            <button
              key={z.id}
              type="button"
              className={`ls-imp-opt${value === z.id ? ' ls-imp-opt--selected' : ''}`}
              onClick={() => onChange(z.id)}
            >
              {z.id}
              <small>{offset}</small>
            </button>
          );
        })}
        {shown.length === 0 && (
          <span style={{ fontSize: 12, color: 'var(--ls-text-3)' }}>No timezone matches.</span>
        )}
      </div>
    </div>
  );
};

export default TimezonePicker;
