import pino from 'pino';
import { config } from './index.js';

export const logger = pino({
  level: config.logLevel,
});
