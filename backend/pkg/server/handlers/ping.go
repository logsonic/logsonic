package handlers

import (
	"encoding/json"
	"net/http"
)

// PingResponse represents the response from the ping endpoint
type PingResponse struct {
	Status string `json:"status"`
}

// HandlePing is a simple handler that responds with "pong" to check API availability
// @Summary Ping the API
// @Description Check if the API is running
// @Tags System
// @Produce json
// @Success 200 {object} PingResponse
// @Router /ping [get]
func (s *Services) HandlePing(w http.ResponseWriter, r *http.Request) {
	response := PingResponse{
		Status: "pong",
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}
