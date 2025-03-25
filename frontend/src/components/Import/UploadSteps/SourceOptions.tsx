import React, { useState, useEffect } from 'react';
import { useImportStore } from '@/stores/useImportStore';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export const SourceOptions: React.FC = () => {
  const { 
    sessionOptions, 
    setSessionOptions, 
    selectedSources 
  } = useImportStore();
  
  // Use the first selected source as the default source, or empty string if none selected
  const [sourceValue, setSourceValue] = useState<string>(
    selectedSources.length > 0 ? selectedSources[0] : sessionOptions.source || ''
  );
  
  // Initialize source value from selected sources when component mounts
  useEffect(() => {
    if (selectedSources.length > 0 && !sourceValue) {
      setSourceValue(selectedSources[0]);
      setSessionOptions({ source: selectedSources[0] });
    }
  }, [selectedSources, sourceValue, setSessionOptions]);
  
  // Update session options when source value changes
  const handleSourceChange = (value: string) => {
    setSourceValue(value);
    setSessionOptions({ source: value });
  };
  
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Source Options</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="source">Source Name</Label>
          <Input
            id="source"
            value={sourceValue}
            onChange={(e) => handleSourceChange(e.target.value)}
            placeholder="Enter source name (e.g., application, system, access)"
          />
          {selectedSources.length > 0 && (
            <div className="mt-2">
              <Label>Select from available sources:</Label>
              <Select
                value={sourceValue}
                onValueChange={handleSourceChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a source" />
                </SelectTrigger>
                <SelectContent>
                  {selectedSources.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            The source name helps identify where the logs originated from
          </p>
        </div>
        
        <div className="space-y-2">
          <div className="flex items-center space-x-2">
            <Checkbox 
              id="smart_decoder" 
              checked={sessionOptions.smart_decoder} 
              onCheckedChange={(checked) => 
                setSessionOptions({ smart_decoder: checked === true })
              }
            />
            <Label htmlFor="smart_decoder">Enable Smart Decoder</Label>
          </div>
          <p className="text-sm text-muted-foreground pl-6">
            Smart decoder attempts to automatically handle various date formats and other common log elements
          </p>
        </div>
      </CardContent>
    </Card>
  );
}; 