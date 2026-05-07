import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Server
  port: process.env.PORT || 3000,
  host: process.env.HOST || 'localhost',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/call-coach-lab',
  mongoMaxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '10'),

  // JWT
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-secret',
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '900s',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  // Setup token (verify-email → workspace setup bridge)
  setupTokenExpiry: process.env.SETUP_TOKEN_EXPIRY || '15m',

  // Email verification
  emailVerificationTtlHours: parseInt(
    process.env.EMAIL_VERIFICATION_TTL_HOURS || '24'
  ),
  passwordResetTtlMinutes: parseInt(
    process.env.PASSWORD_RESET_TTL_MINUTES || '60'
  ),

  // App URLs (used to build links in outbound emails)
  appUrl: process.env.APP_URL || 'http://localhost:3001',
  emailFrom: process.env.EMAIL_FROM || 'Call Coach Lab <noreply@callcoachlab.local>',

  // Resend (transactional email)
  resend: {
    apiKey: process.env.RESEND_API_KEY || null,
  },

  // Invite
  inviteTtlDays: parseInt(process.env.INVITE_TTL_DAYS || '7'),

  // CORS
  corsOrigin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],

  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
    login: parseInt(process.env.RATE_LIMIT_LOGIN || '10'),
    invite: parseInt(process.env.RATE_LIMIT_INVITE || '20'),
    refresh: parseInt(process.env.RATE_LIMIT_REFRESH || '30'),
    register: parseInt(process.env.RATE_LIMIT_REGISTER || '5'),
    resend: parseInt(process.env.RATE_LIMIT_RESEND || '5'),
    forgotPassword: parseInt(process.env.RATE_LIMIT_FORGOT_PASSWORD || '5'),
  },

  // Account lockout
  lockout: {
    threshold1Attempts: parseInt(process.env.LOCKOUT_THRESHOLD_1 || '5'),
    threshold1Minutes: parseInt(process.env.LOCKOUT_DURATION_1_MIN || '5'),
    threshold2Attempts: parseInt(process.env.LOCKOUT_THRESHOLD_2 || '10'),
    threshold2Minutes: parseInt(process.env.LOCKOUT_DURATION_2_MIN || '15'),
    threshold3Attempts: parseInt(process.env.LOCKOUT_THRESHOLD_3 || '20'),
    threshold3Minutes: parseInt(process.env.LOCKOUT_DURATION_3_MIN || '60'),
  },

  // Password (kept for back-compat; new flow uses utils/passwordPolicy.js)
  passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '10'),

  // CSRF
  csrfTokenSecret: process.env.CSRF_TOKEN_SECRET || 'dev-csrf-secret',

  // Internal Service Auth
  internalSecret: process.env.INTERNAL_SECRET || 'dev-internal-secret',
};
