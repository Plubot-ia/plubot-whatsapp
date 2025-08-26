// WhatsApp Web configuration to avoid detection and blocking
export const whatsappConfig = {
  // Puppeteer configuration
  puppeteer: {
    headless: true,
    puppeteerArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ],
    ffmpegPath: process.platform === 'darwin' ? '/usr/local/bin/ffmpeg' : undefined,
    bypassCSP: true,
  },

  // Client configuration
  client: {
    qrMaxRetries: 3,
    qrRefreshIntervalMs: 30_000, // 30 seconds between QR refreshes
    takeoverOnConflict: false,
    takeoverTimeoutMs: 0,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },

  // Rate limiting configuration
  rateLimiting: {
    connectionDelay: 5000, // 5 seconds delay between connection attempts
    maxConnectionsPerHour: 10,
    qrGenerationDelay: 2000, // 2 seconds delay before generating QR
  },

  // Session configuration
  session: {
    maxReconnectAttempts: 3,
    reconnectDelay: 10_000, // 10 seconds between reconnect attempts
    sessionTimeout: 300_000, // 5 minutes session timeout
    cleanupInterval: 60_000, // 1 minute cleanup interval
  },
};

export default whatsappConfig;
