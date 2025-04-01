import { useCloudWatchStore } from '@/components/Import/CloudWatchImport/stores/useCloudWatchStore';
import { LogSourceProviderService } from "@/components/Import/types";
import { useImportStore } from "@/stores/useImportStore";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { cloudwatchService } from "./api/cloudwatchService";
import { GetLogEventsRequest } from "./types";

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

  const handleFileImport = async (
    _: object, 
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
      hasMore: true,
      isLoading: true
    });
    setRetrievedLogs([]);
    
    try {
      // Sanitize group/stream names for use in filename
      const sanitizedGroupName = selectedStream.groupName.replace(/[^a-zA-Z0-9]/g, '-');
      const sanitizedStreamName = selectedStream.streamName.replace(/[^a-zA-Z0-9]/g, '-');
     
      
      // Setup tracking variables
      let currentToken: string | null = null;
      let hasMoreLogs = true;
      let processedLogsCount = 0;
      let batchCount = 0;
      let allRetrievedLogs: string[] = [];
      
      // Set initial metadata with estimated count
      importStore.setMetadata({
        _aws_region: region,
        _aws_profile: profile,
        _log_group_name: sanitizedGroupName,
        _log_stream_name: sanitizedStreamName,
        _src: `cloudwatch.${sanitizedGroupName}.${sanitizedStreamName}`,
        _total_logs: 0 // Will be updated as we process
      });

      // Process logs in batches as they arrive
      while (hasMoreLogs) {
        try {
          const { logs, token, more } = await fetchLogBatchInternal(
            selectedStream.groupName, 
            selectedStream.streamName, 
            currentToken, 
            searchQueryParamsStore.UTCTimeSince, 
            searchQueryParamsStore.UTCTimeTo
          );
          
          if (logs.length === 0 && !more) {
            if (batchCount === 0) {
              setError("No logs were found in the specified time range");
            }
            break;
          }

          // Update tracking
          batchCount++;
          allRetrievedLogs = [...allRetrievedLogs, ...logs];
          processedLogsCount += logs.length;
          
          // Update UI with progress
          setRetrievedLogs(allRetrievedLogs);
          setLogPagination({
            nextToken: token,
            hasMore: more,
            isLoading: more
          });
          
          
          // Process this batch through the callback immediately
          // Break into smaller chunks if needed for processing
          const processingChunkSize = Math.min(chunkSize, 10000);
          for (let i = 0; i < logs.length; i += processingChunkSize) {
            const processingChunk = logs.slice(i, i + processingChunkSize);
            await callback(
              processingChunk, 
              processedLogsCount, // Total logs processed so far
              () => {} // Next function is not needed as we're controlling the flow
            );
          }
          
          // Check if we're done
          if (!more) {
            hasMoreLogs = false;
            break;
          }
          
          // Prepare for next iteration
          currentToken = token;
          
          // Small delay to avoid overwhelming the API
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (err) {
          setError(`Failed to fetch log batch ${batchCount}: ${err instanceof Error ? err.message : 'Unknown error'}`);
          console.error(err);
          hasMoreLogs = false;
          break;
        }
      }

      // Final update for UI
      if (processedLogsCount === 0) {
        setError("No logs were retrieved");
      }
      
    } catch (err) {
      setError(`Failed to fetch log events: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error(err);
    } finally {
      setLoading(false);
      // Ensure pagination shows we're done
      setLogPagination({
        nextToken: null,
        isLoading: false,
        hasMore: false
      });
    }
  };

  const handleFilePreview = async ({groupName, streamName}: {groupName: string, streamName: string},
    onPreviewReadyCallback: (lines: string[]) => void
  ) => {
    // Fetch 100 lines of logs for the selected stream
    try {
      setLoading(true);
      setError(null);
      
      
      const { logs } = await fetchLogBatchInternal(
        groupName, 
        streamName, 
        null, 
        searchQueryParamsStore.UTCTimeSince, 
        searchQueryParamsStore.UTCTimeTo,
        100
      );
      
      if (logs.length === 0) {
        setError("No logs found in the specified time range");
      }
      
      onPreviewReadyCallback(logs.slice(0, 100));
    } catch (err) {
      setError(`Failed to fetch log preview: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error(err);
      onPreviewReadyCallback([]);
    } finally {
      setLoading(false);
    }
  };

  return {
    name: "CloudWatch",
    handleFileImport,
    handleFilePreview,
  };
};
