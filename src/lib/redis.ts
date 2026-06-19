// Se usa el ioredis bundleado con bullmq para evitar conflicto de tipos
import IORedis from 'bullmq/node_modules/ioredis/built/index.js'
import { logger } from './logger.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

export const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, // requerido por BullMQ
})

redis.on('connect', () => logger.info('Redis conectado'))
redis.on('error',   (err) => logger.error({ err }, 'Redis error'))
