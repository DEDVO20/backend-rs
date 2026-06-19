import { createHmac } from 'crypto'

const WEBHOOK_URL = 'https://maritime-agonizing-wrinkly.ngrok-free.dev/webhooks/zavu'
const SECRET      = process.env.ZAVU_WEBHOOK_SECRET!

const event = {
  id:        'evt_test_001',
  type:      'message.inbound',
  senderId:  'snd_test',
  projectId: 'prj_test',
  data: {
    channel: 'whatsapp',
    from:    '+573146676688',
    text:    'Hola, esto es un mensaje de prueba entrante',
  },
}

const body      = JSON.stringify(event)
const timestamp = Math.floor(Date.now() / 1000)
const signed    = `${timestamp}.${body}`
const signature = createHmac('sha256', SECRET).update(signed).digest('hex')

console.log('Enviando evento al webhook...')

const res = await fetch(WEBHOOK_URL, {
  method:  'POST',
  headers: {
    'Content-Type':      'application/json',
    'x-zavu-signature':  `t=${timestamp},v1=${signature}`,
  },
  body,
})

console.log('Status:', res.status)
console.log('Response:', await res.text())
