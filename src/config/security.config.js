export default {
  jwt: {
    secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production',
    expiresIn: '24h',
    refreshExpiresIn: '7d'
  },
  
  apiKey: {
    header: 'x-api-key',
    secret: process.env.API_KEY || 'your-api-key-change-this'
  },
  
  rateLimit: {
    windowMs: 60 * 1000, // 1 minute
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
  },
  
  slowDown: {
    windowMs: 60 * 1000, // 1 minute
    delayAfter: 50, // allow 50 requests per minute, then...
    delayMs: 500 // begin adding 500ms of delay per request above 50
  },
  
  encryption: {
    algorithm: 'aes-256-gcm',
    key: process.env.ENCRYPTION_KEY || 'your-32-character-encryption-key',
    saltRounds: 10
  },
  
  cors: {
    origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(','),
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-request-id']
  },
  
  helmet: {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  }
};
