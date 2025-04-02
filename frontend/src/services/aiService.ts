import { AIQueryRequest, AIQueryResponse, AIStatusResponse, checkAIStatus as checkStatus, translateAIQuery } from '@/lib/api-client';

// Re-export the types and functions with slightly different names if needed
export type { AIQueryRequest, AIQueryResponse, AIStatusResponse };

// Check if Ollama and AI services are available
export const checkAIStatus = checkStatus;

// Translate natural language to Bleve query syntax
export const translateQuery = translateAIQuery; 