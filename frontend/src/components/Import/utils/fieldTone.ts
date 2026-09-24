// Which highlight tone a parsed field gets in the preview pane. Semantic
// names map to fixed tones (timestamp blue, host amber, process green,
// level/status red) so the same kind of field looks the same across files;
// everything else cycles so adjacent fields stay distinguishable. Tones are
// CSS classes on tokens, so they hold up in dark mode.
export type FieldTone = 'blue' | 'amber' | 'green' | 'violet' | 'red' | 'gray' | 'plain';

const SEMANTIC: [RegExp, FieldTone][] = [
  [/^(timestamp|time|ts|date|datetime|logtime|event_time)$/i, 'blue'],
  [
    /(^|_)(host|hostname|ip|clientip|client_ip|remote_addr|server|source_ip|srcip|dstip)$/i,
    'amber',
  ],
  [/^(process|program|pid|logger|thread|service|component|module|app|source)$/i, 'green'],
  [/^(level|loglevel|log_level|severity|status|status_code|response|code)$/i, 'red'],
  [/^(message|msg|text|body)$/i, 'plain'],
];

const CYCLE: FieldTone[] = ['violet', 'gray', 'green', 'amber', 'blue'];

export function fieldTones(fields: string[]): Record<string, FieldTone> {
  const out: Record<string, FieldTone> = {};
  let cycle = 0;
  for (const f of fields) {
    const hit = SEMANTIC.find(([re]) => re.test(f));
    if (hit) {
      out[f] = hit[1];
    } else {
      out[f] = CYCLE[cycle % CYCLE.length];
      cycle += 1;
    }
  }
  return out;
}

// Segments of a raw line: matched fields (with their tone) and the literal
// text between them. Fields are located by their first occurrence in the
// raw line, same rule as patternUtils.highlightLogLine.
export interface LineSegment {
  text: string;
  field?: string;
  tone: FieldTone | 'muted';
}

export function segmentLine(
  rawLine: string,
  parsed: Record<string, unknown> | undefined,
  tones: Record<string, FieldTone>
): LineSegment[] {
  if (!parsed) return [{ text: rawLine, tone: 'plain' }];
  const located = Object.entries(parsed)
    .filter(([k, v]) => k !== '_raw' && k !== '_src' && k !== 'error' && v != null)
    .map(([k, v]) => ({ field: k, value: String(v) }))
    .filter(({ value }) => value.trim() !== '' && value !== '-')
    .map((e) => ({ ...e, position: rawLine.indexOf(e.value) }))
    .filter((e) => e.position >= 0)
    .sort((a, b) => a.position - b.position);

  const segments: LineSegment[] = [];
  let cursor = 0;
  for (const { field, value, position } of located) {
    if (position < cursor) continue; // overlaps a field already emitted
    if (position > cursor) segments.push({ text: rawLine.slice(cursor, position), tone: 'muted' });
    segments.push({ text: value, field, tone: tones[field] ?? 'plain' });
    cursor = position + value.length;
  }
  if (cursor < rawLine.length) segments.push({ text: rawLine.slice(cursor), tone: 'muted' });
  return segments.length > 0 ? segments : [{ text: rawLine, tone: 'plain' }];
}
