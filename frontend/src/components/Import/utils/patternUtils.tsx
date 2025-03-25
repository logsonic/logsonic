import { Pattern } from '../types';
import React from 'react';

/**
 * Extracts field names from a Grok pattern string
 */
export const extractFields = (pattern: string): string[] => {
  const fieldRegex = /%{[^:]+:([^}]+)}/g;
  const namedCaptures = pattern.match(fieldRegex) || [];
  
  return namedCaptures.map(capture => {
    const match = /%{[^:]+:([^}]+)}/.exec(capture);
    return match ? match[1] : '';
  })
  .filter(Boolean);
};

/**
 * Generates color classes for field highlighting
 */
export const getFieldColors = (fields: string[]): Record<string, string> => {
  const baseColors = [
    'bg-blue-100 text-blue-800',
    'bg-green-100 text-green-800',
    'bg-teal-100 text-teal-800',
    'bg-indigo-100 text-indigo-800',
    'bg-purple-100 text-purple-800',
    'bg-amber-100 text-amber-800',
    'bg-cyan-100 text-cyan-800',
    'bg-emerald-100 text-emerald-800',
    'bg-sky-100 text-sky-800',
    'bg-violet-100 text-violet-800',
  ];
  
  const colors: Record<string, string> = {};
  
  fields.forEach((field, index) => {
    colors[field] = baseColors[index % baseColors.length];
  });
  
  return colors;
};

/**
 * Creates a CSS class for a Grok pattern element
 */
export const getPatternElementClass = (elementType: 'pattern' | 'field' | 'separator' | 'braces'): string => {
  switch (elementType) {
    case 'pattern':
      return 'text-purple-600 font-semibold';
    case 'field':
      return 'text-green-600 font-semibold';
    case 'separator':
      return 'text-gray-500';
    case 'braces':
      return 'text-blue-600';
    default:
      return 'text-gray-700';
  }
};

/**
 * Highlights a log line with field colors
 */
export const highlightLogLine = (
  rawLine: string, 
  parsedFields: Record<string, string>
): React.ReactNode => {
  if (!rawLine || !parsedFields || Object.keys(parsedFields).length === 0) {
    return <span>{rawLine}</span>;
  }
  
  // Create a copy of parsedFields without the _raw and _src fields for display
  const displayFields = { ...parsedFields };
  delete displayFields._raw;
  delete displayFields._src;
  
  // If there are no fields left after removing _raw and _src, just show the raw line
  if (Object.keys(displayFields).length === 0) {
    return <span>{rawLine}</span>;
  }
  
  // Sort fields by their position in the raw line
  const sortedFields = Object.entries(displayFields)
    .map(([field, value]) => {
      const position = rawLine.indexOf(value);
      return { field, value, position };
    })
    .filter(item => item.position !== -1)
    .sort((a, b) => a.position - b.position);
  
  if (sortedFields.length === 0) {
    return <span>{rawLine}</span>;
  }
  
  const fieldColors = getFieldColors(sortedFields.map(f => f.field));
  const result: React.ReactNode[] = [];
  let lastPosition = 0;
  
  sortedFields.forEach(({ field, value, position }) => {
    // Add text before the field
    if (position > lastPosition) {
      result.push(
        <span key={`pre-${field}-${position}`} className="text-gray-500">
          {rawLine.substring(lastPosition, position)}
        </span>
      );
    }
    
    // Add the field with highlighting
    result.push(
      <span 
        key={`${field}-${position}`} 
        className={`px-1 rounded ${fieldColors[field] || 'bg-gray-100'}`}
        title={`${field}: ${value}`}
      >
        {value}
      </span>
    );
    
    lastPosition = position + value.length;
  });
  
  // Add remaining text
  if (lastPosition < rawLine.length) {
    result.push(
      <span key={`post-${lastPosition}`} className="text-gray-500">
        {rawLine.substring(lastPosition)}
      </span>
    );
  }
  
  return <>{result}</>;
};

/**
 * Highlights a Grok pattern with syntax coloring
 */
export const highlightGrokPattern = (pattern: string): React.ReactNode => {
  if (!pattern) return null;
  
  // Split the pattern into parts: %{PATTERN:field} and regular text
  const parts: React.ReactNode[] = [];
  const regex = /%{([^:}]+)(?::([^}]+))?}/g;
  let lastIndex = 0;
  let match;
  let matchIndex = 0;
  
  // Use regex to find all Grok pattern parts
  while ((match = regex.exec(pattern)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(
        <span key={`text-${lastIndex}`} className="text-gray-700">
          {pattern.substring(lastIndex, match.index)}
        </span>
      );
    }
    
    const patternName = match[1];
    const fieldName = match[2];
    
    // Add the pattern with highlighting
    parts.push(
      <span key={`pattern-${matchIndex}`} className="whitespace-nowrap">
        <span className="text-blue-600">%{`{`}</span>
        <span className="text-purple-600 font-medium">{patternName}</span>
        {fieldName && (
          <>
            <span className="text-gray-500">:</span>
            <span className="text-green-600 font-medium">
              {fieldName}
            </span>
          </>
        )}
        <span className="text-blue-600">{`}`}</span>
      </span>
    );
    
    lastIndex = match.index + match[0].length;
    matchIndex++;
  }
  
  // Add any remaining text
  if (lastIndex < pattern.length) {
    parts.push(
      <span key={`text-end`} className="text-gray-700">
        {pattern.substring(lastIndex)}
      </span>
    );
  }
  
  return <div className="font-mono text-sm overflow-x-auto">{parts}</div>;
}; 