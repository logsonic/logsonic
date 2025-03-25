# Multi-stage build Dockerfile for LogSonic
# Stage 1: Build the frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Copy frontend files
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./

# Build the frontend
RUN npm run build

# Stage 2: Build the backend
FROM golang:1.23.7-alpine AS backend-builder
WORKDIR /app/backend

# Copy Go module files first for better caching
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Create the directory structure for static files
RUN mkdir -p ./pkg/static/dist/

# Copy the rest of the backend source code
COPY backend/ ./

# Copy the built frontend into the static directory for embedding
COPY --from=frontend-builder /app/frontend/dist ./pkg/static/dist/

# Build the backend binary with embedded static files
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -trimpath -o logsonic .

# Stage 3: Final lightweight image
FROM alpine:3.19

# Install necessary runtime dependencies
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

# Copy only the compiled binary and any required config files
COPY --from=backend-builder /app/backend/logsonic .

# Default configuration through environment variables
ENV HOST=0.0.0.0
ENV PORT=8080
ENV STORAGE_PATH=/data

# Create volume for persistent data
VOLUME ["/data"]

# Expose the service port
EXPOSE 8080

# Run the binary
ENTRYPOINT ["/app/logsonic"]
