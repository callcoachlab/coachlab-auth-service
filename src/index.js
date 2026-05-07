import express from 'express';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { connectDatabase } from './config/database.js';
import { logger } from './config/logger.js';
import { globalErrorHandler, asyncHandler } from './middleware/errorHandler.js';

// Routes
import csrfRoutes from './routes/csrf.js';
import authRoutes from './routes/auth.js';
import workspacesRoutes from './routes/workspaces.js';
import teamsRoutes from './routes/teams.js';
import usersRoutes from './routes/users.js';
import invitesRoutes from './routes/invites.js';
import meRoutes from './routes/me.js';
import settingsRoutes from './routes/settings.js';
import auditLogsRoutes from './routes/auditLogs.js';
import internalRoutes from './routes/internal.js';

const app = express();

// Security Middleware
// Content Security Policy (CSP) - Explicit policy for frontend resources.
// Swagger UI lives under /api-docs and needs inline scripts/styles, so we skip
// helmet's CSP for that path only.
app.use((req, res, next) => {
  if (req.path.startsWith('/api-docs')) return next();
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        fontSrc: ["'none'"],
        connectSrc: ["'self'"],
        mediaSrc: ["'none'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'none'"],
      },
    },
    hsts: true,
    noSniff: true,
    xssFilter: true,
  })(req, res, next);
});


app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json());
// MongoDB Injection Prevention - Sanitize inputs
app.use(mongoSanitize({ onSanitize: ({ req, key }) => {
  logger.warn(`Sanitized key detected and removed: ${key}`);
}}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check
app.get('/health', asyncHandler((req, res) => {
  res.json({ success: true, message: 'Server is healthy' });
}));

// Swagger / OpenAPI docs — local development only
if (process.env.NODE_ENV !== 'production') {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const openapiSpec = YAML.parse(
    fs.readFileSync(path.join(__dirname, 'docs', 'openapi.yaml'), 'utf-8')
  );
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
    customSiteTitle: 'Call Coach Lab API',
    swaggerOptions: { persistAuthorization: true },
  }));
  app.get('/api-docs.json', (_req, res) => res.json(openapiSpec));
}

// Routes
app.use('/csrf', csrfRoutes);
app.use('/auth', authRoutes);
app.use('/workspaces', workspacesRoutes);
app.use('/teams', teamsRoutes);
app.use('/users', usersRoutes);
app.use('/invites', invitesRoutes);
app.use('/me', meRoutes);
app.use('/settings', settingsRoutes);
app.use('/audit-logs', auditLogsRoutes);
app.use('/internal', internalRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found',
    },
  });
});

// Global error handler
app.use(globalErrorHandler);

// Start server
async function startServer() {
  try {
    await connectDatabase();
    logger.info('Database connected successfully');

    const server = app.listen(config.port, config.host, () => {
      logger.info(`Server running on http://${config.host}:${config.port}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down gracefully');
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

startServer();

export default app;