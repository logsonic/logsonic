import {
  GrokPatternRequest,
  GrokPatternResponse,
  IngestFileRequest,
  IngestRequest,
  IngestResponse,
  IngestSessionOptions,
  LiveControlResponse,
  LogQueryParams,
  LogResponse,
  ParseRequest,
  ParseResponse,
  SuggestResponse,
  SystemInfoResponse,
  TimestampPreviewRequest,
  TimestampPreviewResponse,
  Workspace,
  WorkspaceListResponse,
  WorkspaceResponse,
} from './api-types';

// API base configuration
// For local development, use port 8080
// For production, use relative URL
export const API_BASE_URL = (import.meta.env.DEV
  ? (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080')
  : '') + '/api/v1';

export const liveEventsURL = () => `${API_BASE_URL}/live/events`;

// Helper function for API requests
async function apiRequest<T = unknown>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET',
  body?: any,
  params?: Record<string, string | number | boolean | undefined> | LogQueryParams,
  signal?: AbortSignal,
): Promise<T> {
  // Build URL with query parameters if provided
  let url = `${API_BASE_URL}${endpoint}`;
  
  if (params) {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.append(key, String(value));
      }
    });
    
    const queryString = queryParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }
  
  // Configure request options
  const options: RequestInit = {
    method,
    signal,
    headers: {
      'Content-Type': 'application/json',
    },
  };
  
  // Add request body for non-GET requests
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  
  // Make the request
  const response = await fetch(url, options);
  
  // Handle errors
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    const errorMessage = errorData?.detail || errorData?.error || `API request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }
  
  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

// API Functions

// Grok Pattern Management
export async function createGrokPattern(request: GrokPatternRequest): Promise<GrokPatternResponse> {
  return apiRequest<GrokPatternResponse>('/grok', 'POST', request);
}

export async function getGrokPatterns(): Promise<GrokPatternResponse> {
  return apiRequest<GrokPatternResponse>('/grok', 'GET');
}

export async function saveGrokPattern(request: GrokPatternRequest): Promise<GrokPatternResponse> {
  return apiRequest<GrokPatternResponse>('/grok', 'POST', request);
}

// Update an existing pattern in place (matched by name). The backend
// requires the pattern to already exist and overwrites its body.
export async function updateGrokPattern(request: GrokPatternRequest): Promise<GrokPatternResponse> {
  return apiRequest<GrokPatternResponse>('/grok', 'PUT', request);
}

// Delete a saved pattern by name (DELETE /grok?name=<name>).
export async function deleteGrokPattern(name: string): Promise<GrokPatternResponse> {
  return apiRequest<GrokPatternResponse>('/grok', 'DELETE', undefined, { name });
}

export async function ingestStart(request: IngestSessionOptions, signal?: AbortSignal): Promise<IngestResponse> {
  return apiRequest<IngestResponse>('/ingest/start', 'POST', request, undefined, signal);
}

export async function ingestEnd(sessionId?: string, signal?: AbortSignal): Promise<IngestResponse> {
  const request = sessionId ? { session_id: sessionId } : {};
  return apiRequest<IngestResponse>('/ingest/end', 'POST', request, undefined, signal);
}

export async function ingestLogs(request: IngestRequest, signal?: AbortSignal): Promise<IngestResponse> {
  return apiRequest<IngestResponse>('/ingest/logs', 'POST', request, undefined, signal);
}

export async function ingestFile(request: IngestFileRequest): Promise<IngestResponse> {
  return apiRequest<IngestResponse>('/ingestFile', 'POST', request);
}

export async function pauseLiveSubscriber(subscriberId: string): Promise<LiveControlResponse> {
  return apiRequest<LiveControlResponse>(`/live/subscribers/${encodeURIComponent(subscriberId)}/pause`, 'POST', {});
}

export async function resumeLiveSubscriber(subscriberId: string): Promise<LiveControlResponse> {
  return apiRequest<LiveControlResponse>(`/live/subscribers/${encodeURIComponent(subscriberId)}/resume`, 'POST', {});
}

// Log Querying
export async function getLogs(params?: LogQueryParams): Promise<LogResponse> {
  return apiRequest<LogResponse>('/logs', 'GET', undefined, params);
}

export async function clearLogs(): Promise<any> {
  return apiRequest<any>('/logs', 'DELETE');
}

// Saved Workspaces
export async function listWorkspaces(): Promise<WorkspaceListResponse> {
  return apiRequest<WorkspaceListResponse>('/workspaces', 'GET');
}

export async function createWorkspace(workspace: Workspace): Promise<WorkspaceResponse> {
  return apiRequest<WorkspaceResponse>('/workspaces', 'POST', workspace);
}

export async function getWorkspace(id: string): Promise<WorkspaceResponse> {
  return apiRequest<WorkspaceResponse>(`/workspaces/${encodeURIComponent(id)}`, 'GET');
}

export async function updateWorkspace(id: string, workspace: Workspace): Promise<WorkspaceResponse> {
  return apiRequest<WorkspaceResponse>(`/workspaces/${encodeURIComponent(id)}`, 'PUT', workspace);
}

export async function deleteWorkspace(id: string): Promise<void> {
  await apiRequest<unknown>(`/workspaces/${encodeURIComponent(id)}`, 'DELETE');
}

export async function duplicateWorkspace(id: string): Promise<WorkspaceResponse> {
  return apiRequest<WorkspaceResponse>(`/workspaces/${encodeURIComponent(id)}/duplicate`, 'POST', {});
}

// Log Parsing
export async function parseLogs(request: ParseRequest): Promise<ParseResponse> {
  return apiRequest<ParseResponse>('/parse', 'POST', request);
}

// Live timestamp re-preview for the import wizard's knob panel.
export async function previewTimestamps(request: TimestampPreviewRequest): Promise<TimestampPreviewResponse> {
  return apiRequest<TimestampPreviewResponse>('/timestamp/preview', 'POST', request);
}

// Pattern Suggestion
export async function suggestPatterns(request: ParseRequest): Promise<SuggestResponse> {
  // Create a new object without the grok_pattern to trigger the suggestion behavior
  const requestWithoutPattern = { ...request };
  delete requestWithoutPattern.grok_pattern;
  return apiRequest<SuggestResponse>('/parse', 'POST', requestWithoutPattern);
}

// Tokenizer Management
export async function loadTokenizerPattern(request: GrokPatternRequest): Promise<GrokPatternResponse> {
  return apiRequest<GrokPatternResponse>('/tokenizer/load', 'PUT', request);
}

export async function clearTokenizer(): Promise<GrokPatternResponse> {
  return apiRequest<GrokPatternResponse>('/tokenizer/clear', 'PATCH');
}

// System Information
export async function getSystemInfo(refresh?: boolean): Promise<SystemInfoResponse> {
  return apiRequest<SystemInfoResponse>('/info', 'GET', undefined, { refresh });
}

// Ping check
export interface PingResponse {
  status: string;
}

export async function pingServer(): Promise<PingResponse> {
  return apiRequest<PingResponse>('/ping', 'GET');
}

// Delete logs by document IDs
export async function deleteLogsById(ids: string[]): Promise<any> {
  return apiRequest<any>('/logs/ids', 'DELETE', { ids });
}
