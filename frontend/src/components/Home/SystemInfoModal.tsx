import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getSystemInfo } from '@/lib/api-client';
import { formatBytes } from '@/lib/utils';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';
import React, { useEffect } from 'react';
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface SystemInfoModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SystemInfoModal: React.FC<SystemInfoModalProps> = ({ open, onOpenChange }) => {
  const { systemInfo, setSystemInfo, setError, setLoading, isLoading, error } = useSystemInfoStore();

  useEffect(() => {
    if (open) {
      // Only fetch system info if it's not already loaded
      if (!systemInfo) {
        fetchSystemInfo();
      }
    }
  }, [open, systemInfo]);

  const fetchSystemInfo = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getSystemInfo(true);
      setSystemInfo(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch system information');
    } finally {
      setLoading(false);
    }
  };

  // Prepare memory usage data for pie chart
  const getMemoryChartData = () => {
    if (!systemInfo) return [];

    const { alloc_bytes, sys_bytes } = systemInfo.system_info.memory_usage;
    const free_bytes = sys_bytes - alloc_bytes;

    return [
      { name: 'Allocated', value: alloc_bytes },
      { name: 'Free', value: free_bytes },
    ];
  };

  // Prepare log entries data for bar chart
  const getLogDistributionData = () => {
    if (!systemInfo) return [];

    return systemInfo.storage_info.available_dates.map(date => ({
      date,
      logs: systemInfo.storage_info.total_log_entries / systemInfo.storage_info.available_dates.length, // Approximation
    }));
  };

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042'];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">System Information</DialogTitle>
          <DialogDescription>
            Detailed information about the log storage and system resources
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-[200px] w-full" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Skeleton className="h-[150px] w-full" />
              <Skeleton className="h-[150px] w-full" />
            </div>
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 text-red-600 rounded-md">
            {error}
          </div>
        ) : systemInfo && (
          <Tabs defaultValue="overview" className="w-full">
            <TabsList className="grid grid-cols-3 mb-4">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="storage">Storage</TabsTrigger>
              <TabsTrigger value="system">System</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Total Log Entries</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {systemInfo.storage_info.total_log_entries.toLocaleString()}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Storage Size</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatBytes(systemInfo.storage_info.storage_size_bytes)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Available Dates</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {systemInfo.storage_info.available_dates.length}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Memory Usage</CardTitle>
                </CardHeader>
                <CardContent className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={getMemoryChartData()}
                        cx="50%"
                        cy="50%"
                        labelLine={false}
                        label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                        outerRadius={100}
                        fill="#8884d8"
                        dataKey="value"
                      >
                        {getMemoryChartData().map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatBytes(value as number)} />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="storage" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Storage Information</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <h4 className="text-sm font-medium mb-1">Storage Directory</h4>
                        <p className="text-sm font-mono bg-gray-100 p-2 rounded">
                          {systemInfo.storage_info.storage_directory}
                        </p>
                      </div>
                      <div>
                        <h4 className="text-sm font-medium mb-1">Total Indices</h4>
                        <p className="text-2xl font-bold">
                          {systemInfo.storage_info.total_indices}
                        </p>
                      </div>
                    </div>

                    <div>
                      <h4 className="text-sm font-medium mb-2">Available Dates</h4>
                      <div className="flex flex-wrap gap-2">
                        {systemInfo.storage_info.available_dates.map(date => (
                          <Badge key={date}>{date}</Badge>
                        ))}
                      </div>
                    </div>

                    <div>
                      <h4 className="text-sm font-medium mb-2">Log Distribution</h4>
                      <div className="h-[200px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={getLogDistributionData()}>
                            <XAxis dataKey="date" />
                            <YAxis />
                            <Tooltip formatter={(value) => [value, 'Logs']} />
                            <Bar dataKey="logs" fill="#8884d8" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

            </TabsContent>

            <TabsContent value="system" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle>System Details</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">Hostname:</div>
                        <div>{systemInfo.system_info.hostname}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">OS Type:</div>
                        <div>{systemInfo.system_info.os_type}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">Architecture:</div>
                        <div>{systemInfo.system_info.architecture}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">Go Version:</div>
                        <div>{systemInfo.system_info.go_version}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">CPU Cores:</div>
                        <div>{systemInfo.system_info.num_cpu}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Memory Usage</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">Allocated:</div>
                        <div>{formatBytes(systemInfo.system_info.memory_usage.alloc_bytes)}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">Total Allocated:</div>
                        <div>{formatBytes(systemInfo.system_info.memory_usage.total_alloc_bytes)}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">System:</div>
                        <div>{formatBytes(systemInfo.system_info.memory_usage.sys_bytes)}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="font-medium">GC Cycles:</div>
                        <div>{systemInfo.system_info.memory_usage.num_gc}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default SystemInfoModal; 