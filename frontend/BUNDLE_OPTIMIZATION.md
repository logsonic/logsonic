# Bundle Size Optimization Guide

This guide provides instructions on how to optimize the bundle size of your React application.

## Available Tools

We've set up several tools to help you analyze and optimize your bundle size:

### 1. Bundle Analyzer

The bundle analyzer provides a visual representation of your bundle size, showing which dependencies are taking up the most space.

```bash
npm run analyze
```

This will build your application and open a visualization of your bundle in your browser.

### 2. Import Analyzer

The import analyzer scans your codebase for problematic import patterns that could hinder tree shaking.

```bash
npm run analyze:imports
```

This will output:
- A list of namespace imports (`import * as X from 'y'`) that should be converted to named imports
- A list of potentially large imports from known heavy packages
- Recommendations for optimization

### 3. Import Fixer

The import fixer helps you automatically optimize imports in your codebase:

```bash
# Show suggested changes without applying them
npm run fix:imports

# Apply the changes automatically
npm run fix:imports:apply
```

This tool will:
1. Convert namespace imports to named imports based on common patterns
2. Identify and remove unused imports that are never referenced in the code
3. Clean up import statements by removing unnecessary imports

## Best Practices for Tree Shaking

### 1. Use Named Imports

Always use named imports instead of namespace imports:

```typescript
// ❌ Avoid namespace imports
import * as React from 'react';
import * as RadixUI from '@radix-ui/react-tooltip';

// ✅ Use named imports
import { useState, useEffect } from 'react';
import { Provider, Root, Trigger } from '@radix-ui/react-tooltip';
```

### 2. Only Import What You Need

Import only the specific components or functions you actually use:

```typescript
// ❌ Avoid importing everything
import { Button, Card, Dialog, Tooltip, Avatar, Badge } from '@/components/ui';

// ✅ Import only what you need
import { Button, Card } from '@/components/ui';
```

### 3. Use the UI Component Index

Import UI components from the central index file:

```typescript
// ❌ Avoid importing from individual files
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

// ✅ Import from the index file
import { Button, Tooltip } from '@/components/ui';
```

### 4. Lazy Load Components

Use React.lazy() for components that aren't needed immediately:

```typescript
// ❌ Avoid eager imports for large components
import LargeComponent from './LargeComponent';

// ✅ Use lazy loading
const LargeComponent = React.lazy(() => import('./LargeComponent'));
```

### 5. Split Vendor Chunks

Our Vite configuration already splits vendor chunks, but you can add more in `vite.config.ts`:

```typescript
manualChunks: {
  'react-vendor': ['react', 'react-dom'],
  'ui-vendor': ['@radix-ui/react-tooltip', '@radix-ui/react-dialog'],
  // Add more chunks as needed
}
```

### 6. Optimize Icon Libraries

For icon libraries like Lucide React, import only the icons you need:

```typescript
// ❌ Avoid importing the entire library
import { Icons } from 'lucide-react';

// ✅ Import only what you need
import { Home, Settings, User } from 'lucide-react';
```

### 7. Optimize Radix UI Components

For Radix UI components, import only the specific components you need:

```typescript
// ❌ Avoid
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

// ✅ Better
import { Provider, Root, Trigger, Content } from '@radix-ui/react-tooltip';
```

## ESLint Rules

We've added ESLint rules to help enforce best practices:

- `import/no-duplicates`: Warns about duplicate imports
- `import/no-namespace`: Warns about namespace imports
- `import/first`: Ensures imports are at the top of the file
- `import/newline-after-import`: Ensures there's a newline after imports

Run the linter to check for issues:

```bash
npm run lint
```

## Further Reading

- [Vite Build Optimization](https://vitejs.dev/guide/build.html)
- [React Code Splitting](https://reactjs.org/docs/code-splitting.html)
- [Tree Shaking in JavaScript](https://developer.mozilla.org/en-US/docs/Glossary/Tree_shaking) 