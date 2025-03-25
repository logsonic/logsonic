#!/usr/bin/env node

/**
 * This script analyzes your codebase to find potentially problematic import patterns
 * that could hinder tree shaking.
 * Run with: node scripts/analyze-imports.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.resolve(rootDir, 'src');

// Track problematic imports
const namespaceImports = [];
const potentiallyLargeImports = [];

// List of known large packages
const knownLargePackages = [
  'recharts',
  'lucide-react',
  '@radix-ui/react-',
  'react-window',
  'react-virtualized',
  'date-fns',
  'embla-carousel',
  'react-day-picker',
  'react-hook-form',
  'zod',
  '@dnd-kit',
  'cmdk',
];

// Regular expressions for finding imports
const namespaceImportRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
const namedImportRegex = /import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;
const defaultImportRegex = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

/**
 * Process a file to find problematic imports
 */
function processFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const extension = path.extname(filePath);
  
  if (!['.js', '.jsx', '.ts', '.tsx'].includes(extension)) {
    return;
  }
  
  // Find namespace imports
  let match;
  while ((match = namespaceImportRegex.exec(content)) !== null) {
    const [fullMatch, importName, packageName] = match;
    namespaceImports.push({
      file: path.relative(rootDir, filePath),
      line: getLineNumber(content, match.index),
      import: importName,
      package: packageName,
    });
  }
  
  // Find potentially large imports
  const allImports = [];
  
  // Check named imports
  while ((match = namedImportRegex.exec(content)) !== null) {
    const [fullMatch, importNames, packageName] = match;
    allImports.push({ packageName, importType: 'named', count: importNames.split(',').length });
  }
  
  // Check default imports
  while ((match = defaultImportRegex.exec(content)) !== null) {
    const [fullMatch, importName, packageName] = match;
    allImports.push({ packageName, importType: 'default', count: 1 });
  }
  
  // Check if any imports are from known large packages
  for (const imp of allImports) {
    for (const largePkg of knownLargePackages) {
      if (imp.packageName.includes(largePkg)) {
        potentiallyLargeImports.push({
          file: path.relative(rootDir, filePath),
          package: imp.packageName,
          type: imp.importType,
          count: imp.count,
        });
        break;
      }
    }
  }
}

/**
 * Get line number from content and position
 */
function getLineNumber(content, position) {
  const lines = content.slice(0, position).split('\n');
  return lines.length;
}

/**
 * Walk directory recursively to find all files
 */
function walkDir(dir) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory() && !file.startsWith('node_modules')) {
      walkDir(filePath);
    } else if (stat.isFile()) {
      processFile(filePath);
    }
  }
}

// Main execution
console.log('Analyzing imports for tree shaking optimization...');
console.log('This may take a minute...\n');

try {
  walkDir(srcDir);
  
  // Report namespace imports
  if (namespaceImports.length > 0) {
    console.log('\x1b[33mNamespace Imports Found:\x1b[0m');
    console.log('========================\n');
    
    for (const imp of namespaceImports) {
      console.log(`\x1b[33m${imp.import}\x1b[0m from '${imp.package}'`);
      console.log(`  in ${imp.file} (line ${imp.line})\n`);
    }
    
    console.log('\x1b[33mRecommendation:\x1b[0m Replace namespace imports with named imports for better tree shaking.\n');
  } else {
    console.log('\x1b[32mNo namespace imports found! 🎉\x1b[0m\n');
  }
  
  // Report potentially large imports
  if (potentiallyLargeImports.length > 0) {
    console.log('\x1b[33mPotentially Large Imports Found:\x1b[0m');
    console.log('==============================\n');
    
    // Group by package
    const groupedImports = {};
    for (const imp of potentiallyLargeImports) {
      if (!groupedImports[imp.package]) {
        groupedImports[imp.package] = [];
      }
      groupedImports[imp.package].push(imp);
    }
    
    for (const [pkg, imports] of Object.entries(groupedImports)) {
      console.log(`\x1b[33m${pkg}\x1b[0m (${imports.length} occurrences)`);
      console.log(`  in ${imports.map(i => i.file).slice(0, 3).join(', ')}${imports.length > 3 ? ` and ${imports.length - 3} more files` : ''}\n`);
    }
    
    console.log('\x1b[33mRecommendations:\x1b[0m');
    console.log('1. Use React.lazy() for components with large dependencies');
    console.log('2. Import only specific icons from lucide-react');
    console.log('3. Consider code-splitting for routes with heavy dependencies');
  } else {
    console.log('\x1b[32mNo potentially large imports found! 🎉\x1b[0m\n');
  }
  
  console.log('\nFor more detailed bundle analysis, run:');
  console.log('npm run analyze');
} catch (error) {
  console.error('Error analyzing imports:', error);
} 