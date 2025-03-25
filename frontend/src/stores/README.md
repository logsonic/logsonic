# LogSonic Store Components

This directory contains Zustand store components for state management in the LogSonic application.

## Available Stores

### useLogResultStore

A store for managing log search results. This store is not persisted and is used to share log data between components.

```typescript
import { useLogResultStore } from '@/stores/useLogResultStore';

// Access the store
const logData = useLogResultStore(state => state.logData);
const setLogData = useLogResultStore(state => state.setLogData);
```

### useSearchQueryParamsStore

A store for managing search query parameters. This store is persisted to localStorage to remember user search preferences.

```typescript
import { useSearchQueryParamsStore } from '@/stores/useSearchParams';

// Access the store
const searchQuery = useSearchQueryParamsStore(state => state.searchQuery);
const setSearchQuery = useSearchQueryParamsStore(state => state.setSearchQuery);
```

### useImportStore

A store for managing the import functionality. This store handles the state for file uploads, pattern detection, and ingest session options.

```typescript
import { useImportStore } from '@/stores/useImportStore';

// Access the store
const selectedFile = useImportStore(state => state.selectedFile);
const setSelectedFile = useImportStore(state => state.setSelectedFile);
```

For a more convenient way to use the ImportStore, use the `useImport` hook:

```typescript
import { useImport } from '@/hooks/useImport';

// Use the hook
const {
  selectedFile,
  filePreview,
  selectedPattern,
  handleFileSelect,
  generateFilePreview,
  detectPattern,
  handleUpload
} = useImport();
```

## Store Design Patterns

All stores follow these common patterns:

1. **State and Actions**: Each store contains both state and actions to modify that state.
2. **Immutability**: State is updated immutably using the Zustand `set` function.
3. **Persistence (optional)**: Some stores use the `persist` middleware to save state to localStorage.
4. **Selective Persistence**: Only necessary parts of the state are persisted to avoid issues with non-serializable data.

## ImportStore Details

The ImportStore manages the following state:

- **Upload Step Tracking**: Tracks the current step in the import process (file selection, analysis, confirmation).
- **File Data**: Stores the selected file and file preview information.
- **Pattern Data**: Manages available patterns, selected pattern, and custom patterns.
- **Detection Results**: Stores the results of pattern detection and suggestion.
- **Upload Status**: Tracks upload progress and status.
- **Ingest Session Options**: Stores user preferences for ingestion.
- **Error Handling**: Manages error state during the import process.

The store is designed to work with the `useImport` hook, which provides additional functionality for file handling, pattern detection, and the upload process. 