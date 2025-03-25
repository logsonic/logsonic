import {
  GrokPatternRequest,
  GrokPatternResponse,
  IngestRequest,
  IngestFileRequest,
  IngestResponse,
  LogResponse,
  LogQueryParams,
  ParseRequest,
  ParseResponse,
  SuggestResponse,
  SystemInfoResponse,
  IngestSessionOptions
} from './api-types';

// API base configuration
const API_BASE_URL = (import.meta.env.DEV
  ? 'http://localhost:8080'
  : '') + '/api/v1';

// Helper function for API requests
async function apiRequest<T = unknown>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET',
  body?: any,
  params?: Record<string, string | number | boolean | undefined> | LogQueryParams
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
  
  // Parse and return response
  return await response.json() as T;
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

export async function ingestStart(request: IngestSessionOptions): Promise<IngestResponse> {
  return apiRequest<IngestResponse>('/ingest/start', 'POST', request);
}

export async function ingestEnd(sessionId?: string): Promise<IngestResponse> {
  const request = sessionId ? { session_id: sessionId } : {};
  return apiRequest<IngestResponse>('/ingest/end', 'POST', request);
}

export async function ingestLogs(request: IngestRequest): Promise<IngestResponse> {
  return apiRequest<IngestResponse>('/ingest/logs', 'POST', request);
}

export async function ingestFile(request: IngestFileRequest): Promise<IngestResponse> {
  return apiRequest<IngestResponse>('/ingestFile', 'POST', request);
}

// Log Querying
export async function getLogs(params?: LogQueryParams): Promise<LogResponse> {
  return apiRequest<LogResponse>('/logs', 'GET', undefined, params);
}

export async function clearLogs(): Promise<any> {
  return apiRequest<any>('/logs', 'DELETE');
}

// Log Parsing
export async function parseLogs(request: ParseRequest): Promise<ParseResponse> {
  return apiRequest<ParseResponse>('/parse', 'POST', request);
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