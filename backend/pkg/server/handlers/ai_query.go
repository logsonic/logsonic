package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"logsonic/pkg/types"
	"net/http"
	"strings"
	"time"
)

// AIQueryRequest defines the structure sent to the Ollama API
type AIQueryRequest struct {
	Columns []string `json:"columns"`
	Query   string   `json:"query"`
}

// AIQueryResponse defines the expected response structure from Ollama 
type AIQueryResponse struct {
	Query      string  `json:"query"`
	Confidence float64 `json:"confidence"`
}

// AIQueryAPIResponse defines the API response we send back to the client
type AIQueryAPIResponse struct {
	Query           string   `json:"query"`
	Confidence      float64  `json:"confidence"`
	AvailableModels []string `json:"available_models"`
	ModelUsed       string   `json:"model_used"`
	Success         bool     `json:"success"`
	Error           string   `json:"error,omitempty"`
}

// HandleQueryTranslation handles translation from natural language to Logsonic query syntax
// @Summary Translate natural language to Logsonic query
// @Description Converts natural language description into Logsonic query syntax using AI
// @ID translate-query
// @Accept json
// @Produce json
// @Param request body handlers.AIQueryRequest true "Natural language query and column information"
// @Success 200 {object} handlers.AIQueryAPIResponse "Translated query with confidence score"
// @Failure 400 {object} types.ErrorResponse "Bad request due to invalid parameters"
// @Failure 500 {object} types.ErrorResponse "Internal server error"
// @Router /api/v1/ai/translate-query [post]
func (h *Services) HandleQueryTranslation(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Method not allowed",
			Code:   "METHOD_NOT_ALLOWED",
		})
		return
	}

	// Parse request body
	var request AIQueryRequest
	err := json.NewDecoder(r.Body).Decode(&request)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Invalid request body",
			Code:    "INVALID_PARAMETER",
			Details: err.Error(),
		})
		return
	}

	
	// Validate request
	if request.Query == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Empty query",
			Code:    "INVALID_PARAMETER",
			Details: "Query cannot be empty",
		})
		return
	}

	// Try to get available columns from storage if none provided
	if len(request.Columns) == 0 {
		// Use default columns - we don't have a direct API to get all columns
		request.Columns = []string{"timestamp", "message"}
	}

	// Set ollama endpoint - default to localhost
	// TODO: Make this configurable
	ollamaEndpoint := "http://localhost:11434/api/generate"
	
	// Get available models to find the right Logsonic model
	availableModels := []string{}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://localhost:11434/api/tags")
	if err == nil {
		defer resp.Body.Close()
		
		var tagsResponse struct {
			Models []struct {
				Name string `json:"name"`
			} `json:"models"`
		}
		
		if err := json.NewDecoder(resp.Body).Decode(&tagsResponse); err == nil {
			for _, model := range tagsResponse.Models {
				availableModels = append(availableModels, model.Name)
			}
		}
	}
	
	// Find the appropriate Logsonic model to use
	modelName := findLogsonicModel(availableModels)
	
	// Call the Ollama API with the selected model
	response, err := callOllamaAPI(ollamaEndpoint, modelName, request)
	
	// If Ollama fails and OpenAI is configured, we could fall back to it here
	// For now, just return the error
	
	if err != nil {
		fmt.Printf("[AI Query] Error translating query: %s\n", err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "AI model error",
			Code:    "AI_MODEL_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Return the response
	apiResponse := AIQueryAPIResponse{
		Query:           response.Query,
		Confidence:      response.Confidence,
		AvailableModels: availableModels,
		ModelUsed:       modelName,
		Success:         true,
	}


	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(apiResponse)
}

// OllamaRequest is the structure for requests to Ollama API
type OllamaRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
}

// OllamaResponse is the structure for responses from Ollama API
type OllamaResponse struct {
	Model     string `json:"model"`
	Response  string `json:"response"`
	CreatedAt string `json:"created_at"`
}

