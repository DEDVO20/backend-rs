import { Queue, Worker } from 'bullmq'
import { redis } from '../../lib/redis.js'
import { logger } from '../../lib/logger.js'

// Importación diferida para evitar ciclos
const getService = async () => (await import('../NotificationService.js')).NotificationService

export const notificationQueue = new Queue('notifications', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 500 },
  },
})

export function startNotificationWorker() {
  const worker = new Worker(
    'notifications',
    async (job) => {
      const Service = await getService()
      await Service.dispatch(job.data)
    },
    {
      connection:  redis,
      concurrency: 10,
    },
  )

  worker.on('completed', (job) => {
    logger.info(
      { jobId: job.id, channel: job.data.channel, to: job.data.to },
      'Notificación enviada',
    )
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
      'Notificación fallida',
    )
  })

  logger.info('Worker de notificaciones iniciado')
  return worker
}
