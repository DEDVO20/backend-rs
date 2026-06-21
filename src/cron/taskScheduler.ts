import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

const getTasksService = async () => (await import('../modules/tasks/tasks.service.js')).TasksService
const getSupabase     = async () => (await import('../lib/supabase.js')).supabase

const cronQueue = new Queue('cron-tasks', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 100 },
  },
})

async function processJob(jobName: string) {
  const TasksService = await getTasksService()
  const supabase     = await getSupabase()

  switch (jobName) {

    // Generar tareas del mes
    case 'generate-tasks': {
      const now   = new Date()
      const year  = now.getFullYear()
      const month = now.getMonth() + 1
      const day   = now.getDate()

      const result = await TasksService.generateTasks({ year, month, day })
      logger.info({ result, year, month, day }, 'Cron: tareas generadas')
      break
    }

    // Enviar recordatorios de tareas que vencen mañana
    case 'send-reminders': {
      const count = await TasksService.sendReminders()
      logger.info({ count }, 'Cron: recordatorios enviados')
      break
    }

    // Marcar tareas vencidas (pending → overdue)
    case 'mark-overdue': {
      const today = new Date().toISOString().split('T')[0]!

      const { data, error } = await supabase
        .from('tasks')
        .update({ status: 'overdue' })
        .eq('status', 'pending')
        .lt('due_date', today)
        .select('id')

      const count = data?.length ?? 0
      if (error) logger.error({ error }, 'Cron: error marcando tareas vencidas')
      else logger.info({ count }, 'Cron: tareas marcadas como vencidas')
      break
    }

    default:
      logger.warn({ jobName }, 'Cron: job desconocido')
  }
}

export function startTaskScheduler() {
  // Worker que procesa los jobs
  const worker = new Worker(
    'cron-tasks',
    async (job) => { await processJob(job.name) },
    { connection: redis, concurrency: 1 },
  )

  worker.on('completed', (job) => {
    logger.info({ job: job.name }, 'Cron completado')
  })

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, err: err.message }, 'Cron fallido')
  })

  // Registrar jobs repetitivos
  void setupRepeatableJobs()

  logger.info('Scheduler de tareas iniciado')
  return worker
}

async function setupRepeatableJobs() {
  // Limpiar jobs repetitivos anteriores para evitar duplicados
  const existing = await cronQueue.getRepeatableJobs()
  for (const job of existing) {
    await cronQueue.removeRepeatableByKey(job.key)
  }

  // Generar tareas — 1ro de cada mes a las 6:00 AM (Colombia UTC-5)
  await cronQueue.add('generate-tasks', {}, {
    repeat: { pattern: '0 11 1 * *' }, // 11 UTC = 6 AM COT
  })

  // Recordatorios — Diario a las 7:00 AM
  await cronQueue.add('send-reminders', {}, {
    repeat: { pattern: '0 12 * * *' }, // 12 UTC = 7 AM COT
  })

  // Marcar vencidas — Diario a la 1:00 AM
  await cronQueue.add('mark-overdue', {}, {
    repeat: { pattern: '0 6 * * *' }, // 6 UTC = 1 AM COT
  })

  logger.info('Cron jobs registrados: generate-tasks (1ro/mes 6AM), send-reminders (diario 7AM), mark-overdue (diario 1AM)')
}
