import { DateTimeRangeButton } from "@/components/DateRangePicker/DateTimeRangeButton";
import { useCloudWatchStore } from '@/components/Import/CloudWatchImport/stores/useCloudWatchStore';
import { LogSourceProvider } from '@/components/Import/types';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useImportStore } from '@/stores/useImportStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { ChevronDown, Cloud, Loader2, Search } from "lucide-react";
import { FC, useEffect } from 'react';
import { useCloudWatchHooks } from './CloudWatchHooks';
import { useCloudWatchLogProviderService } from './CloudWatchLogProviderService';

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
export const CloudWatchLogProvider: FC<LogSourceProvider> = ({ 
  onFilePreview,
}) => {
  const { UTCTimeSince, UTCTimeTo} = useSearchQueryParamsStore();
  const { fetchLogGroups, fetchLogStreams } = useCloudWatchHooks();
  const cloudWatchLogService = useCloudWatchLogProviderService();
  
  // Use the CloudWatch store
  const {
    region, profile,
    logGroups, expandedGroups, loadingStreams, searchQuery, selectedStream,
    isLoading, error,
    setRegion, setProfile,
    toggleGroupExpanded,
     setSelectedStream, setSearchQuery,
    
    estimatedLogCount, setEstimatedLogCount
  } = useCloudWatchStore();

  const { setFilePreviewBuffer, setMetadata, setSelectedFileName } = useImportStore();
  
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

  const handleToggleGroupExpand = async (logGroupName: string) => {
    toggleGroupExpanded(logGroupName);
    
    // If expanding and no streams loaded yet, fetch them
    const isExpanding = !expandedGroups[logGroupName];
    if (isExpanding) {
      const groupData = logGroups.find(group => group.name === logGroupName);
      
      if (groupData && (!groupData.streams || groupData.streams.length === 0)) {
        await fetchLogStreams(logGroupName, UTCTimeSince, UTCTimeTo);
      }
    }
  };

  // This function triggers the preview of the selected stream
  const handleStreamSelect = async (groupName: string, streamName: string, streamSize: number) => {
    console.log("handleStreamSelect", groupName, streamName, streamSize);
    setSelectedStream(groupName, streamName, streamSize);

    setMetadata({ _src: `cloudwatch.${groupName}.${streamName}`, _log_group: groupName, _log_stream: streamName });
    setSelectedFileName(`${groupName}-${streamName}.log`);
    // Fetch the logs for the selected stream for preview
    cloudWatchLogService.handleFilePreview({groupName, streamName}, (logs) => {

    
      setEstimatedLogCount(0);

      console.log("estimatedLogCount", estimatedLogCount, 0);

      setFilePreviewBuffer({
        lines: logs,
        filename: `${groupName}-${streamName}.log`
      });
     
      onFilePreview(logs, `${groupName}-${streamName}.log`);
    

    });
  };

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
              
              <div className="w-1/5 flex-grow">
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Range</label>
                <div className="flex h-10 w-full ">
                  <DateTimeRangeButton />
                </div>
              </div>
              
              <div className="w-1/5">
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Range</label>
                <div className="text-sm text-gray-700 mb-1">
                  {UTCTimeSince.toISOString()} - {UTCTimeTo.toISOString()}
                </div>
              </div>


                <Button 
                  onClick={() => fetchLogGroups(UTCTimeSince, UTCTimeTo)}
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
                              onClick={() => handleStreamSelect(group.name, stream.name, stream.storedBytes)}
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
      

    </div>
  );
};

export default CloudWatchLogProvider; 