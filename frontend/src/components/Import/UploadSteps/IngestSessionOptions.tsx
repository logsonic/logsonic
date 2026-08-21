import { TimezoneSelectorCommon } from '@/components/common/TimezoneSelectorCommon';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useImportStore } from '@/stores/useImportStore';
import { Settings2 } from 'lucide-react';
import { FC } from 'react';

// Presets mirror log2grok's CommonMultilineConfigs() so the wizard's
// choices stay consistent with the backend's own ready-made configs.
export const ISO8601_HEADER_PATTERN = String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`;
export const SYSLOG_HEADER_PATTERN = String.raw`^[A-Z][a-z]{2}\s{1,2}\d{1,2}\s\d{2}:\d{2}:\d{2}`;

type MultilinePreset = 'iso8601' | 'syslog' | 'indent' | 'custom';

const presetFromState = (mode: 'header' | 'indent', headerPattern: string): MultilinePreset => {
  if (mode === 'indent') return 'indent';
  if (headerPattern === ISO8601_HEADER_PATTERN) return 'iso8601';
  if (headerPattern === SYSLOG_HEADER_PATTERN) return 'syslog';
  return 'custom';
};

export const IngestSessionOptions: FC = () => {
  const {
    sessionOptionsSmartDecoder,
    sessionOptionsTimezone,
    sessionOptionsYear,
    sessionOptionsMonth,
    sessionOptionsDay,
    sessionOptionsMultilineEnabled,
    sessionOptionsMultilineMode,
    sessionOptionsMultilineHeaderPattern,
    setSessionOptionSmartDecoder,
    setSessionOptionTimezone,
    setSessionOptionYear,
    setSessionOptionMonth,
    setSessionOptionDay,
    setSessionOptionMultilineEnabled,
    setSessionOptionMultilineMode,
    setSessionOptionMultilineHeaderPattern,
  } = useImportStore();

  const multilinePreset = presetFromState(sessionOptionsMultilineMode, sessionOptionsMultilineHeaderPattern);

  const handlePresetChange = (preset: MultilinePreset) => {
    switch (preset) {
      case 'iso8601':
        setSessionOptionMultilineMode('header');
        setSessionOptionMultilineHeaderPattern(ISO8601_HEADER_PATTERN);
        break;
      case 'syslog':
        setSessionOptionMultilineMode('header');
        setSessionOptionMultilineHeaderPattern(SYSLOG_HEADER_PATTERN);
        break;
      case 'indent':
        setSessionOptionMultilineMode('indent');
        setSessionOptionMultilineHeaderPattern('');
        break;
      case 'custom':
        setSessionOptionMultilineMode('header');
        setSessionOptionMultilineHeaderPattern('');
        break;
    }
  };



  return (
    <Card className="mt-4">
      <Accordion type="single" defaultValue="ingest-options" collapsible className="w-full">
        <AccordionItem value="ingest-options" className="pb-4">
          <CardHeader className="pb-0 pt-3">
            <AccordionTrigger className="py-0">
              <CardTitle className="text-md flex items-center">
                <Settings2 className="mr-2 h-5 w-5" />
                Ingest Session Options
              </CardTitle>
            </AccordionTrigger>
          </CardHeader>
          <AccordionContent>
            <CardContent className="pt-3">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12 items-start">
                <div className="space-y-1.5 min-w-0 sm:col-span-2 lg:col-span-3">
                  <Label htmlFor="smart_decoder" className="text-sm font-medium">Smart Decoder</Label>
                  <div className="h-9 flex items-center">
                    <Switch
                      id="smart_decoder"
                      checked={sessionOptionsSmartDecoder || false}
                      onCheckedChange={(checked) => setSessionOptionSmartDecoder(checked)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground leading-snug">Automatically detects emails, IP addresses and other patterns in your logs</p>
                </div>

                <div className="space-y-1.5 min-w-0 lg:col-span-3">
                  <Label htmlFor="force_timezone" className="text-sm font-medium">Force Timezone</Label>
                  <TimezoneSelectorCommon
                    selectedTimezone={sessionOptionsTimezone || 'auto'}
                    onTimezoneChange={setSessionOptionTimezone}
                    label="Force Timezone"
                    placeholder="Timezone"
                  />
                  <p className="text-xs text-muted-foreground leading-snug">Override the timezone used when parsing timestamps</p>
                </div>

                <div className="space-y-1.5 min-w-0 lg:col-span-2">
                  <Label htmlFor="force_start_year" className="text-sm font-medium">Force Year</Label>
                  <Input
                    id="force_start_year"
                    type="number"
                    aria-valuemin={1900}
                    aria-valuemax={2050}
                    value={sessionOptionsYear || ''}
                    onChange={(e) => setSessionOptionYear(e.target.value)}
                    className="h-9"
                  />
                  <p className="text-xs text-muted-foreground leading-snug">Override year when logs omit it</p>
                </div>

                <div className="space-y-1.5 min-w-0 lg:col-span-2">
                  <Label htmlFor="force_start_month" className="text-sm font-medium">Force Month</Label>
                  <Select
                    value={sessionOptionsMonth || ''}
                    onValueChange={(value) => setSessionOptionMonth(value)}
                  >
                    <SelectTrigger id="force_start_month" className="h-9">
                      <SelectValue placeholder="MM" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto-detect</SelectItem>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((month) => (
                        <SelectItem key={month} value={month.toString()}>
                          {month.toString().padStart(2, '0')} - {new Date(2000, month-1, 1).toLocaleString('default', { month: 'long' })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground leading-snug">Override month when logs omit it</p>
                </div>

                <div className="space-y-1.5 min-w-0 lg:col-span-2">
                  <Label htmlFor="force_start_day" className="text-sm font-medium">Force Day</Label>
                  <Select
                    value={sessionOptionsDay || ''}
                    onValueChange={(value) => setSessionOptionDay(value)}
                  >
                    <SelectTrigger id="force_start_day" className="h-9">
                      <SelectValue placeholder="DD" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto-detect</SelectItem>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                        <SelectItem key={day} value={day.toString()}>
                          {day.toString().padStart(2, '0')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground leading-snug">Override day when logs omit it</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-4 items-start mt-4 pt-4 border-t">
                <div className="space-y-1.5 min-w-0 lg:col-span-3">
                  <Label htmlFor="multiline_enabled" className="text-sm font-medium">Multiline Records</Label>
                  <div className="h-9 flex items-center">
                    <Switch
                      id="multiline_enabled"
                      checked={sessionOptionsMultilineEnabled}
                      onCheckedChange={(checked) => {
                        setSessionOptionMultilineEnabled(checked);
                        if (
                          checked
                          && sessionOptionsMultilineMode === 'header'
                          && !sessionOptionsMultilineHeaderPattern.trim()
                        ) {
                          setSessionOptionMultilineHeaderPattern(ISO8601_HEADER_PATTERN);
                        }
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground leading-snug">Fold continuation lines (stack traces, wrapped entries) into the log statement they belong to</p>
                </div>

                <div className={cn(
                  'space-y-1.5 min-w-0',
                  sessionOptionsMultilineEnabled && sessionOptionsMultilineMode === 'header'
                    ? 'lg:col-span-4'
                    : 'md:col-span-2 lg:col-span-9',
                )}>
                  <Label htmlFor="multiline_preset" className="text-sm font-medium">Continuation Style</Label>
                  <Select
                    value={multilinePreset}
                    onValueChange={(value) => handlePresetChange(value as MultilinePreset)}
                    disabled={!sessionOptionsMultilineEnabled}
                  >
                    <SelectTrigger id="multiline_preset" className="h-9">
                      <SelectValue placeholder="Continuation style" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="iso8601">New line starts with an ISO 8601 timestamp</SelectItem>
                      <SelectItem value="syslog">New line starts with a syslog timestamp</SelectItem>
                      <SelectItem value="indent">Continuation lines are indented</SelectItem>
                      <SelectItem value="custom">Custom regex</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground leading-snug">How to tell a new log statement from a continuation of the previous one</p>
                </div>

                {sessionOptionsMultilineEnabled && sessionOptionsMultilineMode === 'header' && (
                  <div className="space-y-1.5 min-w-0 md:col-span-2 lg:col-span-5">
                    <Label htmlFor="multiline_header_pattern" className="text-sm font-medium">New-record Pattern</Label>
                    <Input
                      id="multiline_header_pattern"
                      value={sessionOptionsMultilineHeaderPattern}
                      onChange={(e) => setSessionOptionMultilineHeaderPattern(e.target.value)}
                      placeholder={String.raw`e.g. ^\d{4}-\d{2}-\d{2}`}
                      className="h-9 font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground leading-snug">Regex matching the start of a new log statement; every other line joins the previous one</p>
                  </div>
                )}
              </div>
            </CardContent>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
};

export default IngestSessionOptions; 