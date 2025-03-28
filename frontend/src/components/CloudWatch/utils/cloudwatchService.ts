import {
  CloudWatchAuth,
  GetLogEventsRequest,
  GetLogEventsResponse,
  ListLogGroupsRequest,
  ListLogGroupsResponse,
  ListLogStreamsRequest,
  ListLogStreamsResponse,
} from '../types';

import {
  listCloudWatchLogGroups,
  listCloudWatchLogStreams,
  getCloudWatchLogEvents
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