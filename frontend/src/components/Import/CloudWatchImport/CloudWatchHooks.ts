import { useCloudWatchStore } from './stores/useCloudWatchStore';
import { cloudwatchService } from './api/cloudwatchService';

export const useCloudWatchHooks = () => {
  const store = useCloudWatchStore();
  
  const fetchLogGroups = async (startTime: Date, endTime: Date) => {
    store.setError(null);
    store.setLoading(true);
    
    try {
      const authData = {
        region: store.region,
        profile: store.profile
      };
      
      const response = await cloudwatchService.listLogGroups(authData);
      store.setLogGroups(response.log_groups || []);

      // Fetch streams for all log groups in parallel
      const streamPromises = (response.log_groups || []).map(async (group) => {
        try {
          const request = {
            region: store.region,
            profile: store.profile,
            log_group_name: group.name,
            start_time: startTime.getTime(),
            end_time: endTime.getTime()
          };
          
          const streamResponse = await cloudwatchService.listLogStreams(request);
          store.setStreamsForGroup(group.name, streamResponse.log_streams || []);
        } catch (error) {
          console.error(`Error fetching streams for group ${group.name}:`, error);
          // Don't throw here, we want to continue with other groups even if one fails
        }
      });

      // Wait for all stream fetches to complete
      await Promise.all(streamPromises);
    } catch (error) {
      console.error('Error fetching log groups:', error);
      store.setError(error.message || 'Failed to fetch log groups');
    } finally {
      store.setLoading(false);
    }
  };
  
  const fetchLogStreams = async (logGroupName: string, startTime: Date, endTime: Date) => {
    store.setLoadingStreams(logGroupName, true);
    
    try {
      const request = {
        region: store.region,
        profile: store.profile,
        log_group_name: logGroupName,
        start_time: startTime.getTime(),
        end_time: endTime.getTime()
      };
      
      const response = await cloudwatchService.listLogStreams(request);
      store.setStreamsForGroup(logGroupName, response.log_streams || []);
    } catch (error) {
      console.error(`Error fetching streams for group ${logGroupName}:`, error);
      store.setError(`Failed to fetch streams for ${logGroupName}: ${error.message}`);
    } finally {
      store.setLoadingStreams(logGroupName, false);
    }
  };
  
  return {
    fetchLogGroups,
    fetchLogStreams
  };
};
