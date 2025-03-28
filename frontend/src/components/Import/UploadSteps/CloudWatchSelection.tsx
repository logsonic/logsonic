import React, { useState, useEffect, useImperativeHandle, forwardRef } from 'react';
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
import { Cloud, CloudOff, ChevronRight, ChevronDown, Search, Loader2, Info, ArrowLeft } from "lucide-react";
import { DateTimeRangeButton } from "@/components/DateRangePicker/DateTimeRangeButton";
import { useImportStore } from '@/stores/useImportStore';

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

// Export the interface for the ref
export interface CloudWatchSelectionRef {
  handleImport: () => Promise<void>;
}

export const CloudWatchSelection = forwardRef<CloudWatchSelectionRef, CloudWatchSelectionProps>(({ 
  onBackToSourceSelection,
  onCloudWatchLogSelect
}, ref) => {
  const dateRangeStore = useSearchQueryParamsStore();
  
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

  const { setMetadata } = useImportStore();
  
  // Reset the store when the component is unmounted
  useEffect(() => {
    return () => {
      console.log("CloudWatchSelection component cleanup - NOT resetting store to preserve selection");
      // Don't reset here - we want to preserve the selection
      // reset();
    };
  }, [reset]);

  // Expose the handleImport method to the parent component via ref
  useImperativeHandle(ref, () => ({
    handleImport: async () => {
      if (!selectedStream) {
        throw new Error("Please select a log stream to import");
      }
      return handleImport();
    }
  }));

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
      
      // Create log group objects from the string array that comes from the backend
      const groups = (response.log_groups || []).map(groupName => ({
        name: groupName,
        arn: "",
        creationTime: "",
        storedBytes: 0,
        retentionDays: 0
      }));
      
      setLogGroups(groups);
      
      // If log groups were found, automatically fetch streams for all of them
      if (groups.length > 0) {
        console.log(`Fetching streams for ${groups.length} log groups`);
        
        // Show loading state for all groups
        const loadingMap = {};
        groups.forEach(group => {
          loadingMap[group.name] = true;
          toggleGroupExpanded(group.name); // Auto-expand all groups
        });
        
        // Update loading state
        Object.keys(loadingMap).forEach(groupName => {
          setLoadingStreams(groupName, true);
        });
        
        // Fetch streams for each group
        const streamFetchPromises = groups.map(group => fetchLogStreamsForGroup(group.name));
        
        // Wait for all streams to be fetched
        await Promise.all(streamFetchPromises);
        
        console.log("All log streams fetched successfully");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch log groups');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Function to fetch streams for a specific group (used by fetchLogGroups)
  const fetchLogStreamsForGroup = async (logGroupName: string) => {
    try {
      // Get dates from the store
      const startTime = dateRangeStore.UTCTimeSince 
        ? new Date(dateRangeStore.UTCTimeSince).getTime() 
        : undefined;
      
      const endTime = dateRangeStore.UTCTimeTo 
        ? new Date(dateRangeStore.UTCTimeTo).getTime() 
        : undefined;
      
      console.log(`Fetching log streams for ${logGroupName} with time range: ${startTime} to ${endTime}`);
      
      const authData = {
        region,
        profile,
        log_group_name: logGroupName,
        start_time: startTime,
        end_time: endTime
      };
      
      const response = await cloudwatchService.listLogStreams(authData);
      
      // Convert string array to CloudWatchLogStream objects
      const streams = (response.log_streams || []).map(streamName => ({
        name: streamName,
        log_group_name: logGroupName,
        creation_time: "",
        first_event_time: "",
        last_event_time: "",
        stored_bytes: 0
      }));
      
      setStreamsForGroup(logGroupName, streams);
      return response;
    } catch (err) {
      console.error(`Failed to fetch streams for ${logGroupName}:`, err);
      // Don't set global error, just log it to avoid stopping the entire process
      return null;
    } finally {
      setLoadingStreams(logGroupName, false);
    }
  };
  
  const fetchLogStreams = async (logGroupName: string) => {
    setLoadingStreams(logGroupName, true);
    
    try {
      await fetchLogStreamsForGroup(logGroupName);
    } catch (err) {
      setError(`Failed to fetch streams for ${logGroupName}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoadingStreams(logGroupName, false);
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

  const handleStreamSelect = (groupName: string, streamName: string) => {
    setSelectedStream(groupName, streamName);
  };

  const handleImport = async () => {
    // Verify selectedStream is not null first
    if (!selectedStream) {
      setError("Please select a log stream to import");
      return;
    }
    
    setError(null);
    setLoading(true);
    
    try {
      // Get dates from the store
      const startTime = dateRangeStore.UTCTimeSince 
        ? new Date(dateRangeStore.UTCTimeSince).getTime() 
        : undefined;
      
      const endTime = dateRangeStore.UTCTimeTo 
        ? new Date(dateRangeStore.UTCTimeTo).getTime() 
        : undefined;
      
      console.log(`Fetching log events for ${selectedStream.groupName}/${selectedStream.streamName} with time range: ${startTime} to ${endTime}`);
      
      // Prepare request data for fetching log events
      const authData = {
        region,
        profile,
        log_group_name: selectedStream.groupName,
        log_stream_name: selectedStream.streamName,
        start_time: startTime,
        end_time: endTime
      };
      
      // Fetch log events from CloudWatch
      const response = await cloudwatchService.getLogEvents(authData);
      
      if (!response.log_events || response.log_events.length === 0) {
        setError("No log events found in the selected time range");
        return; 
      }
      
      // Format log data for import
      const logData = response.log_events.map(event => {
        const timestamp = new Date(event.timestamp).toISOString();
        return `${timestamp} ${event.message}`; //Prepend timestamp to each line
      }).join('\n');
      
      //set Metadata
      setMetadata({
        _aws_region: region,
        _aws_profile: profile,
        _log_group_name: selectedStream.groupName,
        _log_stream_name: selectedStream.streamName,
        _src: 'cloudwatch',
      });


      if (logData.trim().length === 0) {
        setError("Log data is empty after processing. Please try a different log stream or time range.");
        return;
      }
      
      // Generate filename based on log group and stream
      const sanitizedGroupName = selectedStream.groupName.replace(/[^a-z0-9]/gi, '-');
      const sanitizedStreamName = selectedStream.streamName.replace(/[^a-z0-9]/gi, '-');
      
      const filename = `cw-${sanitizedGroupName}-${sanitizedStreamName}`;
        onCloudWatchLogSelect(logData, filename);
    } catch (err) {
      setError(`Failed to fetch log events: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
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
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="space-y-4">
            {/* Region, AWS Profile, Time Range and Connect button in one line */}
            <div className="flex items-end space-x-4">
              <div className="w-1/5">
                <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
                <Select
                  value={region}
                  onValueChange={(value) => handleAuthChange('region', value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a region" />
                  </SelectTrigger>
                  <SelectContent>
                    {DEFAULT_REGIONS.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="w-1/5">
                <label className="block text-sm font-medium text-gray-700 mb-1">AWS Profile</label>
                <Input
                  placeholder="default"
                  value={profile}
                  onChange={(e) => handleAuthChange('profile', e.target.value)}
                  className="w-full"
                />
              </div>
              
              <div className="w-2/5 flex-grow">
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Range</label>
                <div className="flex h-10 w-full ">
                  <DateTimeRangeButton />
                </div>
              </div>
              
              <Button 
                onClick={fetchLogGroups}
                disabled={isLoading}
                className="bg-blue-600 hover:bg-blue-700 h-10"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Fetching...
                  </>
                ) : (
                  <>
                    <Cloud className="mr-2 h-4 w-4" />
                    Load Log Streams
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      
      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-md text-sm">
          {error}
        </div>
      )}
      
      {/* Log Groups */}
      {logGroups.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-medium">CloudWatch Log Streams</h3>
                <p className="text-sm text-gray-500">Select a log stream to import</p>
              </div>
              <div className="relative w-1/3">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search log groups..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
            
            <div className="max-h-96 overflow-y-auto border rounded-md">
              {/* Render log groups */}
              {logGroups
                .filter(group => !searchQuery || group.name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map(group => (
                  <div key={group.name} className="border-b last:border-b-0">
                    <div 
                      className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-50"
                      onClick={() => handleToggleGroupExpand(group.name)}
                    >
                      <div className="flex items-center">
                        <div className="flex h-5 w-5 items-center justify-center mr-2">
                          <Cloud className="h-4 w-4 text-blue-500" />
                        </div>
                        <span className="font-medium">{group.name}</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs text-gray-500">
                          {group.streams ? group.streams.length : 0} streams
                        </span>
                        <ChevronDown className={`h-4 w-4 transition-transform ${expandedGroups[group.name] ? 'rotate-180' : ''}`} />
                      </div>
                    </div>
                    
                    {expandedGroups[group.name] && (
                      <div className="border-t bg-gray-50">
                        {loadingStreams[group.name] ? (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-5 w-5 animate-spin text-blue-500 mr-2" />
                            <span>Loading streams...</span>
                          </div>
                        ) : group.streams && group.streams.length > 0 ? (
                          <div className="divide-y divide-gray-100">
                            {group.streams.map(stream => (
                              <div 
                                key={stream.name}
                                className={`p-3 cursor-pointer flex items-center ${
                                  selectedStream && 
                                  selectedStream.groupName === group.name && 
                                  selectedStream.streamName === stream.name 
                                    ? 'bg-blue-50' 
                                    : 'hover:bg-gray-100'
                                }`}
                                onClick={() => handleStreamSelect(group.name, stream.name)}
                              >
                                <div className={`h-4 w-4 mr-3 rounded-full border flex items-center justify-center ${
                                  selectedStream && 
                                  selectedStream.groupName === group.name && 
                                  selectedStream.streamName === stream.name 
                                    ? 'border-blue-500' 
                                    : 'border-gray-400'
                                }`}>
                                  {selectedStream && 
                                   selectedStream.groupName === group.name && 
                                   selectedStream.streamName === stream.name && (
                                    <div className="h-2 w-2 rounded-full bg-blue-500"></div>
                                  )}
                                </div>
                                <span className={`text-sm ${
                                  selectedStream && 
                                  selectedStream.groupName === group.name && 
                                  selectedStream.streamName === stream.name 
                                    ? 'text-blue-700 font-medium' 
                                    : ''
                                }`}>{stream.name}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="py-3 px-4 text-gray-500 text-sm">
                            No log streams found
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                
              {/* Show message when no groups match search */}
              {logGroups.filter(group => !searchQuery || group.name.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 && (
                <div className="p-4 text-center text-gray-500">
                  No log groups found matching "{searchQuery}"
                </div>
              )}
            </div>
            
            {/* Selected Stream Info (without Import button) */}
            {selectedStream && (
              <div className="mt-4 p-3 border rounded-md bg-blue-50">
                <div className="flex items-center">
                  <div className="flex h-5 w-5 items-center justify-center mr-2">
                    <Cloud className="h-4 w-4 text-blue-500" />
                  </div>
                  <span className="font-medium text-blue-800">Selected for import:</span>
                </div>
                <div className="mt-2 pl-7">
                  <p className="text-sm text-blue-700">
                    <span className="font-medium">Group:</span> {selectedStream.groupName}
                  </p>
                  <p className="text-sm text-blue-700">
                    <span className="font-medium">Stream:</span> {selectedStream.streamName}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
});

export default CloudWatchSelection; 