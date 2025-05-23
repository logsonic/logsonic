import {
  CloudWatchAuth,
  GetLogEventsRequest,
  GetLogEventsResponse,
  ListLogGroupsResponse,
  ListLogStreamsRequest,
  ListLogStreamsResponse
} from '../types';

import {
  getCloudWatchLogEvents,
  listCloudWatchLogGroups,
  listCloudWatchLogStreams
} from '@/lib/api-client';

export const cloudwatchService = {
  async listLogGroups(auth: CloudWatchAuth): Promise<ListLogGroupsResponse> {
    return listCloudWatchLogGroups(auth);
  },

  async listLogStreams(request: ListLogStreamsRequest): Promise<ListLogStreamsResponse> {
    return listCloudWatchLogStreams(request);
  },

  async getLogEvents(request: GetLogEventsRequest): Promise<GetLogEventsResponse> {
    return getCloudWatchLogEvents(request);
  },
}; 