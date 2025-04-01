import { useCallback, type ReactNode } from 'react';

// Utility types for Bleve search query parsing
export interface SearchToken {
  type: 'term' | 'phrase' | 'regex';
  value: string;
  field?: string;
  required?: boolean;
  excluded?: boolean;
}

/**
 * Hook for parsing Bleve search syntax
 * @returns Utilities for parsing and highlighting search queries
 */
export const useSearchParser = () => {
  /**
   * Parse Bleve search syntax to extract searchable tokens
   * Handles terms, phrases, field scoping, required/excluded modifiers, and numeric values
   */
  const parseSearchQuery = useCallback((query: string): SearchToken[] => {
    if (!query) return [];
    
    const tokens: SearchToken[] = [];
    
    // Regular expression to match different parts of a Bleve query
    // Handles terms, phrases, field scoping, required/excluded modifiers, numeric values, and ranges
    const tokenRegex = /([+-])?(?:([a-zA-Z0-9_]+):)?(?:"([^"]+)"|\/([^/]+)\/|((?:[<>]=?|=)\s*\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][+-]?\d+)?)|([^\s+-:]+))/g;
    
    let match;
    while ((match = tokenRegex.exec(query)) !== null) {
      const [_, modifier, field, phrase, regex, range, number, term] = match;
      
      if (phrase) {
        tokens.push({
          type: 'phrase',
          value: phrase,
          field: field,
          required: modifier === '+',
          excluded: modifier === '-'
        });
      } else if (regex) {
        tokens.push({
          type: 'regex',
          value: regex,
          field: field,
          required: modifier === '+',
          excluded: modifier === '-'
        });
      } else if (range) {
        tokens.push({
          type: 'term',
          value: range,
          field: field,
          required: modifier === '+',
          excluded: modifier === '-'
        });
      } else if (number) {
        tokens.push({
          type: 'term',
          value: number,
          field: field,
          required: modifier === '+',
          excluded: modifier === '-'
        });
      } else if (term) {
        tokens.push({
          type: 'term',
          value: term,
          field: field,
          required: modifier === '+',
          excluded: modifier === '-'
        });
      }
    }
    
    return tokens;
  }, []);

  /**
   * Create a highlighter function that can highlight text based on search tokens
   * @param searchTokens - The parsed search tokens
   * @returns A function that highlights text based on the tokens
   */
  const createHighlighter = useCallback((searchTokens: SearchToken[]) => {
    // The returned function highlights text based on the provided search tokens
    return (text: string, fieldName: string = ''): ReactNode => {
      if (!text || !searchTokens.length) return text;
      
      // Skip highlighting for excluded terms
      const relevantTokens = searchTokens.filter(token => {
        // If token specifies a field, only use it for that field
        if (token.field && token.field !== fieldName) return false;
        // Skip excluded terms for highlighting
        if (token.excluded) return false;
        return true;
      });
      
      if (!relevantTokens.length) return text;
      
      // For simple implementation, split by each token and join with highlighted spans
      const textLower = text.toLowerCase();
      const matches: { index: number; length: number }[] = [];
      
      // Find all matches for all tokens
      relevantTokens.forEach(token => {
        const searchValue = token.value.toLowerCase();
        
        if (token.type === 'regex') {
          try {
            const regex = new RegExp(searchValue, 'gi');
            let match;
            while ((match = regex.exec(text)) !== null) {
              matches.push({ index: match.index, length: match[0].length });
            }
          } catch (e) {
            // Ignore invalid regex
          }
        } else {
          let startIndex = 0;
          let index;
          
          while ((index = textLower.indexOf(searchValue, startIndex)) !== -1) {
            matches.push({ index, length: searchValue.length });
            startIndex = index + searchValue.length;
          }
        }
      });
      
      // Sort matches by index
      matches.sort((a, b) => a.index - b.index);
      
      // Merge overlapping matches
      const mergedMatches: { index: number; length: number }[] = [];
      for (const match of matches) {
        const lastMatch = mergedMatches[mergedMatches.length - 1];
        
        if (lastMatch && match.index <= lastMatch.index + lastMatch.length) {
          // Extend the last match if this one overlaps with it
          lastMatch.length = Math.max(
            lastMatch.length,
            match.index + match.length - lastMatch.index
          );
        } else {
          mergedMatches.push({ ...match });
        }
      }
      
      // No matches found
      if (!mergedMatches.length) return text;
      
      // Build the result with highlighted spans
      const result: ReactNode[] = [];
      let lastIndex = 0;
      
      mergedMatches.forEach((match, i) => {
        // Add text before the match
        if (match.index > lastIndex) {
          result.push(text.substring(lastIndex, match.index));
        }
        
        // Add the highlighted match
        result.push(
          <span 
            key={`highlight-${i}`} 
            className="bg-yellow-300 text-black"
          >
            {text.substring(match.index, match.index + match.length)}
          </span>
        );
        
        lastIndex = match.index + match.length;
      });
      
      // Add any remaining text
      if (lastIndex < text.length) {
        result.push(text.substring(lastIndex));
      }
      
      return result;
    };
  }, []);

  return {
    parseSearchQuery,
    createHighlighter
  };
}; 