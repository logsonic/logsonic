package handlers

import (
	"encoding/json"
	"fmt"
	"logsonic/pkg/types"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/shirou/gopsutil/host"
)

// @Summary Get system and storage information
// @Description Retrieve detailed information about the system, storage, and application
// @Tags system
// @Produce json
// @Param refresh query boolean false "Force a cache refresh if set to true"
// @Success 200 {object} types.SystemInfoResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /info [get]
func (h *Services) HandleInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Method not allowed",
			Code:   "METHOD_NOT_ALLOWED",
		})
		return
	}

	// Check if refresh parameter is provided
	refreshParam := r.URL.Query().Get("refresh")
	if refreshParam == "true" {
		// Invalidate cache if refresh=true
		h.InvalidateInfoCache()
	}

	// Prepare the response
	response := types.SystemInfoResponse{
		Status: "success",
	}

	// Define the StorageInfo type for consistent handling
	type StorageInfoType struct {
		TotalIndices     int      `json:"total_indices"`
		AvailableDates   []string `json:"available_dates"`
		TotalLogEntries  int      `json:"total_log_entries"`
		StorageDirectory string   `json:"storage_directory"`
		StorageSize      int64    `json:"storage_size_bytes"`
		SourceNames      []string `json:"source_names"`
	}

	// Storage Information section - check cache first
	var storageInfo StorageInfoType
	var availableDates []string
	var sourceNames []string
	var totalLogEntries int
	var storageSize int64
	var storagePath string

	// Try to use cached storage info
	h.infoCacheMutex.RLock()
	cacheHit := h.cacheValid && h.storageInfoCache != nil
	if cacheHit {
		// Use cached storage info
		storageInfo = h.storageInfoCache.(StorageInfoType)
		h.infoCacheMutex.RUnlock()
	} else {
		h.infoCacheMutex.RUnlock()

		// Cache miss - compute storage info
		var err error

		// Get storage information
		availableDates, err = h.storage.List()
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Failed to retrieve storage information",
				Code:    "STORAGE_INFO_ERROR",
				Details: err.Error(),
			})
			return
		}

		sourceNames, err = h.storage.GetSourceNames()
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Failed to retrieve source names",
				Code:    "SOURCE_NAMES_ERROR",
				Details: err.Error(),
			})
			return
		}

		// Calculate total log entries and storage size
		totalLogEntries = 0
		storageSize = 0

		// Use a more efficient method to count logs by using Bleve's DocCount method
		// This avoids retrieving all logs which is expensive for large datasets
		for _, date := range availableDates {
			count, err := h.storage.GetDocCount(date)
			if err == nil {
				totalLogEntries += int(count)
			}
		}

		// Get storage directory size
		storagePath = h.storage.BaseDir()

		// Ensure storage path is clean and correctly formed to prevent path traversal
		storagePath = filepath.Clean(storagePath)

		// Add protection against accessing directories outside of the expected area
		err = filepath.Walk(storagePath, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}

			// Ensure we don't follow symlinks outside the base directory
			if info.Mode()&os.ModeSymlink != 0 {
				// For symlinks, resolve and check if they're within the storage path
				realPath, err := filepath.EvalSymlinks(path)
				if err != nil {
					return err // Skip this file if we can't resolve the symlink
				}

				// Check if the resolved path is within the storage directory
				relPath, err := filepath.Rel(storagePath, realPath)
				if err != nil || strings.HasPrefix(relPath, "..") {
					return nil // Skip files outside the storage directory
				}
			}

			if !info.IsDir() {
				storageSize += info.Size()
			}
			return nil
		})

		// Create storage info structure
		storageInfo = StorageInfoType{
			TotalIndices:     len(availableDates),
			AvailableDates:   availableDates,
			TotalLogEntries:  totalLogEntries,
			StorageDirectory: storagePath,
			StorageSize:      storageSize,
			SourceNames:      sourceNames,
		}

		// Cache the storage info
		h.infoCacheMutex.Lock()
		h.storageInfoCache = storageInfo
		h.cacheValid = true
		h.infoCacheMutex.Unlock()
	}

	// Set the storage info in the response
	response.StorageInfo = storageInfo

	// System Information - always compute fresh
	hostname, _ := os.Hostname()

	// Memory stats
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	// Host info
	hostInfo, hostErr := host.Info()

	// Prepare OS information
	osType := runtime.GOOS
	if hostErr == nil {
		osType = fmt.Sprintf("%s %s", hostInfo.Platform, hostInfo.PlatformVersion)
	}

	response.SystemInfo = struct {
		Hostname     string `json:"hostname"`
		OSType       string `json:"os_type"`
		Architecture string `json:"architecture"`
		GoVersion    string `json:"go_version"`
		NumCPU       int    `json:"num_cpu"`
		MemoryUsage  struct {
			Alloc      uint64 `json:"alloc_bytes"`
			TotalAlloc uint64 `json:"total_alloc_bytes"`
			Sys        uint64 `json:"sys_bytes"`
			NumGC      uint32 `json:"num_gc"`
		} `json:"memory_usage"`
	}{
		Hostname:     hostname,
		OSType:       osType,
		Architecture: runtime.GOARCH,
		GoVersion:    runtime.Version(),
		NumCPU:       runtime.NumCPU(),
		MemoryUsage: struct {
			Alloc      uint64 `json:"alloc_bytes"`
			TotalAlloc uint64 `json:"total_alloc_bytes"`
			Sys        uint64 `json:"sys_bytes"`
			NumGC      uint32 `json:"num_gc"`
		}{
			Alloc:      memStats.Alloc,
			TotalAlloc: memStats.TotalAlloc,
			Sys:        memStats.Sys,
			NumGC:      memStats.NumGC,
		},
	}

	json.NewEncoder(w).Encode(response)
}

// InvalidateInfoCache marks the system info cache as invalid,
// forcing a refresh on the next request
func (h *Services) InvalidateInfoCache() {
	h.infoCacheMutex.Lock()
	defer h.infoCacheMutex.Unlock()
	h.cacheValid = false
	h.storageInfoCache = nil
}
