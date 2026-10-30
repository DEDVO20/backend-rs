import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret } from '../src/lib/secretBox.js'

describe('secretBox (credenciales de Siigo cifradas)', () => {
  const original = process.env.SECRETS_ENCRYPTION_KEY

  beforeEach(() => { process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64') })
  afterEach(() => { process.env.SECRETS_ENCRYPTION_KEY = original })

  it('cifra y descifra sin dejar el texto plano en lo guardado', () => {
    const stored = encryptSecret('mi-access-key-secreta')
    expect(stored.startsWith('v1:')).toBe(true)
    expect(stored).not.toContain('mi-access-key-secreta')
    expect(decryptSecret(stored)).toBe('mi-access-key-secreta')
  })

  it('cada cifrado es distinto (IV aleatorio)', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'))
  })

  it('rechaza datos alterados o una clave distinta', () => {
    const stored = encryptSecret('clave')
    const [v, iv, tag, data] = stored.split(':')
    const tampered = [v, iv, tag, Buffer.from('otra cosa').toString('base64')].join(':')
    expect(() => decryptSecret(tampered)).toThrow()

    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    expect(() => decryptSecret(stored)).toThrow()
    void data
  })

  it('exige una clave de 32 bytes', () => {
    process.env.SECRETS_ENCRYPTION_KEY = 'corta'
    expect(() => encryptSecret('x')).toThrow(/SECRETS_ENCRYPTION_KEY/)
  })
})
