import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
interface PaginationControlsProps {

  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
}

export const PaginationControls = ({
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
}: PaginationControlsProps) => {
  const store = useSearchQueryParamsStore();


  const startItem = (store.currentPage - 1) * store.pageSize + 1;
  const endItem = Math.min(store.currentPage * store.pageSize, store.resultCount);
  const totalPages = Math.ceil(store.resultCount / store.pageSize);

  const handlePageSizeChange = (value: string) => {
    const newPageSize = parseInt(value, 10);
    onPageSizeChange(newPageSize);
    
    // Adjust current page to keep the first visible item in view
    const firstItemIndex = (store.currentPage - 1) * store.pageSize;
    const newPage = Math.floor(firstItemIndex / newPageSize) + 1;
    onPageChange(newPage);
  };    

  return (
    <div className="flex items-center justify-between px-2 py-1">
      <div className="flex items-center space-x-2 text-sm text-muted-foreground">
        <span>
          Showing {store.resultCount > 0 ? startItem : 0}-{endItem} of {store.resultCount} entries
        </span>
        <div className="flex items-center space-x-1">
          <span>Show</span>
          <Select
            value={store.pageSize.toString()}
            onValueChange={handlePageSizeChange}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue placeholder={store.pageSize.toString()} />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={size.toString()}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>per page</span>
        </div>
      </div>

      <div className="flex items-center space-x-1">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(1)}
          disabled={store.currentPage === 1}
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(store.currentPage - 1)}
          disabled={store.currentPage === 1}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        
        <span className="text-sm mx-2">
          Page {store.currentPage} of {totalPages || 1}
        </span>
        
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(store.currentPage + 1)}
          disabled={store.currentPage >= totalPages}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(totalPages)}
          disabled={store.currentPage >= totalPages}
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export default PaginationControls; 