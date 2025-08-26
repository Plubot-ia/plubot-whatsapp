# Multi-stage build for optimized production image
# Cache busting comment - Update timestamp to force rebuild
# Last update: 2025-08-26T18:52:00Z
# Force rebuild: ES module fixes applied
FROM node:20-alpine AS dependencies
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Set environment variables for Puppeteer to skip Chromium download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy dependency files
COPY package.json ./
RUN npm install --omit=dev

# Stage 2: Builder
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat chromium
WORKDIR /app

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy dependencies from dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

# Build if needed (for TypeScript, etc)
# RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner

# Install runtime dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini


# Set up non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy everything from builder stage (includes node_modules and all source files)
COPY --from=builder --chown=nodejs:nodejs /app ./

# Set environment variables
ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_OPTIONS="--max-old-space-size=2048"

# Create necessary directories with proper permissions
RUN mkdir -p sessions logs .wwebjs_cache && \
    chown -R nodejs:nodejs sessions logs .wwebjs_cache

# Switch to non-root user
USER nodejs

# Expose ports
EXPOSE 3001 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health/live', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start application
CMD ["node", "--expose-gc", "src/index.js"]
