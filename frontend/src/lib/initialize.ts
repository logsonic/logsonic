import { useSystemInfoStore } from '@/stores/useSystemInfoStore';

/**
 * Initializes the system information store by fetching the latest data
 * This function can be called during application startup
 */
export const initializeSystemInfo = async (): Promise<void> => {
  try {
    await useSystemInfoStore.getState().refreshSystemInfo();
  } catch (error) {
    console.error('Failed to initialize system information', error);
  }
};

/**
 * Initialize all application data and stores
 * This should be called once during application startup
 */
export const initializeApplication = async (): Promise<void> => {
  // Initialize system info
  await initializeSystemInfo();
  
  // Add more initialization functions here as needed
}; 