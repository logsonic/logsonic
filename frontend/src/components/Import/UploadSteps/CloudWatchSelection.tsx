import React, { useState, useEffect } from 'react';
import { cloudwatchService } from '../utils/cloudwatchService';
import { useSearchQueryParamsStore } from '@/stores/useSearchParams';
import { useCloudWatchStore } from '@/stores/useCloudWatchStore';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { DateRangePicker } from '../../DateRangePicker/DateRangePicker';
import { Cloud, CloudOff, ChevronRight, ChevronDown, Search, Loader2, Info, ArrowLeft } from "lucide-react";

const DEFAULT_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'af-south-1',
  'ap-east-1',
  'ap-south-1',
  'ap-northeast-3',
  'ap-northeast-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ca-central-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-south-1',
  'eu-west-3',
  'eu-north-1',
  'me-south-1',
  'sa-east-1',
];

interface CloudWatchSelectionProps {
  onBackToSourceSelection: () => void;
  onCloudWatchLogSelect: (logData: string, filename: string) => void;
}

export const CloudWatchSelection: React.FC<CloudWatchSelectionProps> = ({ 
  onBackToSourceSelection,
  onCloudWatchLogSelect
}) => {
  const dateRangeStore = useSearchQueryParamsStore();
  const [showDatePicker, setShowDatePicker] = useState<boolean>(false);
  
  // Use the CloudWatch store
  const {
    authMethod, region, profile,
    logGroups, expandedGroups, loadingStreams, searchQuery, selectedStream,
    isLoading, error,
    
    setAuthMethod, setRegion, setProfile,
    setLogGroups, setStreamsForGroup, toggleGroupExpanded,
    setLoadingStreams, setSelectedStream, setSearchQuery,
    setLoading, setError, reset
  } = useCloudWatchStore();
  
  // Reset the store when the component is unmounted
  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  const handleAuthChange = (field: 'region' | 'profile', value: string) => {
    switch (field) {
      case 'region':
        setRegion(value);
        break;
      case 'profile':
        setProfile(value);
        break;
    }
  };

  const fetchLogGroups = async () => {
    setError(null);
    setLoading(true);
    
    try {
      const authData = {
        region,
        profile
      };

      const response = await cloudwatchService.listLogGroups(authData);
      setLogGroups(response.logGroups || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch log groups');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleGroupExpand = async (logGroupName: string) => {
    toggleGroupExpanded(logGroupName);
    
    // If expanding and no streams loaded yet, fetch them
    const isExpanding = !expandedGroups[logGroupName];
    if (isExpanding) {
      const groupData = logGroups.find(group => group.name === logGroupName);
      
      if (groupData && (!groupData.streams || groupData.streams.length === 0)) {
        await fetchLogStreams(logGroupName);
      }
    }
  };
  
  const fetchLogStreams = async (logGroupName: string) => {
    setLoadingStreams(logGroupName, true);
    
    try {
      const startTime = dateRangeStore.UTCTimeSince ? new Date(dateRangeStore.UTCTimeSince).toISOString() : undefined;
      const endTime = dateRangeStore.UTCTimeTo ? new Date(dateRangeStore.UTCTimeTo).toISOString() : undefined;
      
      const authData = {
        region,
        profile,
        logGroupName,
        startTime,
        endTime
      };
      
      const response = await cloudwatchService.listLogStreams(authData);
      setStreamsForGroup(logGroupName, response.logStreams || []);
    } catch (err) {
      setError(`Failed to fetch streams for ${logGroupName}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoadingStreams(logGroupName, false);
    }
  };

  const handleStreamSelect = (groupName: string, streamName: string) => {
    setSelectedStream(groupName, streamName);
  };

  const handleImport = async () => {
    if (!selectedStream) {
      setError("Please select a log stream to import");
      return;
    }
    
    setError(null);
    setLoading(true);
    
    try {
      // Get time range from the date range store
      const startTime = dateRangeStore.UTCTimeSince ? new Date(dateRangeStore.UTCTimeSince).toISOString() : undefined;
      const endTime = dateRangeStore.UTCTimeTo ? new Date(dateRangeStore.UTCTimeTo).toISOString() : undefined;
      
      // Prepare request data for fetching log events
      const authData = {
        region,
        profile,
        logGroupName: selectedStream.groupName,
        logStreamName: selectedStream.streamName,
        startTime,
        endTime
      };
      
      // Fetch log events from CloudWatch
      const response = await cloudwatchService.getLogEvents(authData);
      
      if (!response.logEvents || response.logEvents.length === 0) {
        setError("No log events found in the selected time range");
        return;
      }
      
      // Format log data for import
      const logData = response.logEvents.map(event => {
        const timestamp = new Date(event.timestamp).toISOString();
        return `[${timestamp}] ${event.message}`;
      }).join('\n');
      
      console.log(`Prepared ${response.logEvents.length} CloudWatch log events for import`);
      
      if (logData.trim().length === 0) {
        setError("Log data is empty after processing. Please try a different log stream or time range.");
        return;
      }
      
      // Generate filename based on log group and stream
      const sanitizedGroupName = selectedStream.groupName.replace(/[^a-z0-9]/gi, '-');
      const sanitizedStreamName = selectedStream.streamName.replace(/[^a-z0-9]/gi, '-');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `cloudwatch-${sanitizedGroupName}-${sanitizedStreamName}-${timestamp}.log`;
      
      // Pass the log data and filename to the callback
      // This will create a file from the blob and advance to step 2
      console.log(`Proceeding to pattern detection with CloudWatch logs: ${filename}, ${logData.length} bytes, ${response.logEvents.length} events`);
      onCloudWatchLogSelect(logData, filename);
    } catch (err) {
      setError(`Failed to fetch log events: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDateRangeClose = () => {
    setShowDatePicker(false);
  };
  
  const filteredLogGroups = searchQuery 
    ? logGroups
        .map(group => ({
          ...group,
          matchesSearch: 
            group.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
            (group.streams || []).some(stream => 
              stream.name.toLowerCase().includes(searchQuery.toLowerCase())
            )
        }))
        .filter(group => group.matchesSearch)
    : logGroups;

  return (
    <div className="space-y-4 pt-6 pb-6">
      <div className="flex items-center mb-4">
        <Button 
          variant="outline" 
          size="sm" 
          className="mr-2"
          onClick={onBackToSourceSelection}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <h2 className="text-xl font-bold">Import from AWS CloudWatch</h2>
      </div>
      
      {/* AWS Authentication */}
      <Card>
        <CardContent className="pt-6">
          <h3 className="text-sm font-medium mb-2">AWS Authentication</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-500">Region</label>
              <Select 
                value={region} 
                onValueChange={(value) => handleAuthChange('region', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select region" />
                </SelectTrigger>
                <SelectContent>
                  {DEFAULT_REGIONS.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-gray-500">Profile</label>
              <Input 
                placeholder="default" 
                value={profile} 
                onChange={(e) => handleAuthChange('profile', e.target.value)} 
              />
            </div>
          </div>
          <div className="flex justify-end mt-4">
            <Button
              onClick={fetchLogGroups}
              disabled={isLoading}
              className="ml-auto"
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 
                  Loading...
                </>
              ) : (
                <>
                  <Cloud className="mr-2 h-4 w-4" /> 
                  Fetch Log Groups
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
      
      {/* Time Range */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Time Range</h3>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowDatePicker(!showDatePicker)}
            >
              {showDatePicker ? 'Hide' : 'Select Time Range'}
            </Button>
          </div>
          
          {showDatePicker && (
            <div className="mt-4">
              <DateRangePicker onApply={handleDateRangeClose} />
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Log Group/Stream Selection */}
      {logGroups.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium">Select Log Stream</h3>
              <div className="relative w-64">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search log groups and streams..."
                  className="pl-8"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>
            
            <div className="border rounded-md max-h-80 overflow-y-auto">
              {filteredLogGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-6 text-center text-gray-500">
                  <CloudOff className="h-10 w-10 mb-2" />
                  <p>No log groups found.</p>
                </div>
              ) : (
                <ul className="divide-y">
                  {filteredLogGroups.map((group) => (
                    <li key={group.name} className="px-4 py-3">
                      <div
                        className="flex items-center cursor-pointer"
                        onClick={() => handleToggleGroupExpand(group.name)}
                      >
                        {expandedGroups[group.name] ? (
                          <ChevronDown className="h-4 w-4 mr-2" />
                        ) : (
                          <ChevronRight className="h-4 w-4 mr-2" />
                        )}
                        <span className="font-medium text-sm">{group.name}</span>
                      </div>
                      
                      {expandedGroups[group.name] && (
                        <div className="ml-6 mt-2">
                          {loadingStreams[group.name] ? (
                            <div className="flex items-center text-sm text-gray-500 py-2">
                              <Loader2 className="animate-spin h-4 w-4 mr-2" />
                              Loading streams...
                            </div>
                          ) : (
                            <>
                              {(group.streams || []).length === 0 ? (
                                <div className="text-sm text-gray-500 py-2">
                                  No streams found
                                </div>
                              ) : (
                                <ul className="space-y-1">
                                  {(group.streams || []).map((stream) => (
                                    <li 
                                      key={stream.name} 
                                      className={`
                                        text-sm py-1 px-2 rounded cursor-pointer
                                        ${selectedStream && selectedStream.groupName === group.name && selectedStream.streamName === stream.name 
                                          ? 'bg-blue-100 text-blue-700' 
                                          : 'hover:bg-gray-100'
                                        }
                                      `}
                                      onClick={() => handleStreamSelect(group.name, stream.name)}
                                    >
                                      {stream.name}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            
            {selectedStream && (
              <div className="mt-4 p-3 bg-blue-50 rounded-md text-sm flex items-start">
                <Info className="h-4 w-4 text-blue-500 mr-2 mt-0.5" />
                <div>
                  <p className="font-medium">Selected stream:</p>
                  <p>Group: {selectedStream.groupName}</p>
                  <p>Stream: {selectedStream.streamName}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      
      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-md text-sm">
          {error}
        </div>
      )}
      
      {/* Actions */}
      <div className="flex justify-end mt-4">
        <Button
          onClick={handleImport}
          disabled={isLoading || !selectedStream}
          className="ml-auto"
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 
              Importing...
            </>
          ) : (
            <>
              <Cloud className="mr-2 h-4 w-4" /> 
              Select Logs for Pattern Detection
            </>
          )}
        </Button>
      </div>
    </div>
  );
};

export default CloudWatchSelection; 