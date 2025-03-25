// Package grok provides handlers for Grok pattern management
// Its a simple CRUD interface for managing current and custom grok patterns
package handlers

import (
	"encoding/json"
	"fmt"
	"logsonic/pkg/types"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

var (
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex    = &sync.Mutex{}
	patternsFile    = "grok.json"
)

// loadPatternsFromFile reads patterns from the JSON file and loads them into memory
// If the file doesn't exist, it creates a new one with default patterns
func (h *Services) loadPatternsFromFile() error {
	patternMutex.Lock()
	defer patternMutex.Unlock()

	// Use StoragePath from handlers' config rather than assuming current directory
	// And use filepath.Clean to prevent path traversal attacks
	safePatternFilePath := filepath.Clean(filepath.Join(h.StoragePath, patternsFile))

	// Check if patterns file exists
	if _, err := os.Stat(safePatternFilePath); os.IsNotExist(err) {
		// File doesn't exist, initialize with default patterns
		fmt.Println("No patterns file found, creating with default patterns")
		currentPatterns = DefaultGrokPatterns()

		// Save the default patterns to file
		return h.savePatternsToFile()
	}

	// Read patterns from file
	data, err := os.ReadFile(safePatternFilePath)
	if err != nil {
		return fmt.Errorf("failed to read patterns file: %w", err)
	}

	var patternsConfig struct {
		Patterns []types.GrokPatternDefinition `json:"patterns"`
	}

	if err := json.Unmarshal(data, &patternsConfig); err != nil {
		return fmt.Errorf("failed to parse patterns file: %w", err)
	}

	currentPatterns = patternsConfig.Patterns
	return nil
}

// savePatternsToFile writes current patterns to the JSON file
func (h *Services) savePatternsToFile() error {
	patternsConfig := struct {
		Patterns []types.GrokPatternDefinition `json:"patterns"`
	}{
		Patterns: currentPatterns,
	}

	data, err := json.MarshalIndent(patternsConfig, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal patterns: %w", err)
	}

	// Use StoragePath from handlers' config rather than assuming current directory
	// And use filepath.Clean to prevent path traversal attacks
	safePatternFilePath := filepath.Clean(filepath.Join(h.StoragePath, patternsFile))

	// Create directory if it doesn't exist
	dir := filepath.Dir(safePatternFilePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create patterns directory: %w", err)
	}

	if err := os.WriteFile(safePatternFilePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write patterns file: %w", err)
	}

	return nil
}

// @Summary Manage Grok patterns
// @Description Create, read, update, and delete Grok patterns for log parsing
// @Tags grok
// @Accept json
// @Produce json
// @Param request body types.GrokPatternRequest true "Grok pattern definition"
// @Success 200 {object} types.GrokPatternResponse "Success response with patterns"
// @Success 201 {object} types.GrokPatternResponse "Pattern created successfully"
// @Failure 400 {object} types.ErrorResponse "Invalid request format or missing required fields"
// @Failure 404 {object} types.ErrorResponse "Pattern not found"
// @Failure 405 {object} types.ErrorResponse "Method not allowed"
// @Failure 500 {object} types.ErrorResponse "Internal server error"
// @Router /api/v1/grok [post]
// @Router /api/v1/grok [get]
// @Router /api/v1/grok [delete]
func (h *Services) HandleGrokPatterns(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodPost:
		h.createGrokPattern(w, r)
	case http.MethodDelete:
		h.deleteGrokPattern(w, r)
	case http.MethodGet:
		h.getGrokPatterns(w, r)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Method not allowed",
		})
	}
}

func (h *Services) createGrokPattern(w http.ResponseWriter, r *http.Request) {
	var req types.GrokPatternRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  "Invalid request format: " + err.Error(),
		})
		return
	}

	// Validate request
	if req.Name == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  "Pattern name is required",
		})
		return
	}

	// Prepare new pattern definition
	newPattern := types.GrokPatternDefinition{
		Name:           req.Name,
		Pattern:        req.Pattern,
		Priority:       req.Priority,
		Description:    req.Description,
		Type:           "custom", // All user defined patterns are custom
		CustomPatterns: req.CustomPatterns,
	}

	// Check if pattern already exists
	patternExists := false
	for _, existingPattern := range currentPatterns {
		if existingPattern.Name == req.Name {
			patternExists = true
			break
		}
	}

	// If pattern doesn't exist, append it
	if !patternExists {
		currentPatterns = append(currentPatterns, newPattern)
	} else {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  fmt.Sprintf("Pattern name '%s' already exists", req.Name),
		})
		return
	}

	// Save updated patterns to file
	if err := h.savePatternsToFile(); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  fmt.Sprintf("Failed to save patterns: %v", err),
		})
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(types.GrokPatternResponse{
		Status: "success",
		Patterns: []types.GrokPatternRequest{
			{
				Name:           req.Name,
				Priority:       req.Priority,
				CustomPatterns: req.CustomPatterns,
				Pattern:        req.Pattern,
				Description:    req.Description,
			},
		},
	})
}

func (h *Services) deleteGrokPattern(w http.ResponseWriter, r *http.Request) {
	patternName := r.URL.Query().Get("name")

	// Find and remove the specific pattern
	updatedPatterns := currentPatterns
	patternFound := false

	for i, pattern := range currentPatterns {
		if pattern.Name == patternName {
			patternFound = true
			// Remove the pattern from the list using slices.Delete
			updatedPatterns = slices.Delete(updatedPatterns, i, i+1)
			break
		}
	}

	// Check if pattern was found
	if !patternFound {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  fmt.Sprintf("Pattern '%s' not found", patternName),
		})
		return
	}

	// Update current patterns
	currentPatterns = updatedPatterns

	// Save updated patterns to file
	if err := h.savePatternsToFile(); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  fmt.Sprintf("Failed to save patterns: %v", err),
		})
		return
	}

	json.NewEncoder(w).Encode(types.GrokPatternResponse{
		Status: "success",
		Error:  fmt.Sprintf("Pattern '%s' has been deleted", patternName),
	})
}

func (h *Services) getGrokPatterns(w http.ResponseWriter, r *http.Request) {

	// Convert current patterns to GrokPatternRequest
	convertedPatterns := make([]types.GrokPatternRequest, len(currentPatterns))
	for i, pattern := range currentPatterns {
		convertedPatterns[i] = types.GrokPatternRequest{
			Name:           pattern.Name,
			Pattern:        pattern.Pattern,
			Priority:       pattern.Priority,
			Description:    pattern.Description,
			CustomPatterns: pattern.CustomPatterns,
		}
	}

	json.NewEncoder(w).Encode(types.GrokPatternResponse{
		Status:   "success",
		Patterns: convertedPatterns,
	})
}

// InitializeGrokPatterns should be called during server startup
func (h *Services) InitializeGrokPatterns() error {
	h.loadPatternsFromFile()
	return nil
}

// GetPatternDefinitions returns a copy of the current pattern definitions
// This function is used by other handlers to access the patterns
func (h *Services) GetPatternDefinitions() []types.GrokPatternDefinition {
	patternMutex.Lock()
	defer patternMutex.Unlock()

	patterns := make([]types.GrokPatternDefinition, len(currentPatterns))
	copy(patterns, currentPatterns)
	return patterns
}