// Function to call the Ollama API
func callOllamaAPI(endpoint string, model string, request AIQueryRequest) (AIQueryResponse, error) {
	// Create JSON string for the prompt
	promptData, err := json.Marshal(request)
	if err != nil {
		return AIQueryResponse{}, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create Ollama request
	ollamaRequest := OllamaRequest{
		Model:  model,
		Prompt: string(promptData),
		Stream: false, // Disable streaming to get complete response at once
	}

	requestBody, err := json.Marshal(ollamaRequest)
	if err != nil {
		return AIQueryResponse{}, fmt.Errorf("failed to marshal Ollama request: %w", err)
	}


	// Create HTTP request
	client := &http.Client{
		Timeout: 30 * time.Second,
	}
	
	resp, err := client.Post(endpoint, "application/json", bytes.NewBuffer(requestBody))
	if err != nil {
		return AIQueryResponse{}, fmt.Errorf("failed to call Ollama API: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return AIQueryResponse{}, fmt.Errorf("failed to read Ollama response: %w", err)
	}


	// Parse Ollama response
	var ollamaResp OllamaResponse
	err = json.Unmarshal(respBody, &ollamaResp)
	if err != nil {
		return AIQueryResponse{}, fmt.Errorf("failed to parse Ollama response: %w", err)
	}

	// Extract JSON from the text response
	jsonStr := ollamaResp.Response
	// Clean up JSON - sometimes Ollama adds extra text before/after the JSON
	jsonStr = strings.TrimSpace(jsonStr)
	
	// Try to find JSON content between braces
	startIndex := strings.Index(jsonStr, "{")
	endIndex := strings.LastIndex(jsonStr, "}")
	
	if startIndex >= 0 && endIndex > startIndex {
		jsonStr = jsonStr[startIndex : endIndex+1]
	}
	
	// Parse the JSON response
	var aiResponse AIQueryResponse
	err = json.Unmarshal([]byte(jsonStr), &aiResponse)
	if err != nil {
		return AIQueryResponse{}, fmt.Errorf("failed to parse AI response: %w", err)
	}

	return aiResponse, nil
}

// Function to check if the Ollama service is running
func IsOllamaRunning() bool {
	client := &http.Client{
		Timeout: 2 * time.Second,
	}
	
	resp, err := client.Get("http://localhost:11434/api/tags")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	
	return resp.StatusCode == http.StatusOK
}

// HandleCheckAIStatus checks if AI services (Ollama) are available
// @Summary Check AI service status
// @Description Checks if the Ollama service is running and the required models are available
// @ID check-ai-status
// @Produce json
// @Success 200 {object} map[string]interface{} "AI service status information"
// @Router /api/v1/ai/status [get]
func (h *Services) HandleCheckAIStatus(w http.ResponseWriter, r *http.Request) {
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

	// Check if Ollama is running
	isOllamaRunning := IsOllamaRunning()
	
	// Prepare response
	response := map[string]interface{}{
		"ollama_running": isOllamaRunning,
		"models_available": []string{},
	}
	
	// If Ollama is running, check available models
	if isOllamaRunning {
		client := &http.Client{
			Timeout: 5 * time.Second,
		}
		
		resp, err := client.Get("http://localhost:11434/api/tags")
		if err == nil {
			defer resp.Body.Close()
			
			var tagsResponse struct {
				Models []struct {
					Name string `json:"name"`
				} `json:"models"`
			}
			
			if err := json.NewDecoder(resp.Body).Decode(&tagsResponse); err == nil {
				modelNames := []string{}
				logsonicModels := []string{}
				
				for _, model := range tagsResponse.Models {
					modelNames = append(modelNames, model.Name)
					// Check if this is a Logsonic model (contains "logsonic" in the name)
					if strings.Contains(strings.ToLower(model.Name), "logsonic") {
						logsonicModels = append(logsonicModels, model.Name)
					}
				}
				
				response["models_available"] = modelNames
				
				// Log if any Logsonic models are detected
				if len(logsonicModels) > 0 {
					fmt.Printf("[AI Status] Logsonic models detected: %s\n", strings.Join(logsonicModels, ", "))
				} else {
					fmt.Println("[AI Status] Ollama is running but no Logsonic models are available")
				}
			}
		}
	} else {
		fmt.Println("[AI Status] Ollama service is not running")
	}
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}

// Set appropriate Ollama model name based on available models
func findLogsonicModel(availableModels []string) string {
	// Priority order: "logsonic", "logsonic:latest", "logsonic-search", any model with "logsonic" in the name
	if len(availableModels) == 0 {
		return "logsonic" // Default if no models available
	}
	
	// First try exact matches in order of preference
	preferredModels := []string{"logsonic", "logsonic:latest"}
	for _, preferred := range preferredModels {
		for _, available := range availableModels {
			if available == preferred {
				return available
			}
		}
	}
	
	// Then try partial matches
	for _, available := range availableModels {
		if strings.Contains(strings.ToLower(available), "logsonic") {
			return available
		}
	}
	
	// Fallback to default
	return "logsonic"
} 