import { LogSourceProviderService } from "@/components/Import/types";
import { useCloudWatchStore } from "./stores/useCloudWatchStore";
import { GetLogEventsRequest, LogPaginationState } from "./types";
import { useState } from "react";
import { useImportStore } from "@/stores/useImportStore";
import { cloudwatchService } from "./api/cloudwatchService";
import { useSearchQueryParamsStore } from "@/stores/useSearchParams";

export const useCloudWatchLogProviderService = () : LogSourceProviderService => {
  const { region, profile, selectedStream, setError, setRetrievedLogs, setLogPagination, setLoading } = useCloudWatchStore();
  const importStore = useImportStore();
  const searchQueryParamsStore = useSearchQueryParamsStore();
  
  const fetchLogBatchInternal = async (
    groupName: string, 
    streamName: string, 
    nextToken: string | null, 
    startTime: Date, 
    endTime: Date,
    batchSize: number = 10000
  ): Promise<{ logs: string[], token: string | null, more: boolean }> => {
    try {
      const tokenParam = nextToken || undefined;
      console.log(`Fetching log batch for ${groupName}/${streamName} with token: ${tokenParam || 'initial'}`);
      
      const authData: GetLogEventsRequest = {
        region: region,
        profile: profile,
        log_group_name: groupName,
        log_stream_name: streamName,
        start_time: startTime.getTime(),
        end_time: endTime.getTime(),
        next_token: tokenParam,
        limit: batchSize // Maximum logs per batch
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

  const fetchAllLogs = async (groupName: string, streamName: string) => {
    let currentToken: string | null = null;
    let hasMoreLogs = true;
    let allLogMessages: string[] = [];
    let batchCount = 0;
    
    setError(null);

    while (hasMoreLogs) {
      try {
        const { logs, token, more } = await fetchLogBatchInternal(
          groupName, 
          streamName, 
          currentToken, 
          searchQueryParamsStore.UTCTimeSince, 
          searchQueryParamsStore.UTCTimeTo
        );
        
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
      // Set metadata
      importStore.setMetadata({
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
      
      // Return the logs and filename
      return { logs: allLogMessages, filename };
    } else {
      setError("No logs were retrieved");
      return { logs: [], filename: "" };
    }
  };

  const handleFileImport = async (
    filehandle: object, 
    chunkSize: number, 
    callback: (lines: string[], totalLines: number, next: () => void) => Promise<void>
  ) => {
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
      // Start fetching the logs
      const { logs, filename } = await fetchAllLogs(
        selectedStream.groupName, 
        selectedStream.streamName
      );
      
      // If there are logs, process them through the callback
      if (logs.length > 0) {
        await callback(logs, logs.length, () => {});
      }
    } catch (err) {
      setError(`Failed to fetch log events: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleFilePreview = async (
    filehandle: object, 
    onPreviewReadyCallback: (lines: string[]) => void
  ) => {
    // Fetch 100 lines of logs for the selected stream
    if (!selectedStream) return;

    const { logs} = await fetchLogBatchInternal(
      selectedStream.groupName, 
      selectedStream.streamName, 
      null, 
      searchQueryParamsStore.UTCTimeSince, 
      searchQueryParamsStore.UTCTimeTo,
      100
    );


    onPreviewReadyCallback(logs.slice(0, 100));
  };

  return {
    name: "CloudWatch",
    handleFileImport,
    handleFilePreview,
  };
};
