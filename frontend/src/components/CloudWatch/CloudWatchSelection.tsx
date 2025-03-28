import { useState, useEffect, useImperativeHandle, forwardRef, FC } from 'react';
import { cloudwatchService } from './utils/cloudwatchService';
import { useSearchQueryParamsStore } from '@/stores/useSearchParams';
import { useCloudWatchStore } from './stores/useCloudWatchStore';
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
import { LogSourceProviderRef } from '@/components/Import/types';
import { LogPaginationState } from './types';

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

export interface CloudWatchSelectionProps {
  onBackToSourceSelection: () => void;
  onCloudWatchLogSelect: (logData: string, filename: string) => void;
}

// Export the interface for the ref
export interface CloudWatchSelectionRef extends LogSourceProviderRef {}

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
  
  const [logPagination, setLogPagination] = useState<LogPaginationState>({
    nextToken: null,
    hasMore: false,
    isLoading: false
  });
  
  const [retrievedLogs, setRetrievedLogs] = useState<string[]>([]);
  
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
    },
    validateCanProceed: async () => {
      // For CloudWatch, check if a stream has been selected
      if (!selectedStream) {
        return {
          canProceed: false,
          errorMessage: "Please select a log stream before proceeding."
        };
      }
      
      return { canProceed: true };
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
      
      // Now we receive full LogGroup objects instead of just names
      setLogGroups(response.log_groups || []);
      
      // If log groups were found, automatically fetch streams for all of them
      if (response.log_groups.length > 0) {
        console.log(`Fetching streams for ${response.log_groups.length} log groups`);
        
        // Show loading state for all groups
        const loadingMap = {};
        response.log_groups.forEach(group => {
          loadingMap[group.name] = true;
          toggleGroupExpanded(group.name); // Auto-expand all groups
        });
        
        // Update loading state
        Object.keys(loadingMap).forEach(groupName => {
          setLoadingStreams(groupName, true);
        });
        
        // Fetch streams for each group
        const streamFetchPromises = response.log_groups.map(group => fetchLogStreamsForGroup(group.name));
        
        // Wait for all streams to be fetched
        await Promise.all(streamFetchPromises);
        
        console.log("All log streams fetched successfully");
      } else {
        setError("No log groups found in this region. Please check if you have the correct region selected and appropriate permissions.");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error('CloudWatch fetch error:', errorMessage);
      
      // Provide more helpful error messages
      if (errorMessage.includes('credentials') || errorMessage.includes('auth') || 
          errorMessage.includes('permission') || errorMessage.includes('access')) {
        setError(
          "AWS authentication failed. Please ensure your AWS credentials are configured correctly:\n\n" +
          "1. Install AWS CLI and run 'aws configure' to set up your credentials\n" +
          "2. Verify the profile name (leave empty for 'default')\n" +
          "3. Ensure the configured user has CloudWatchLogsReadOnlyAccess permissions\n" +
          "4. Check your ~/.aws/credentials and ~/.aws/config files"
        );
      } else if (errorMessage.includes('timeout') || errorMessage.includes('network')) {
        setError("Network error when connecting to AWS. Please check your internet connection and try again.");
      } else {
        setError(`Failed to fetch log groups: ${errorMessage}`);
      }
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
      
      // Now we receive full LogStream objects instead of just names
      setStreamsForGroup(logGroupName, response.log_streams || []);
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
    if (!selectedStream) {
      setError("Please select a log stream to import");
      return;
    }

    setLoading(true);
    setError(null);
    
    // Reset pagination state and logs
    setLogPagination({
      nextToken: null,
      hasMore: false,
      isLoading: false
    });
    setRetrievedLogs([]);
    
    try {
      // Start fetching the first batch of logs
      await fetchAllLogs(selectedStream.groupName, selectedStream.streamName);
    } catch (err) {
      setError(`Failed to fetch log events: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };
  
  const fetchAllLogs = async (groupName: string, streamName: string) => {
    let currentToken: string | null = null;
    let hasMoreLogs = true;
    let allLogMessages: string[] = [];
    let batchCount = 0;
    
    setError(null);
    
    while (hasMoreLogs) {
      try {
        const { logs, token, more } = await fetchLogBatchInternal(groupName, streamName, currentToken);
        
        // Add logs to our collection
        allLogMessages = [...allLogMessages, ...logs];
        batchCount++;
        
        // Update UI with progress
        setRetrievedLogs(allLogMessages);
        setLogPagination({
          nextToken: token,
          hasMore: more,
          isLoading: more // Only show as loading if we have more to fetch
        });
        
        if (!more) {
          // We've reached the end
          hasMoreLogs = false;
          break;
        }
        
        // Prepare for next iteration
        currentToken = token;
        
        // Optional: Add a small delay to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (err) {
        setError(`Failed to fetch log batch ${batchCount}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        console.error(err);
        hasMoreLogs = false;
        break;
      }
    }
    
    // All logs have been fetched, now process the import
    if (allLogMessages.length > 0) {
      const logData = allLogMessages.join('\n');
      
      // Set metadata
      setMetadata({
        _aws_region: region,
        _aws_profile: profile,
        _log_group_name: groupName,
        _log_stream_name: streamName,
        _src: `cloudwatch.${groupName}.${streamName}`,
        _total_logs: allLogMessages.length
      });
      
      // Sanitize group/stream names for use in filename
      const sanitizedGroupName = groupName.replace(/[^a-zA-Z0-9]/g, '-');
      const sanitizedStreamName = streamName.replace(/[^a-zA-Z0-9]/g, '-');
      
      const filename = `cw-${sanitizedGroupName}-${sanitizedStreamName}`;
      onCloudWatchLogSelect(logData, filename);
    } else {
      setError("No logs were retrieved");
    }
  };
  
  // Helper function that fetches a single batch and returns the results
  const fetchLogBatchInternal = async (groupName: string, streamName: string, nextToken: string | null): Promise<{ logs: string[], token: string | null, more: boolean }> => {
    try {
      // Get dates from the store
      const startTime = dateRangeStore.UTCTimeSince 
        ? new Date(dateRangeStore.UTCTimeSince).getTime() 
        : undefined;
      
      const endTime = dateRangeStore.UTCTimeTo 
        ? new Date(dateRangeStore.UTCTimeTo).getTime() 
        : undefined;
      
      const tokenParam = nextToken || undefined;
      
      console.log(`Fetching log batch for ${groupName}/${streamName} with token: ${tokenParam || 'initial'}`);
      
      const authData = {
        region,
        profile,
        log_group_name: groupName,
        log_stream_name: streamName,
        start_time: startTime,
        end_time: endTime,
        next_token: tokenParam,
        limit: 10000 // Maximum logs per batch
      };
      
      const response = await cloudwatchService.getLogEvents(authData);
      
      // Extract log messages
      const logMessages: string[] = response.log_events.map(event => event.message);
      
      return {
        logs: logMessages,
        token: response.next_token || null,
        more: response.has_more
      };
    } catch (err) {
      console.error(`Failed to fetch log batch: ${err}`);
      throw err;
    }
  };
  
  // Keep the original fetchLogBatch for the Load More button
  const fetchLogBatch = async (groupName: string, streamName: string, nextToken?: string) => {
    setLogPagination(prev => ({ ...prev, isLoading: true }));
    
    try {
      const { logs, token, more } = await fetchLogBatchInternal(groupName, streamName, nextToken || null);
      
      // Append to existing logs
      setRetrievedLogs(prev => [...prev, ...logs]);
      
      // Update pagination state
      setLogPagination({
        nextToken: token,
        hasMore: more,
        isLoading: false
      });
    } catch (err) {
      setError(`Failed to fetch log batch: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error(err);
    } finally {
      setLogPagination(prev => ({ ...prev, isLoading: false }));
    }
  };
  
  const handleLoadMoreLogs = async () => {
    if (!selectedStream || !logPagination.nextToken || !logPagination.hasMore) return;
    
    try {
      await fetchLogBatch(selectedStream.groupName, selectedStream.streamName, logPagination.nextToken);
    } catch (err) {
      setError(`Failed to fetch more logs: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error(err);
    }
  };

  useEffect(() => {
    // When search query changes, auto-expand groups that have matching streams
    if (searchQuery) {
      // Find groups that have streams matching the search query
      const groupsWithMatchingStreams = logGroups.filter(group => 
        group.streams && group.streams.some(stream => 
          stream.name.toLowerCase().includes(searchQuery.toLowerCase())
        )
      );
      
      // Auto-expand those groups
      groupsWithMatchingStreams.forEach(group => {
        if (!expandedGroups[group.name]) {
          toggleGroupExpanded(group.name);
        }
      });
    }
  }, [searchQuery, logGroups, expandedGroups, toggleGroupExpanded]);

  // Enhanced filtering to show groups with matching streams
  const filteredLogGroups = logGroups.filter(group => {
    if (!searchQuery) return true;
    
    const groupNameMatches = group.name.toLowerCase().includes(searchQuery.toLowerCase());
    
    // Check if any streams in this group match the search query
    const hasMatchingStreams = group.streams && group.streams.some(stream => 
      stream.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    
    return groupNameMatches || hasMatchingStreams;
  });

  // For each group, filter its streams based on the search query if needed
  const getFilteredStreams = (group) => {
    if (!searchQuery || !group.streams) return group.streams || [];
    
    return group.streams.filter(stream => 
      stream.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  };

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
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-md">
          <div className="flex items-start">
            <div className="flex-shrink-0 pt-0.5">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-red-500" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">AWS Connection Error</h3>
              <div className="mt-1 text-sm text-red-700 whitespace-pre-line">
                {error}
              </div>
              <div className="mt-2 text-xs text-red-600">
                <a 
                  href="https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="underline hover:text-red-800"
                >
                  Learn more about AWS CLI configuration
                </a>
              </div>
            </div>
          </div>
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
              {filteredLogGroups.map(group => (
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
                      <span className="ml-3 text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">
                        {(group.storedBytes / (1024 * 1024)).toFixed(2)} MB
                      </span>
                      <span className="ml-2 text-xs bg-gray-100 text-gray-800 px-2 py-0.5 rounded-full">
                        {group.streams ? group.streams.length : 0} streams
                      </span>
                    </div>
                    <div className="flex items-center space-x-4">
                      {group.retentionDays > 0 && (
                        <span className="text-xs text-gray-500">
                          Retention: {group.retentionDays} days
                        </span>
                      )}
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
                          {getFilteredStreams(group).map(stream => (
                            <div 
                              key={stream.name}
                              className="flex items-center px-4 py-2 border-t cursor-pointer hover:bg-gray-50"
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
                              <div className="flex-1">
                                <span className={`text-sm ${
                                  selectedStream && 
                                  selectedStream.groupName === group.name && 
                                  selectedStream.streamName === stream.name 
                                    ? 'text-blue-700 font-medium' 
                                    : ''
                                }`}>{stream.name}</span>
                                
                                <div className="flex flex-wrap text-xs text-gray-500 mt-1">
                                  {(stream.lastEventTime || stream.last_event_time) && (
                                    <span className="mr-3">
                                      Last event: {new Date(stream.lastEventTime || stream.last_event_time).toLocaleString()}
                                    </span>
                                  )}
                                  {(stream.storedBytes > 0 || stream.stored_bytes > 0) && (
                                    <span className="mr-3">
                                      Size: {((stream.storedBytes || stream.stored_bytes) / 1024).toFixed(2)} KB
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="py-3 px-4 text-gray-500 text-sm">
                          {searchQuery 
                            ? "No matching log streams found" 
                            : "No log streams found"}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              
              {/* Show message when no groups match search */}
              {filteredLogGroups.length === 0 && (
                <div className="p-4 text-center text-gray-500">
                  No log groups or streams found matching "{searchQuery}"
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
      
      {/* Show pagination UI if there are more logs available */}
      {selectedStream && logPagination.hasMore && (
        <div className="mt-4 flex justify-center">
          <Button 
            onClick={handleLoadMoreLogs}
            disabled={logPagination.isLoading}
            className="bg-blue-600 hover:bg-blue-700 h-10"
          >
            {logPagination.isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading more logs...
              </>
            ) : (
              <>
                Load More Logs ({retrievedLogs.length} loaded)
              </>
            )}
          </Button>
        </div>
      )}
      
      {/* Show log count if logs have been retrieved */}
      {retrievedLogs.length > 0 && (
        <div className="mt-4 text-center text-sm text-gray-500">
          {retrievedLogs.length} logs retrieved
          {logPagination.hasMore ? " (more available)" : " (complete)"}
        </div>
      )}
    </div>
  );
});

export default CloudWatchSelection; 