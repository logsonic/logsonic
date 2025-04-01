import { pingServer } from '@/lib/api-client';
import { useEffect, useState } from 'react';

/**
 * Hook to periodically check backend connectivity
 * @param intervalMs - Interval in milliseconds between checks (default: 3000ms)
 * @returns Object containing the current backend status
 */
export function useBackendStatus(intervalMs = 3000) {
  const [isConnected, setIsConnected] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  useEffect(() => {
    // Initial check
    checkBackendStatus();
    
    // Set up interval for periodic checks
    const intervalId = setInterval(checkBackendStatus, intervalMs);
    
    // Cleanup function
    return () => {
      clearInterval(intervalId);
    };
    
    async function checkBackendStatus() {
      try {
        const response = await pingServer();
        setIsConnected(response.status === 'pong');
      } catch (error) {
        setIsConnected(false);
      }
      setLastChecked(new Date());
    }
  }, [intervalMs]);

  return {
    isConnected,
    lastChecked
  };
} 