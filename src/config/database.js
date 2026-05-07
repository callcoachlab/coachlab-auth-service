import mongoose from 'mongoose';
import { config } from './index.js';
import { logger } from './logger.js';

export async function connectDatabase() {
  try {
    await mongoose.connect(config.mongoUri, {
      maxPoolSize: config.mongoMaxPoolSize,
    });
    logger.info('Database connected successfully');
  } catch (error) {
    logger.error({ err: error }, 'Database connection failed — server cannot start without a database');
    process.exit(1);
  }
}

export function getDatabase() {
  return mongoose.connection;
}