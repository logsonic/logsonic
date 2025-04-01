import { Timer } from "lucide-react";

interface PerformanceMetricsProps {
  apiExecutionTime: number | null;
}

export const PerformanceMetricsPopover = ({
  apiExecutionTime,
}: PerformanceMetricsProps) => {
  if (apiExecutionTime === null) return null;

  return (
    <>
      <span className="mx-1 text-gray-400">|</span>
      <span className="font-medium text-gray-700">Response Latency:</span>
      <span className="ml-1 text-xs bg-gray-100 border border-gray-200 text-gray-800 px-2 py-0.5 rounded">
        <Timer size={14} className="mr-1 text-gray-500 inline" />
        {`${Math.ceil(apiExecutionTime/1000)} ms`}
      </span>
    </>
  );
}; 