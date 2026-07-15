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

async function logCronExecution(jobName: string, status: string, result: Record<string, unknown>, error?: string, durationMs?: number) {
  try {
    const supabase = await getSupabase()
    await supabase.from('cron_logs').insert({
      job_name:    jobName,
      status,
      result,
      error:       error ?? null,
      duration_ms: durationMs ?? null,
    })
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Error guardando cron log')
  }
}

async function processJob(jobName: string) {
  const TasksService = await getTasksService()
  const supabase     = await getSupabase()
  const start = Date.now()

  try {
    let result: Record<string, unknown> = {}

    switch (jobName) {

      case 'generate-tasks': {
        const now   = new Date()
        const year  = now.getFullYear()
        const month = now.getMonth() + 1
        const day   = now.getDate()

        const genResult = await TasksService.generateTasks({ year, month, day })
        result = { ...genResult, year, month, day }
        logger.info({ result }, 'Cron: tareas generadas')
        break
      }

      case 'send-reminders': {
        const count = await TasksService.sendReminders()
        result = { count }
        logger.info({ count }, 'Cron: recordatorios enviados')
        break
      }

      case 'mark-overdue': {
        const TasksService = await getTasksService()
        const count = await TasksService.markOverdue()
        result = { count, date: new Date().toISOString().split('T')[0]! }
        logger.info({ count }, 'Cron: tareas marcadas como vencidas')
        break
      }

      case 'tax-calendar-tasks': {
        const { AccountingService } = await import('../modules/accounting/accounting.service.js')
        result = await AccountingService.generateTaxTasks()
        logger.info({ result }, 'Cron: tareas de calendario tributario generadas')
        break
      }

      default:
        logger.warn({ jobName }, 'Cron: job desconocido')
        return
    }

    await logCronExecution(jobName, 'success', result, undefined, Date.now() - start)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ jobName, err: msg }, 'Cron fallido')
    await logCronExecution(jobName, 'failed', {}, msg, Date.now() - start)
    throw err
  }
}

export function startTaskScheduler() {
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

  void setupRepeatableJobs()

  logger.info('Scheduler de tareas iniciado')
  return worker
}

async function setupRepeatableJobs() {
  const existing = await cronQueue.getRepeatableJobs()
  for (const job of existing) {
    await cronQueue.removeRepeatableByKey(job.key)
  }

  // Generar tareas — diario a las 6:00 AM (Colombia UTC-5), filtra por create_day internamente
  await cronQueue.add('generate-tasks', {}, {
    repeat: { pattern: '0 11 * * *' },
  })

  // Recordatorios — Diario a las 7:00 AM
  await cronQueue.add('send-reminders', {}, {
    repeat: { pattern: '0 12 * * *' },
  })

  // Marcar vencidas — Diario a la 1:00 AM
  await cronQueue.add('mark-overdue', {}, {
    repeat: { pattern: '0 6 * * *' },
  })

  // Calendario tributario — diario a las 6:30 AM: crea tareas 5 días antes del vencimiento
  await cronQueue.add('tax-calendar-tasks', {}, {
    repeat: { pattern: '30 11 * * *' },
  })

  logger.info('Cron jobs registrados: generate-tasks (diario 6AM), send-reminders (diario 7AM), mark-overdue (diario 1AM), tax-calendar-tasks (diario 6:30AM)')
}
