import { Button } from '@/components/ui/button';
import { useStream } from '@/hooks/useStream';
import { useStreamStore } from '@/stores/streamStore';
import { Radio, Square } from 'lucide-react';

export const StreamToggle = () => {
  const store = useStreamStore();
  useStream();

  return (
    <div className="flex items-center border border-slate-200 rounded-md overflow-hidden bg-white shadow-sm">
      <Button
        variant="ghost"
        className={`h-7 rounded-none px-2.5 flex items-center gap-1 ${
          store.isLive
            ? 'text-green-600 hover:text-green-700 hover:bg-green-50 border-r border-slate-200'
            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
        }`}
        onClick={store.toggle}
        title={store.isLive ? 'Stop live stream' : 'Start live stream'}
      >
        {store.isLive ? (
          <>
            <Square className="h-3.5 w-3.5 fill-green-600" />
            <span className="text-xs">Live</span>
          </>
        ) : (
          <>
            <Radio className="h-3.5 w-3.5" />
            <span className="text-xs">Live</span>
          </>
        )}
      </Button>

      {store.isLive && (
        <Button
          variant="ghost"
          className="h-7 rounded-none px-2.5 flex items-center gap-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100"
          onClick={store.isPaused ? store.resume : store.pause}
          title={store.isPaused ? 'Resume stream' : 'Pause stream'}
        >
          <span className="text-xs">{store.isPaused ? 'Resume' : 'Pause'}</span>
        </Button>
      )}
    </div>
  );
};
