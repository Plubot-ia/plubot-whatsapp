#!/bin/bash

# Migration script from old server to secure server
# This script helps migrate from the monolithic server.js to the new secure modular architecture

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   WhatsApp Microservice - Enterprise Migration Tool${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# Step 1: Backup current setup
echo -e "${YELLOW}Step 1: Creating backup of current setup...${NC}"
BACKUP_DIR="backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p backups/$BACKUP_DIR

# Backup current server file
if [ -f "server.js" ]; then
    cp server.js backups/$BACKUP_DIR/
    echo -e "${GREEN}✓ Backed up server.js${NC}"
fi

# Backup environment files
if [ -f ".env" ]; then
    cp .env backups/$BACKUP_DIR/
    echo -e "${GREEN}✓ Backed up .env${NC}"
fi

# Backup auth sessions
if [ -d "auth-sessions" ]; then
    cp -r auth-sessions backups/$BACKUP_DIR/
    echo -e "${GREEN}✓ Backed up auth-sessions${NC}"
fi

echo -e "${GREEN}✓ Backup completed: backups/$BACKUP_DIR${NC}"
echo ""

# Step 2: Check dependencies
echo -e "${YELLOW}Step 2: Checking and installing new dependencies...${NC}"

# Check if package.json needs updating
DEPS_NEEDED=false
for dep in jsonwebtoken express-rate-limit helmet joi winston bcryptjs cors dotenv express-slow-down express-validator; do
    if ! grep -q "\"$dep\"" package.json; then
        DEPS_NEEDED=true
        break
    fi
done

if [ "$DEPS_NEEDED" = true ]; then
    echo -e "${YELLOW}Installing security dependencies...${NC}"
    npm install jsonwebtoken express-rate-limit helmet joi winston bcryptjs cors dotenv express-slow-down express-validator
    echo -e "${GREEN}✓ Dependencies installed${NC}"
else
    echo -e "${GREEN}✓ All dependencies already installed${NC}"
fi
echo ""

# Step 3: Create secure environment file
echo -e "${YELLOW}Step 3: Setting up secure environment configuration...${NC}"

if [ ! -f ".env.secure" ]; then
    if [ -f ".env" ]; then
        echo -e "${YELLOW}Migrating existing .env to .env.secure...${NC}"
        cp .env .env.secure
        
        # Add new security configurations
        cat >> .env.secure << 'EOF'

# === SECURITY CONFIGURATIONS (Added by migration) ===
# JWT Configuration
JWT_SECRET=CHANGE-THIS-TO-A-SECURE-SECRET-MIN-32-CHARS
JWT_EXPIRES_IN=24h
JWT_REFRESH_EXPIRES_IN=7d

# API Key
API_KEY=CHANGE-THIS-TO-A-SECURE-API-KEY-MIN-32-CHARS

# Encryption
ENCRYPTION_KEY=CHANGE-THIS-32-CHARACTER-KEY-NOW!!

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_MESSAGE_MAX=30
RATE_LIMIT_SESSION_CREATE_MAX=10

# Session Configuration
SESSION_MAX_RETRIES=5
SESSION_RETRY_DELAY=5000
SESSION_TIMEOUT=300000
SESSION_MAX_QR_RETRIES=3
SESSION_POOL_SIZE=100

# Logging
LOG_LEVEL=info
LOG_DIR=logs
LOG_MAX_SIZE=5242880
LOG_MAX_FILES=5

# Monitoring
METRICS_ENABLED=true
METRICS_PORT=9090
HEALTH_CHECK_INTERVAL=30000

# Security Headers
CSP_ENABLED=true
HSTS_ENABLED=true
HSTS_MAX_AGE=31536000
EOF
        echo -e "${GREEN}✓ Created .env.secure with security configurations${NC}"
        echo -e "${YELLOW}⚠️  IMPORTANT: Update the security keys in .env.secure before running in production!${NC}"
    else
        cp .env.secure.example .env.secure 2>/dev/null || cp .env.secure .env.secure
        echo -e "${GREEN}✓ Created .env.secure${NC}"
    fi
else
    echo -e "${GREEN}✓ .env.secure already exists${NC}"
fi
echo ""

# Step 4: Create directory structure
echo -e "${YELLOW}Step 4: Creating secure directory structure...${NC}"

directories=(
    "src/api/middleware"
    "src/api/routes"
    "src/api/controllers"
    "src/core/services"
    "src/core/utils"
    "src/config"
    "logs"
    "temp"
    "backups"
)

for dir in "${directories[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo -e "${GREEN}✓ Created $dir${NC}"
    fi
done
echo ""

# Step 5: Test configuration
echo -e "${YELLOW}Step 5: Testing configuration...${NC}"

# Check Redis
redis-cli ping > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Redis is running${NC}"
else
    echo -e "${YELLOW}⚠️  Redis is not running. Start it with: docker-compose up -d redis${NC}"
fi

# Check if old server is running
OLD_SERVER_PID=$(lsof -ti:3001 2>/dev/null)
if [ ! -z "$OLD_SERVER_PID" ]; then
    echo -e "${YELLOW}⚠️  Old server is running on port 3001 (PID: $OLD_SERVER_PID)${NC}"
    echo -e "${YELLOW}   Stop it before starting the secure server${NC}"
fi
echo ""

# Step 6: Migration summary
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Migration Preparation Complete!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${GREEN}Next steps:${NC}"
echo -e "1. ${YELLOW}Update security keys in .env.secure${NC}"
echo -e "   - JWT_SECRET"
echo -e "   - API_KEY"
echo -e "   - ENCRYPTION_KEY"
echo ""
echo -e "2. ${YELLOW}Stop the old server (if running):${NC}"
echo -e "   ${BLUE}docker-compose down${NC} or ${BLUE}kill $OLD_SERVER_PID${NC}"
echo ""
echo -e "3. ${YELLOW}Start the secure server:${NC}"
echo -e "   ${BLUE}./start-secure.sh${NC} (development mode)"
echo -e "   ${BLUE}docker-compose -f docker-compose.secure.yml up${NC} (production mode)"
echo ""
echo -e "4. ${YELLOW}Test the new endpoints:${NC}"
echo -e "   ${BLUE}curl http://localhost:3001/health${NC}"
echo ""
echo -e "5. ${YELLOW}Update frontend to use JWT authentication:${NC}"
echo -e "   - Login: POST /auth/login"
echo -e "   - Include token in headers: Authorization: Bearer <token>"
echo ""
echo -e "${GREEN}Backup location: backups/$BACKUP_DIR${NC}"
echo -e "${YELLOW}⚠️  Keep the backup until you confirm the migration is successful${NC}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"

# Make scripts executable
chmod +x start-secure.sh 2>/dev/null

echo -e "${GREEN}✓ Migration script completed successfully!${NC}"
