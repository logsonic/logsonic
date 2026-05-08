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

  const navBtn = (disabled: boolean): React.CSSProperties => ({
    opacity: disabled ? 0.4 : 1,
    color: 'var(--ls-text-2)',
  });

  return (
    <div
      className="flex items-center justify-between px-3"
      style={{ gap: 8, fontSize: 11.5, color: 'var(--ls-text-3)', minHeight: 28 }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <span>
          Rows{' '}
          <b
            style={{
              color: 'var(--ls-text)',
              fontWeight: 500,
              fontFamily: 'var(--ls-font-mono)',
            }}
          >
            {store.resultCount > 0 ? startItem : 0}
            –
            {endItem}
          </b>{' '}
          of{' '}
          <b
            style={{
              color: 'var(--ls-text)',
              fontWeight: 500,
              fontFamily: 'var(--ls-font-mono)',
            }}
          >
            {store.resultCount.toLocaleString()}
          </b>
        </span>
        <span aria-hidden style={{ width: 1, height: 14, background: 'var(--ls-border)' }} />
        <div className="flex items-center" style={{ gap: 4 }}>
          <span>Show</span>
          <Select
            value={store.pageSize.toString()}
            onValueChange={handlePageSizeChange}
          >
            <SelectTrigger
              className="w-[64px]"
              style={{
                height: 22,
                padding: '0 6px',
                fontSize: 11,
                fontFamily: 'var(--ls-font-mono)',
                background: 'var(--ls-panel)',
                borderColor: 'var(--ls-border-strong)',
                color: 'var(--ls-text)',
              }}
            >
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

      <div className="flex items-center" style={{ gap: 2 }}>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          style={navBtn(store.currentPage === 1)}
          onClick={() => onPageChange(1)}
          disabled={store.currentPage === 1}
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          style={navBtn(store.currentPage === 1)}
          onClick={() => onPageChange(store.currentPage - 1)}
          disabled={store.currentPage === 1}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>

        <span
          className="mx-2"
          style={{ fontSize: 11.5, color: 'var(--ls-text-2)', fontVariantNumeric: 'tabular-nums' }}
        >
          Page{' '}
          <b style={{ color: 'var(--ls-text)', fontWeight: 500, fontFamily: 'var(--ls-font-mono)' }}>
            {store.currentPage}
          </b>{' '}
          of{' '}
          <b style={{ color: 'var(--ls-text)', fontWeight: 500, fontFamily: 'var(--ls-font-mono)' }}>
            {totalPages || 1}
          </b>
        </span>

        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          style={navBtn(store.currentPage >= totalPages)}
          onClick={() => onPageChange(store.currentPage + 1)}
          disabled={store.currentPage >= totalPages}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          style={navBtn(store.currentPage >= totalPages)}
          onClick={() => onPageChange(totalPages)}
          disabled={store.currentPage >= totalPages}
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
};

export default PaginationControls; 