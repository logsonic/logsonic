import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchQueryParamsStore } from '@/stores/useSearchParams';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { LogResponse } from '@/lib/api-types';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  Legend, 
  ResponsiveContainer, 
  ReferenceArea
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, X, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { cn } from '@/lib/utils';
import { useRef as useRefReact } from 'react';

// Define a color palette for sources
const SOURCE_COLORS = [
  ['#2563eb', '#1d4ed8'], // blue
  ['#16a34a', '#15803d'], // green
  ['#9333ea', '#7e22ce'], // purple
  ['#ea580c', '#c2410c'], // orange
  ['#0891b2', '#0e7490'], // cyan
  ['#4f46e5', '#4338ca'], // indigo
  ['#be123c', '#9f1239'], // rose
  ['#854d0e', '#713f12'], // amber
  ['#dc2626', '#b91c1c'], // red
  ['#059669', '#047857'], // emerald
  ['#7c3aed', '#6d28d9'], // violet
  ['#0284c7', '#0369a1'], // sky
  ['#db2777', '#be185d'], // pink
];

// Custom tooltip component for the chart
const CustomTooltip = ({ active, payload, label }: any) => {
  // Get timezone from the store
  const { timeZone } = useSearchQueryParamsStore();
  
  if (active && payload && payload.length) {
    try {
      const startDate = parseISO(label);
      const endDate = payload[0]?.payload?.end_time ? parseISO(payload[0].payload.end_time) : new Date(startDate.getTime() + 60000);
      
      // Format using the selected timezone
      const formattedStartDate = formatInTimeZone(startDate, timeZone, 'MMM dd, yyyy HH:mm:ss');
      const formattedEndDate = formatInTimeZone(endDate, timeZone, 'MMM dd, yyyy HH:mm:ss');
      
      return (
        <div className="bg-white p-3 border border-slate-200 shadow-md rounded-md">
          <p className="text-xs font-medium text-slate-600">
            <span className="font-bold">Start: </span> {formattedStartDate} {formatInTimeZone(startDate, timeZone, 'z')}
          </p>
          <p className="text-xs font-medium text-slate-600">
            <span className="font-bold">End: </span> {formattedEndDate} {formatInTimeZone(endDate, timeZone, 'z')}
          </p>
          <div className="mt-2">
            {payload.map((entry: any, index: number) => (
              <p 
                key={`tooltip-${index}`} 
                className="text-xs" 
                style={{ color: entry.color }}
              >
                <span className="font-medium">{entry.name}: </span>
                <span>{entry.value}</span>
              </p>
            ))}
            <p className="text-xs font-medium mt-1 text-slate-600">
              Total: {payload.reduce((sum: number, entry: any) => sum + entry.value, 0)}
            </p>
          </div>
        </div>
      );
    } catch (error) {
      return null;
    }
  }
  return null;
};

// Function to generate a stable color index for a source
// Uses a simple hash of the string to ensure same source always gets same color
function getColorIndexForSource(source: string): number {
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) - hash) + source.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  // Make sure hash is positive and map to available colors
  return Math.abs(hash) % SOURCE_COLORS.length;
}

