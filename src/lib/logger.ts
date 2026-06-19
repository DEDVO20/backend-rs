import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

let transport: pino.TransportSingleOptions | undefined

if (isDev) {
  try {
    require.resolve('pino-pretty')
    transport = { target: 'pino-pretty', options: { colorize: true } }
  } catch {}
}

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  ...(transport ? { transport } : {}),
})
