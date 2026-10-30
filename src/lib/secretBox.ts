import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Cifrado simétrico de secretos guardados en la base (p. ej. access keys de Siigo).
 * AES-256-GCM con la clave de `SECRETS_ENCRYPTION_KEY` (32 bytes en base64 o hex).
 * Formato almacenado: v1:<iv b64>:<tag b64>:<datos b64>
 */

function key(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY ?? ''
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw Object.assign(
      new Error('Falta SECRETS_ENCRYPTION_KEY (32 bytes en base64 o hex) para cifrar credenciales.'),
      { statusCode: 500 },
    )
  }
  return buf
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(':')
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Secreto cifrado con formato desconocido')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}
