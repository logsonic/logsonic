#!/bin/bash

# Base URL for the API
BASE_URL="http://localhost:8080"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Resolve script directory and log file path
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_FILE="${SCRIPT_DIR}/logs/Linux_2k.log"

echo "=== Testing Log Station API ==="

# Function to make API calls and check responses
call_api() {
    local endpoint=$1
    local method=$2
    local data=$3
    
    echo -e "\n${GREEN}Calling $method $endpoint${NC}"
    if [ -n "$data" ]; then
        echo "Request body: $data"
    fi
    
    response=$(curl -s -X "$method" "$BASE_URL$endpoint" \
        -H "Content-Type: application/json" \
        ${data:+-d "$data"})
    
    echo "Response: $response"
    if [[ $response == *"error"* ]]; then
        echo -e "${RED}Error in response${NC}"
        return 1
    fi
    return 0
}

# Function to print response in a formatted way
print_response() {
    echo "Response:"
    echo "$1" | jq '.'
    echo "------------------------"
}

# Clear existing logs
echo -e "\n${GREEN}Clearing existing logs...${NC}"
call_api "/clear" "POST"

# Read logs from file and prepare JSON payload
echo -e "\n${GREEN}Reading logs from ${LOG_FILE}...${NC}"
if [ ! -f "${LOG_FILE}" ]; then
    echo -e "${RED}Error: Log file not found at: ${LOG_FILE}${NC}"
    echo "Please ensure Linux_2K.log exists in the logs directory"
    exit 1
fi

# Process and ingest logs in chunks
echo -e "\n${GREEN}Processing and ingesting logs in chunks...${NC}"
CHUNK_SIZE=100
total_lines=$(wc -l < "${LOG_FILE}")
current_line=1

while [ $current_line -le $total_lines ]; do
    echo -e "Processing lines $current_line to $((current_line + CHUNK_SIZE - 1))..."
    
    chunk_json=$(tail -n "+$current_line" "${LOG_FILE}" | head -n $CHUNK_SIZE | \
        jq -R -s -c 'split("\n") | map(select(length > 0))')
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}Error: Failed to process log chunk${NC}"
        exit 1
    fi
    
    ingest_payload="{\"logs\": $chunk_json}"
    call_api "/ingest" "POST" "$ingest_payload"
    
    current_line=$((current_line + CHUNK_SIZE))
    sleep 0.1  # Small delay between chunks
done

# Test various queries
echo -e "\n${GREEN}Testing queries...${NC}"

# Linux-specific queries
queries=(
    '{"query": "program=sshd", "limit": 5}'
    '{"query": "hostname=localhost && program=sudo", "limit": 5}'
    '{"query": "message:authentication && program=sshd", "limit": 5}'
    '{"query": "message:failed && program=sudo", "limit": 5}'
    '{"query": "(program=sshd && message:accepted) || (program=sudo && message:session)", "limit": 5}'
    '{"query": "pid>1000 && program=sshd", "limit": 5}'
    '{"query": "raw:COMMAND", "limit": 5}'
)

for query in "${queries[@]}"; do
    echo -e "\n${GREEN}Testing query: $query${NC}"
    call_api "/query" "POST" "$query"
    # Add a small delay between queries
    sleep 1
done

# List available dates
echo -e "\n${GREEN}Listing available dates...${NC}"
call_api "/list" "GET"

echo "=== Test completed ===" 