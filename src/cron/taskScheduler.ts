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

/**
 * Ejecuta una sincronización de Siigo para cada cuenta conectada (Finto y empresas), una tras otra.
 * Un fallo en una cuenta no detiene las demás; el job falla solo si fallaron todas.
 */
async function forEachSiigoConnection(
  label: string,
  run: (connectionId: string) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const { SiigoConnections } = await import('../modules/siigo/siigo.connections.js')
  const targets = await SiigoConnections.syncTargets()
  if (!targets.length) return { skipped: true, reason: 'No hay conexiones de Siigo activas con credenciales' }

  const results: Record<string, unknown> = {}
  let failed = 0
  for (const conn of targets) {
    try {
      results[conn.label] = await run(conn.id)
    } catch (err: any) {
      // Una sync manual en curso no es un fallo del cron
      if (err?.statusCode === 409) {
        results[conn.label] = { skipped: true, reason: err.message }
        continue
      }
      failed++
      results[conn.label] = { error: err.message }
      logger.error({ connection: conn.label, err: err.message }, `Cron: ${label} de Siigo fallido`)
    }
  }
  logger.info({ results }, `Cron: ${label} de Siigo procesado en ${targets.length} cuenta(s)`)
  if (failed === targets.length) throw new Error(`${label} de Siigo falló en todas las cuentas`)
  return results
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

      case 'tax-calendar-reminders': {
        const { AccountingService } = await import('../modules/accounting/accounting.service.js')
        result = await AccountingService.sendTaxReminders()
        logger.info({ result }, 'Cron: recordatorios de calendario tributario enviados')
        break
      }

      case 'participations-monthly-oc': {
        const { ParticipationsService } = await import('../modules/participations/participations.service.js')
        result = await ParticipationsService.generateMonthlyOCs()
        logger.info({ result }, 'Cron: OC mensuales de participaciones generadas')
        break
      }

      case 'siigo-daily-sync': {
        const { SiigoService } = await import('../modules/siigo/siigo.service.js')
        result = await forEachSiigoConnection('facturación', async id => {
          const log = await SiigoService.syncFromSiigo({ connectionId: id, mode: 'incremental', days: 15 })
          return { start_date: log.start_date, end_date: log.end_date, invoices: log.invoices_count, credit_notes: log.credit_notes_count, lines: log.lines_count }
        })
        break
      }

      case 'siigo-daily-collections': {
        const { SiigoCollectionsService } = await import('../modules/siigo/siigo.collections.service.js')
        result = await forEachSiigoConnection('recaudo', async id => {
          const log = await SiigoCollectionsService.syncFromSiigo({ connectionId: id })
          return { start_date: log.start_date, end_date: log.end_date, vouchers: log.vouchers_count, lines: log.lines_count, total_applied: log.total_applied }
        })
        break
      }

      case 'siigo-daily-trial-balance': {
        const { SiigoTrialBalanceService } = await import('../modules/siigo/siigo.trialBalance.service.js')
        result = await forEachSiigoConnection('balance de prueba', async id => {
          const log = await SiigoTrialBalanceService.syncFromSiigo({ connectionId: id, mode: 'current' })
          if (log.status === 'failed') throw new Error(log.error_message ?? 'Balance de prueba no importado')
          return { year: log.year, months_ok: log.months_ok, months_failed: log.months_failed, rows: log.rows_count }
        })
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

  // Calendario tributario — diario 6:30 AM: crea tareas según la anticipación de cada obligación
  await cronQueue.add('tax-calendar-tasks', {}, {
    repeat: { pattern: '30 11 * * *' },
  })

  // Recordatorios del calendario tributario al contador — diario 7:15 AM
  await cronQueue.add('tax-calendar-reminders', {}, {
    repeat: { pattern: '15 12 * * *' },
  })

  // OC mensuales de participaciones — día 1 de cada mes a las 6 AM Colombia (11 UTC)
  await cronQueue.add('participations-monthly-oc', {}, {
    repeat: { pattern: '0 11 1 * *' },
  })

  // Sync incremental de Siigo — diario 2:00 AM Colombia (7 UTC): solo trae desde la última sync
  await cronQueue.add('siigo-daily-sync', {}, {
    repeat: { pattern: '0 7 * * *' },
  })

  // Recaudo Siigo — diario 2:30 AM Colombia (7:30 UTC), después de la sync de facturación
  await cronQueue.add('siigo-daily-collections', {}, {
    repeat: { pattern: '30 7 * * *' },
  })

  // Balance de prueba por tercero — mes actual, diario 6:00 AM Colombia (11 UTC)
  await cronQueue.add('siigo-daily-trial-balance', {}, {
    repeat: { pattern: '0 11 * * *' },
  })

  logger.info('Cron jobs registrados: generate-tasks (diario 6AM), send-reminders (diario 7AM), mark-overdue (diario 1AM), tax-calendar-tasks (diario 6:30AM), tax-calendar-reminders (diario 7:15AM), participations-monthly-oc (día 1 6AM), siigo-daily-sync (diario 2AM), siigo-daily-collections (diario 2:30AM), siigo-daily-trial-balance (diario 6AM)')
}
