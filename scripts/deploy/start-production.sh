#!/bin/bash

# OneStreamer Production Startup Script
# This script starts all services with proper HTTPS configuration

set -e

echo "🚀 Starting OneStreamer Production Services..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Change to project directory
cd /root/onestreamer

# Function to check if a service is running
check_service() {
    local service_name=$1
    local port=$2
    
    if lsof -i:$port > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $service_name is running on port $port"
        return 0
    else
        echo -e "${RED}✗${NC} $service_name is not running on port $port"
        return 1
    fi
}

# Stop all existing services
echo -e "\n${YELLOW}Stopping existing services...${NC}"
pm2 kill > /dev/null 2>&1 || true
pkill -f "node.*server/index.js" > /dev/null 2>&1 || true
pkill -f "node.*chat-service/index.js" > /dev/null 2>&1 || true
pkill -f "node.*react-scripts" > /dev/null 2>&1 || true

# Wait for ports to be freed
echo "Waiting for ports to be freed..."
sleep 3

# Ensure log directory exists
mkdir -p logs

# Check SSL certificates
echo -e "\n${YELLOW}Checking SSL certificates...${NC}"
if [ -f "/root/onestreamer/certificates/cert.pem" ] && [ -f "/root/onestreamer/certificates/key.pem" ]; then
    echo -e "${GREEN}✓${NC} Self-signed certificates found"
else
    echo -e "${YELLOW}!${NC} Self-signed certificates not found, generating..."
    mkdir -p certificates
    openssl req -x509 -newkey rsa:4096 -keyout certificates/key.pem -out certificates/cert.pem \
        -days 365 -nodes -subj "/CN=onestreamer.live" > /dev/null 2>&1
    echo -e "${GREEN}✓${NC} Self-signed certificates generated"
fi

# Check Let's Encrypt certificates for nginx
if [ -f "/etc/letsencrypt/live/onestreamer.live/fullchain.pem" ]; then
    echo -e "${GREEN}✓${NC} Let's Encrypt certificates found"
else
    echo -e "${RED}!${NC} Let's Encrypt certificates not found - nginx will fail"
fi

# Build the React client and sync to nginx docroot.
# nginx serves the SPA from /var/www/html (see deployment.md for routing). The
# CRA dev server was retired 2026-05-26, so without this step the docroot goes
# stale on every deploy. rsync without --delete preserves /var/www/html/blog,
# /var/www/html/turn-test.html, and the default nginx-debian page.
echo -e "\n${YELLOW}Building and deploying React client...${NC}"
if (cd client && npm run build > /dev/null 2>&1); then
    echo -e "${GREEN}✓${NC} Client build succeeded"
else
    echo -e "${RED}✗${NC} Client build failed — aborting"
    (cd client && npm run build) 2>&1 | tail -30
    exit 1
fi
sudo rsync -a --no-owner --no-group /root/onestreamer/client/build/ /var/www/html/
echo -e "${GREEN}✓${NC} Synced client/build → /var/www/html (bundle: $(grep -oE 'main\.[a-f0-9]+\.js' /var/www/html/index.html))"

# Test nginx configuration
echo -e "\n${YELLOW}Testing nginx configuration...${NC}"
if nginx -t > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Nginx configuration is valid"
    systemctl reload nginx
    echo -e "${GREEN}✓${NC} Nginx reloaded"
else
    echo -e "${RED}✗${NC} Nginx configuration is invalid"
    nginx -t
    exit 1
fi

# Start services with PM2
echo -e "\n${YELLOW}Starting services with PM2...${NC}"

# Load environment variables
export NODE_ENV=production
export USE_HTTPS=true

# Start all services using the ecosystem file
pm2 start config/ecosystem.config.js

# Wait for services to start
echo -e "\n${YELLOW}Waiting for services to start...${NC}"
sleep 10

# Check service status
echo -e "\n${YELLOW}Checking service status...${NC}"

check_service "Main Server (HTTPS)" 8443
check_service "Main Server (HTTP)" 8080
check_service "Chat Service (HTTPS)" 8444
check_service "Chat Service (HTTP)" 8081
check_service "React Client" 3443
check_service "Nginx (HTTPS)" 443

# Show PM2 status
echo -e "\n${YELLOW}PM2 Process Status:${NC}"
pm2 list

# Save PM2 configuration
pm2 save

# Setup PM2 startup script (optional - run once)
# pm2 startup systemd -u root --hp /root

# Test endpoints
echo -e "\n${YELLOW}Testing endpoints...${NC}"

# Test main health endpoint
if curl -k -s https://127.0.0.1:8443/health > /dev/null; then
    echo -e "${GREEN}✓${NC} Main server health check passed"
else
    echo -e "${RED}✗${NC} Main server health check failed"
fi

# Test nginx proxy
if curl -k -s https://onestreamer.live/health > /dev/null; then
    echo -e "${GREEN}✓${NC} Nginx proxy health check passed"
else
    echo -e "${RED}✗${NC} Nginx proxy health check failed"
fi

echo -e "\n${GREEN}✅ OneStreamer Production Services Started!${NC}"
echo -e "\nAccess the application at: ${GREEN}https://onestreamer.live${NC}"
echo -e "\nMonitor logs with:"
echo "  pm2 logs onestreamer-server"
echo "  pm2 logs onestreamer-chat"
echo "  pm2 logs onestreamer-client"
echo -e "\nStop all services with:"
echo "  pm2 stop all"
echo -e "\nRestart services with:"
echo "  pm2 restart all"