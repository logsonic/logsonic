import { Skeleton } from '@/components/ui/skeleton';

/**
 * LogViewer Skeleton component for loading state
 */
export const LogViewerSkeleton = ({ columns = 5, rows = 10 }: { columns?: number; rows?: number }) => {
  return (
    <div className="w-full">
      <div className="flex space-x-4 mb-4">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-32" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex space-x-4 mb-4">
          {Array.from({ length: columns }).map((_, j) => (
            <Skeleton key={j} className="h-6 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}; 