#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🔒 Starting Secure WhatsApp Microservice${NC}"

# Check if .env.secure exists, if not copy from example
if [ ! -f .env.secure ]; then
    if [ -f .env.secure.example ]; then
        echo -e "${YELLOW}Creating .env.secure from example...${NC}"
        cp .env.secure.example .env.secure
        echo -e "${GREEN}✓ Created .env.secure - Please update with your values${NC}"
    else
        echo -e "${RED}✗ No .env.secure or .env.secure.example found${NC}"
        exit 1
    fi
fi

# Load secure environment
export $(cat .env.secure | grep -v '^#' | xargs)

# Check Redis
echo -e "${YELLOW}Checking Redis connection...${NC}"
redis-cli ping > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Redis is running${NC}"
else
    echo -e "${YELLOW}Starting Redis in Docker...${NC}"
    docker run -d --name redis-whatsapp \
        -p 6379:6379 \
        redis:alpine
    sleep 2
fi

# Create necessary directories
mkdir -p logs
mkdir -p auth-sessions
mkdir -p temp
mkdir -p backups

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

# Start the secure server
echo -e "${GREEN}Starting secure server on port ${PORT:-3001}...${NC}"
echo -e "${GREEN}Features enabled:${NC}"
echo -e "  ✓ JWT Authentication"
echo -e "  ✓ API Key Support"
echo -e "  ✓ Rate Limiting"
echo -e "  ✓ Input Validation"
echo -e "  ✓ Security Headers"
echo -e "  ✓ Structured Logging"
echo -e "  ✓ Session Pooling"
echo -e "  ✓ WebSocket Support"

# Start with nodemon for development or node for production
if [ "$NODE_ENV" = "production" ]; then
    node src/app.js
else
    npx nodemon src/app.js
fi
