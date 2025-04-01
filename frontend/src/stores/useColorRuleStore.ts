import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Define a color rule
export interface ColorRule {
  id: string;
  field: string; // The log field to check (e.g., "level", "_src")
  operator: 'eq' | 'neq' | 'contains' | 'exists' | 'regex'; // Equal, not equal, contains, exists, or regex
  value: string; // The value to compare against
  color: string; // The background color to apply
  enabled: boolean; // Whether the rule is active
}

// Define the store state
export interface ColorRuleStoreState {
  // State
  colorRules: ColorRule[];
  
  // Actions
  addRule: (rule: Omit<ColorRule, 'id'>) => void;
  updateRule: (id: string, rule: Partial<ColorRule>) => void;
  deleteRule: (id: string) => void;
  toggleRule: (id: string) => void;
  moveRule: (fromIndex: number, toIndex: number) => void; // For reordering rules
  clearRules: () => void;
}

// Light color palette for rule options
export const LIGHT_COLORS = [
  { name: 'Blue', value: 'bg-blue-50' },
  { name: 'Green', value: 'bg-green-50' },
  { name: 'Yellow', value: 'bg-yellow-50' },
  { name: 'Red', value: 'bg-red-50' },
  { name: 'Purple', value: 'bg-purple-50' },
  { name: 'Pink', value: 'bg-pink-50' },
  { name: 'Indigo', value: 'bg-indigo-50' },
  { name: 'Slate', value: 'bg-slate-50' },
  { name: 'Gray', value: 'bg-gray-50' },
  { name: 'Amber', value: 'bg-amber-50' },
  { name: 'Lime', value: 'bg-lime-50' },
  { name: 'Emerald', value: 'bg-emerald-50' },
  { name: 'Teal', value: 'bg-teal-50' },
  { name: 'Cyan', value: 'bg-cyan-50' },
  { name: 'Sky', value: 'bg-sky-50' },
  { name: 'Violet', value: 'bg-violet-50' },
  { name: 'Fuchsia', value: 'bg-fuchsia-50' },
  { name: 'Rose', value: 'bg-rose-50' },
];

// Default color rules for common log analysis scenarios
const DEFAULT_COLOR_RULES: Omit<ColorRule, 'id'>[] = [
 
  // Common error patterns in message field
  { field: 'message', operator: 'contains', value: 'error', color: 'bg-red-100', enabled: true },
  { field: 'message', operator: 'contains', value: 'warning', color: 'bg-yellow-100', enabled: true },
  { field: 'error', operator: 'exists', value: '', color: 'bg-red-100', enabled: true },
  
];

// Create the store with persistence
export const useColorRuleStore = create<ColorRuleStoreState>()(
  persist(
    (set) => ({
      // Initial state
      colorRules: [],
      
      // Actions
      addRule: (rule) => set((state) => {
        const newRules = [
          ...state.colorRules,
          {
            ...rule,
            id: crypto.randomUUID(), // Generate a unique ID
          }
        ];
        return { colorRules: newRules };
      }),
      
      updateRule: (id, updatedRule) => set((state) => {
        const newRules = state.colorRules.map((rule) => 
          rule.id === id ? { ...rule, ...updatedRule } : rule
        );
        return { colorRules: newRules };
      }),
      
      deleteRule: (id) => set((state) => ({
        colorRules: state.colorRules.filter((rule) => rule.id !== id)
      })),
      
      toggleRule: (id) => set((state) => {
        const newRules = state.colorRules.map((rule) => 
          rule.id === id ? { ...rule, enabled: !rule.enabled } : rule
        );
        return { colorRules: newRules };
      }),
      
      moveRule: (fromIndex, toIndex) => set((state) => {
        const newRules = [...state.colorRules];
        const [removed] = newRules.splice(fromIndex, 1);
        newRules.splice(toIndex, 0, removed);
        return { colorRules: newRules };
      }),
      
      clearRules: () => set({ colorRules: [] }),
    }),
    {
      name: 'logsonic-color-rules', // name for localStorage
      storage: createJSONStorage(() => localStorage),
      // Added options to optimize store for immediate UI updates
      version: 1,
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            // If no rules exist, initialize with default rules
            if (state.colorRules.length === 0) {
              state.colorRules = DEFAULT_COLOR_RULES.map(rule => ({
                ...rule,
                id: crypto.randomUUID()
              }));
            }
          }
        };
      }
    }
  )
); 