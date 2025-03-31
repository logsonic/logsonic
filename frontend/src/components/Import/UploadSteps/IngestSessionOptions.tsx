import { FC, useState } from 'react';
import { useImportStore } from '@/stores/useImportStore';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Settings2 } from 'lucide-react';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { TimezoneSelectorCommon } from '@/components/common/TimezoneSelectorCommon';

export const IngestSessionOptions: FC = () => {
  const { 
    sessionOptionsFileName,
    sessionOptionsSmartDecoder,
    sessionOptionsTimezone,
    sessionOptionsYear,      
    sessionOptionsMonth,
    sessionOptionsDay,
    selectedFileName,
    selectedPattern,
    setSessionOptionFileName,
    setSessionOptionSmartDecoder,
    setSessionOptionTimezone,
    setSessionOptionYear,
    setSessionOptionMonth,
    setSessionOptionDay,
    handlePatternOperation
  } = useImportStore();

  const [isUpdating, setIsUpdating] = useState(false);

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
            <CardContent className="pt-3 ">

              <div className="grid grid-cols-1 md:grid-cols-6 gap-x-4 gap-y-0 items-end">
                
                {/* Column 1: Smart Decoder */}
                <div className="space-y-1.5 col-span-2">
                  <Label htmlFor="smart_decoder" className="text-sm font-medium">Smart Decoder</Label>
                  <div className="h-9 flex items-center">
                    <Switch 
                      id="smart_decoder"
                      checked={sessionOptionsSmartDecoder || false} 
                      onCheckedChange={(checked) => setSessionOptionSmartDecoder(checked)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Automatically detects emails, IP addresses and other patterns in your logs</p>
                </div>

                {/* Column 2: Timezone */}
                <div className="space-y-1.5 col-span-1">
                  <Label htmlFor="force_timezone" className="text-sm font-medium">Force Timezone</Label>
                  <TimezoneSelectorCommon
                    selectedTimezone={sessionOptionsTimezone || 'auto'}
                    onTimezoneChange={setSessionOptionTimezone}
                    label="Force Timezone"
                    placeholder="Timezone"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Force the timezone of the logs to a specific timezone</p>
                </div>      

                {/* Column 3: Year */}
                <div className="space-y-1.5">
                  <Label htmlFor="force_start_year" className="text-sm font-medium">Force Year</Label>
                  <Input 
                    type="number"
                    aria-valuemin={1900}
                    aria-valuemax={2050}
                    value={sessionOptionsYear || ''} 
                    onChange={(e) => setSessionOptionYear(e.target.value)}
                    className="h-9"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Force the year of the logs to a specific year</p>
                </div>
                
                {/* Column 4: Month */}
                <div className="space-y-1.5">
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
                  <p className="text-xs text-muted-foreground mt-1">Force the month of the logs to a specific month</p>
                </div>
                
                {/* Column 5: Day */}
                <div className="space-y-1.5">
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
                  <p className="text-xs text-muted-foreground mt-1">Force the day of the logs to a specific day</p>
                </div>
              </div>
              
              {isUpdating && (
                <div className="mt-2 text-xs text-muted-foreground flex items-center">
                  <div className="w-3 h-3 mr-1 rounded-full bg-blue-500 animate-pulse"></div>
                  Updating preview...
                </div>
              )}

            </CardContent>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
};

export default IngestSessionOptions; 