export default function LogDistributionChart() {
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<any[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [sources, setSources] = useState<string[]>([]);
  
  // Selection state for zoom
  const [refAreaLeft, setRefAreaLeft] = useState<string | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<string | null>(null);
  
  const searchStore = useSearchQueryParamsStore();
  const { logData, isLoading } = useLogResultStore();

  // Ref to the chart container
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // Effect to disable dragging on the chart container
  useEffect(() => {
    const chartContainer = chartContainerRef.current;
    if (!chartContainer) return;

    const preventDrag = (e: Event) => {
      e.preventDefault();
    };

    const preventSelection = (e: MouseEvent) => {
      if (refAreaLeft) {
        // Prevent text selection during area selection
        e.preventDefault();
      }
    };

    // Touch event handlers for mobile
    const handleTouchStart = (e: TouchEvent) => {
      // We can't directly get chart labels from DOM events
      // But we can prevent default behaviors
      e.preventDefault();
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (refAreaLeft) {
        e.preventDefault();
      }
    };

    // Add all event listeners
    chartContainer.addEventListener('dragstart', preventDrag);
    chartContainer.addEventListener('selectstart', preventDrag);
    chartContainer.addEventListener('mousedown', preventSelection);
    chartContainer.addEventListener('touchstart', handleTouchStart, { passive: false });
    chartContainer.addEventListener('touchmove', handleTouchMove, { passive: false });
    
    return () => {
      // Clean up listeners on unmount
      chartContainer.removeEventListener('dragstart', preventDrag);
      chartContainer.removeEventListener('selectstart', preventDrag);
      chartContainer.removeEventListener('mousedown', preventSelection);
      chartContainer.removeEventListener('touchstart', handleTouchStart);
      chartContainer.removeEventListener('touchmove', handleTouchMove);
    };
  }, [refAreaLeft]);

  // Extract unique sources from log_distribution data
  useEffect(() => {
    if (logData?.log_distribution) {
      const uniqueSources = new Set<string>();
      
      logData.log_distribution.forEach(entry => {
        if (entry.source_counts) {
          Object.keys(entry.source_counts).forEach(source => {
            // Skip empty or "unknown" sources
            if (source && source !== "unknown" && source.trim() !== "") {
              uniqueSources.add(source);
            }
          });
        }
      });
      
      setSources(Array.from(uniqueSources));
    }
  }, [logData?.log_distribution]);

  // Create a stable source-to-color mapping for the current data
  const sourceColorMap = useMemo(() => {
    const map = new Map<string, number>();
    
    sources.forEach(source => {
      map.set(source, getColorIndexForSource(source));
    });
    
    return map;
  }, [sources]);
  
  // Transform API data for chart display
  const transformData = (data: LogResponse | null) => {
    if (!data?.log_distribution) {
      setChartData([]);
      return;
    }
    
    const transformed = data.log_distribution.map((entry, index) => {
      const item: any = {
        time: entry.start_time,
        total: 0 // Will recalculate based on filtered sources
      };
      
      // Set the end_time if available or calculate from next bucket
      if (entry.end_time) {
        item.end_time = entry.end_time;
      } else if (index < data.log_distribution.length - 1) {
        // Use next bucket's start time as this bucket's end time
        item.end_time = data.log_distribution[index + 1].start_time;
      } else {
        // For the last bucket, estimate using previous buckets' interval or add one minute
        const prevEntry = index > 0 ? data.log_distribution[index - 1] : null;
        if (prevEntry && prevEntry.start_time) {
          const prevTime = new Date(prevEntry.start_time).getTime();
          const currTime = new Date(entry.start_time).getTime();
          const interval = currTime - prevTime;
          const estimatedEndTime = new Date(currTime + interval);
          item.end_time = estimatedEndTime.toISOString();
        } else {
          // Fallback: add 1 minute
          const startTime = new Date(entry.start_time);
          const estimatedEndTime = new Date(startTime.getTime() + 60000);
          item.end_time = estimatedEndTime.toISOString();
        }
      }
      
      // Add each source's count, but only for selected sources
      if (entry.source_counts) {
        Object.entries(entry.source_counts).forEach(([source, count]) => {
          // If no sources are selected or this source is selected, include it
          const shouldIncludeSource = searchStore.sources.length === 0 || 
                                      searchStore.sources.includes(source);
          
          if (shouldIncludeSource) {
            item[source] = count;
            item.total += count;
          }
        });
      }
      
      return item;
    });
    
    setChartData(transformed);
  };
  
  // Update chart when log data or selected sources change
  useEffect(() => {
    transformData(logData);
  }, [logData, searchStore.sources]);
  
  // Time range selection functions
  const handleMouseDown = (e: any) => {
    if (!e || !e.activeLabel) return;
    
    // Prevent chart dragging behavior
    if (e.nativeEvent) {
      e.nativeEvent.stopPropagation();
      e.nativeEvent.preventDefault();
    }
    
    setRefAreaLeft(e.activeLabel);
  };
  
  const handleMouseMove = (e: any) => {
    if (!e || !refAreaLeft || !e.activeLabel) return;
    
    // Prevent chart dragging behavior
    if (e.nativeEvent) {
      e.nativeEvent.stopPropagation();
    }
    
    setRefAreaRight(e.activeLabel);
  };
  
  const handleMouseUp = () => {
    if (!refAreaLeft) {
      return;
    }
    
    // If no right reference area is set (simple click without drag), 
    // use the left reference as both start and end
    const effectiveRefAreaRight = refAreaRight || refAreaLeft;
    
    try {
      // Find indices for the selected area (support both left-to-right and right-to-left selection)
      const leftIndex = chartData.findIndex(item => item.time === refAreaLeft);
      const rightIndex = chartData.findIndex(item => item.time === effectiveRefAreaRight);
      
      if (leftIndex === -1 || rightIndex === -1) {
        console.error("Could not find time points in chart data");
        setRefAreaLeft(null);
        setRefAreaRight(null);
        return;
      }
      
      // Ensure we have start and end indices regardless of selection direction
      let startIndex = Math.min(leftIndex, rightIndex);
      let endIndex = Math.max(leftIndex, rightIndex);
      
      // Make sure we have valid indices
      if (startIndex < 0 || endIndex < 0 || startIndex >= chartData.length || endIndex >= chartData.length) {
        console.error("Invalid selection indices:", startIndex, endIndex);
        setRefAreaLeft(null);
        setRefAreaRight(null);
        return;
      }
      
      // Get the time points for the selection
      let startTime, endTime;
      
      if (logData?.log_distribution && logData.log_distribution.length > 0) {
        // Use the actual start time of the first bucket and end time of the last bucket
        const startBucket = logData.log_distribution[startIndex];
        const endBucket = logData.log_distribution[endIndex];
        
        if (!startBucket.start_time) {
          console.error("Missing start_time in bucket", startBucket);
          setRefAreaLeft(null);
          setRefAreaRight(null);
          return;
        }
        
        startTime = parseISO(startBucket.start_time);
        
        // For single-bucket selection or the end bucket, use its end_time
        // If end_time is not available, estimate it based on the next bucket's start time or add a small interval
        if (endBucket.end_time) {
          endTime = parseISO(endBucket.end_time);
        } else if (endIndex < logData.log_distribution.length - 1) {
          // Use next bucket's start time as this bucket's end time
          endTime = parseISO(logData.log_distribution[endIndex + 1].start_time || "");
        } else {
          // For the last bucket, add a small interval (e.g., assume equal bucket sizes)
          const prevBucket = logData.log_distribution[endIndex - 1];
          if (prevBucket && prevBucket.start_time && endBucket.start_time) {
            const prevTime = parseISO(prevBucket.start_time);
            const currTime = parseISO(endBucket.start_time);
            const interval = currTime.getTime() - prevTime.getTime();
            endTime = new Date(currTime.getTime() + interval);
          } else {
            // Fallback: add 1 minute to the start time
            endTime = new Date(startTime.getTime() + 60000);
          }
        }
      } else {
        // Fallback to the chart data points
        startTime = parseISO(chartData[startIndex].time);
        endTime = parseISO(chartData[endIndex].time);
        
        // For single bucket selection, add some buffer
        if (startIndex === endIndex) {
          // If this is a single bucket selection, add a small buffer
          endTime = new Date(endTime.getTime() + 60000); // Add 1 minute
        } else if (endIndex < chartData.length - 1) {
          // Use next bucket's start as this bucket's end
          endTime = parseISO(chartData[endIndex + 1].time);
        } else {
          // For the last bucket, estimate using previous buckets' interval
          const prevTime = parseISO(chartData[endIndex - 1].time);
          const currTime = parseISO(chartData[endIndex].time);
          const interval = currTime.getTime() - prevTime.getTime();
          endTime = new Date(currTime.getTime() + interval);
        }
      }
      
      if (!startTime || !endTime || isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        console.error("Invalid time values:", startTime, endTime);
        setRefAreaLeft(null);
        setRefAreaRight(null);
        return;
      }
      
      // Update search store time range with the bucket boundaries
      searchStore.setUTCTimeSinceMs(startTime.getTime());
      searchStore.setUTCTimeSince(startTime);
      searchStore.setUTCTimeToMs(endTime.getTime());
      searchStore.setUTCTimeTo(endTime);
      searchStore.setIsRelative(false);
      
      // Trigger a search to update the log results
      searchStore.triggerSearch();
      
    } catch (err) {
      console.error('Error processing time selection:', err);
    } finally {
      // Always clear selection
      setRefAreaLeft(null);
      setRefAreaRight(null);
    }
  };
  
  // Format large numbers to K, M, B for Y-axis
  const formatYAxisTick = (value: number) => {
    if (value >= 1000000000) {
      return `${(value / 1000000000).toFixed(1)}B`;
    }
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(1)}M`;
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}K`;
    }
    return value.toString();
  };
  
  if (!isVisible) {
    return (
      <div className="flex justify-end p-2 mt-[-40px]">
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={() => setIsVisible(true)} 
          className="text-xs text-slate-500"
        >
          Show Chart
        </Button>
      </div>
    );
  }
  
  return (
    <div className="bg-white">
      <div className="flex justify-between items-center px-3 py-1">
        <div className="flex items-center">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setIsCollapsed(!isCollapsed)} 
            className="mr-2 h-7 w-7 p-0"
          >
            {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </Button>
          <h3 className="text-sm font-medium">Log Distribution</h3>
          {isLoading && <Loader2 className="ml-2 h-4 w-4 animate-spin text-slate-500" />}
        </div>
        <div className="flex items-center space-x-1">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => searchStore.triggerSearch()}
            className="h-7 w-7 p-0"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </Button>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setIsVisible(false)} 
            className="h-7 w-7 p-0"
            title="Hide Chart"
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      
      {!isCollapsed && (
        <div className={cn("px-3 transition-all duration-300", isLoading ? "opacity-70" : "")}>
          {error ? (
            <div className="py-3 text-center text-sm text-red-500">{error}</div>
          ) : chartData.length === 0 ? (
            <div className="py-3 text-center text-sm text-slate-500">
              {isLoading ? 'Loading chart data...' : 'No data available'}
            </div>
          ) : (
            <div 
              className="pb-3 pt-1" 
              style={{ 
                height: '140px',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                MozUserSelect: 'none',
                msUserSelect: 'none',
                touchAction: 'none'
              }} 
              ref={chartContainerRef}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 5, right: 5, left: 15, bottom: 5 }}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                >
                  <XAxis 
                    dataKey="time" 
                    tick={false} 
                    height={15} 
                    tickLine={false}
                    allowDecimals={false}
                    scale="auto"
                  />
                  <YAxis 
                    tick={{ fontSize: 10 }} 
                    tickLine={false}
                    axisLine={false}
                    width={25}
                    tickFormatter={formatYAxisTick}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend 
                    wrapperStyle={{ fontSize: '10px', bottom: 0 }} 
                    iconSize={8} 
                    iconType="circle"
                  />
                  
                  {/* Generate bars for each source */}
                  {sources.map((source) => {
                    // Get consistent color index for this source
                    const colorIndex = sourceColorMap.get(source) || 0;
                    
                    return (
                      <Bar
                        key={source}
                        dataKey={source}
                        name={source}
                        stackId="a"
                        fill={`url(#color-${source})`}
                        fillOpacity={0.8}
                      />
                    );
                  })}
                  
                  {/* Reference area for selection */}
                  {refAreaLeft && refAreaRight && (
                    <ReferenceArea
                      x1={refAreaLeft}
                      x2={refAreaRight}
                      strokeOpacity={0.3}
                      fill="#2563eb"
                      fillOpacity={0.3}
                    />
                  )}
                  
                  {/* Gradients for each source */}
                  <defs>
                    {sources.map((source) => {
                      // Get consistent color index for this source
                      const colorIndex = sourceColorMap.get(source) || 0;
                      const colors = SOURCE_COLORS[colorIndex];
                      
                      // Use source as part of the ID to ensure unique gradients
                      return (
                        <linearGradient 
                          key={`color-${source}`}
                          id={`color-${source}`}
                          x1="0" y1="0" 
                          x2="0" y2="1"
                        >
                          <stop 
                            offset="5%" 
                            stopColor={colors[0]} 
                            stopOpacity={0.9}
                          />
                          <stop 
                            offset="95%" 
                            stopColor={colors[1]} 
                            stopOpacity={0.7}
                          />
                        </linearGradient>
                      );
                    })}
                  </defs>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
}