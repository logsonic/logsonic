import React, { useState, useEffect } from 'react';
import { CloudWatchAuth, CloudWatchLogGroup, CloudWatchLogStream } from '@/lib/api-types';
import { cloudwatchService } from './utils/cloudwatchService';
import { DateRangePicker } from '../DateRangePicker/DateRangePicker';
import { useSearchQueryParamsStore } from '@/stores/useSearchParams';
import { useCloudWatchStore } from '@/stores/useCloudWatchStore';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Cloud, CloudOff, ChevronRight, ChevronDown, Search, Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

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

const CloudWatchImport: React.FC<Props> = ({ open, onClose }) => {
  const dateRangeStore = useSearchQueryParamsStore();
  const [showDatePicker, setShowDatePicker] = useState<boolean>(false);
  
  // Use the CloudWatch store instead of local state
  const {
    authMethod, region, profile, accessKeyId, secretAccessKey,
    logGroups, expandedGroups, loadingStreams, searchQuery, selectedStream,
    isLoading, error,
    
    setAuthMethod, setRegion, setProfile, setAccessKeys,
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

  const handleAuthChange = (field: keyof CloudWatchAuth, value: string) => {
    switch (field) {
      case 'region':
        setRegion(value);
        break;
      case 'profile':
        setProfile(value);
        break;
      case 'accessKeyId':
        setAccessKeys(value, secretAccessKey);
        break;
      case 'secretAccessKey':
        setAccessKeys(accessKeyId, value);
        break;
    }
  };

  const fetchLogGroups = async () => {
    setError(null);
    setLoading(true);
    
    try {
      const authData: CloudWatchAuth = {
        region,
      };

      if (authMethod === 'profile') {
        authData.profile = profile;
      } else {
        authData.accessKeyId = accessKeyId;
        authData.secretAccessKey = secretAccessKey;
      }

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
        profile: authMethod === 'profile' ? profile : undefined,
        accessKeyId: authMethod === 'keys' ? accessKeyId : undefined,
        secretAccessKey: authMethod === 'keys' ? secretAccessKey : undefined,
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

  const handleImport = () => {
    if (!selectedStream) {
      setError("Please select a log stream to import");
      return;
    }
    
    console.log('Log stream selected for import:', selectedStream);
    console.log('Time range:', {
      startTime: dateRangeStore.UTCTimeSince,
      endTime: dateRangeStore.UTCTimeTo
    });
    
    // Here we would normally implement the actual import logic
    // But as per requirements, we are only implementing the UI
    
    onClose();
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
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Import CloudWatch Logs</DialogTitle>
          <DialogDescription>
            Import logs from AWS CloudWatch. Select a log stream and time range.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 my-4 overflow-y-auto">
          {/* AWS Authentication */}
          <Card>
            <CardContent className="pt-6">
              <h3 className="text-sm font-medium mb-2">AWS Authentication</h3>
              <Tabs value={authMethod} onValueChange={(value) => setAuthMethod(value as 'profile' | 'keys')} className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-4">
                  <TabsTrigger value="profile">Profile</TabsTrigger>
                  <TabsTrigger value="keys">Access Keys</TabsTrigger>
                </TabsList>

                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium mb-1 block">Region</label>
                    <Select value={region || ''} onValueChange={(value) => handleAuthChange('region', value)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select Region" />
                      </SelectTrigger>
                      <SelectContent>
                        {DEFAULT_REGIONS.map((r) => (
                          <SelectItem key={r} value={r}>{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <TabsContent value="profile">
                    <div>
                      <label className="text-sm font-medium mb-1 block">AWS Profile</label>
                      <Input 
                        placeholder="default" 
                        value={profile || ''} 
                        onChange={(e) => handleAuthChange('profile', e.target.value)} 
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="keys">
                    <div className="space-y-3">
                      <div>
                        <label className="text-sm font-medium mb-1 block">Access Key ID</label>
                        <Input 
                          value={accessKeyId || ''} 
                          onChange={(e) => handleAuthChange('accessKeyId', e.target.value)} 
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-1 block">Secret Access Key</label>
                        <Input 
                          type="password" 
                          value={secretAccessKey || ''} 
                          onChange={(e) => handleAuthChange('secretAccessKey', e.target.value)} 
                        />
                      </div>
                    </div>
                  </TabsContent>
                </div>

                <Button 
                  onClick={fetchLogGroups}
                  disabled={isLoading || (!profile && authMethod === 'profile') || 
                          (authMethod === 'keys' && (!accessKeyId || !secretAccessKey))}
                  className="mt-4"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Fetching...
                    </>
                  ) : 'Fetch Log Groups'}
                </Button>
              </Tabs>
            </CardContent>
          </Card>

          {/* Error Message */}
          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
              <CloudOff className="h-4 w-4 inline-block mr-2" />
              {error}
            </div>
          )}

          {/* Time Range */}
          <Card>
            <CardContent className="pt-6">
              <h3 className="text-sm font-medium mb-2">Time Range</h3>
              
              {showDatePicker ? (
                <div className="relative z-10">
                  <DateRangePicker 
                    onApply={handleDateRangeClose} 
                    initialActiveTab={dateRangeStore.isRelative ? "relative" : "absolute"}
                  />
                </div>
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground mb-2">
                    Selected range: {new Date(dateRangeStore.UTCTimeSince).toLocaleString()} - {new Date(dateRangeStore.UTCTimeTo).toLocaleString()}
                  </p>
                  <Button variant="outline" onClick={() => setShowDatePicker(true)}>
                    Change Time Range
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Log Groups and Streams Selection */}
          {logGroups.length > 0 && (
            <Card>
              <CardContent className="pt-6">
                <h3 className="text-sm font-medium mb-2">
                  Select a Log Stream ({logGroups.length} log groups available)
                </h3>
                
                <div className="relative mb-3">
                  <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                  <Input
                    placeholder="Search log groups and streams..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-8"
                  />
                </div>
                
                <div className="border rounded-md max-h-[300px] overflow-y-auto">
                  {filteredLogGroups.length === 0 ? (
                    <div className="p-4 text-sm text-gray-500 text-center">
                      No log groups or streams match your search
                    </div>
                  ) : (
                    filteredLogGroups.map((log) => (
                      <div key={log.name} className="border-b last:border-b-0">
                        {/* Log Group Row */}
                        <div 
                          className="flex items-center space-x-2 p-2 hover:bg-gray-50 cursor-pointer"
                        >
                          <div 
                            className="p-1 cursor-pointer"
                            onClick={() => handleToggleGroupExpand(log.name)}
                          >
                            {expandedGroups[log.name] ? (
                              <ChevronDown className="h-4 w-4 text-gray-500" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-gray-500" />
                            )}
                          </div>
                          <label 
                            className="text-sm font-medium cursor-pointer flex-1"
                            onClick={() => handleToggleGroupExpand(log.name)}
                          >
                            {log.name}
                          </label>
                        </div>
                        
                        {/* Log Streams */}
                        {expandedGroups[log.name] && (
                          <div className="pl-8 border-t bg-gray-50">
                            {loadingStreams[log.name] ? (
                              <div className="p-3 text-sm text-gray-500 flex items-center">
                                <Loader2 className="animate-spin h-4 w-4 mr-2" />
                                Loading streams...
                              </div>
                            ) : log.streams && log.streams.length > 0 ? (
                              log.streams
                                .filter(stream => !searchQuery || stream.name.toLowerCase().includes(searchQuery.toLowerCase()))
                                .map(stream => (
                                  <div 
                                    key={stream.name}
                                    className="flex items-center space-x-2 p-2 hover:bg-gray-100 cursor-pointer"
                                    onClick={() => handleStreamSelect(log.name, stream.name)}
                                  >
                                    <input 
                                      type="radio" 
                                      name="streamSelection"
                                      checked={selectedStream?.groupName === log.name && selectedStream?.streamName === stream.name}
                                      onChange={() => handleStreamSelect(log.name, stream.name)}
                                      className="h-4 w-4"
                                    />
                                    <span className="text-sm">{stream.name}</span>
                                  </div>
                                ))
                            ) : (
                              <div className="p-3 text-sm text-gray-500">
                                No streams found
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
                
                {selectedStream && (
                  <div className="mt-2 text-sm text-blue-600">
                    Selected: <span className="font-medium">{selectedStream.streamName}</span> from <span className="font-medium">{selectedStream.groupName}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button 
            onClick={handleImport} 
            disabled={!selectedStream}
          >
            <Cloud className="mr-2 h-4 w-4" />
            Import Selected Stream
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CloudWatchImport; 