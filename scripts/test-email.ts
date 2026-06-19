console.log('API KEY:', process.env.ZAVU_API_KEY?.slice(0, 10) + '...')

const res = await fetch('https://api.zavu.dev/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.ZAVU_API_KEY}`,
    'Content-Type':  'application/json',
  },
  body: JSON.stringify({
    to:      '+573146676688',
    channel: 'whatsapp',
    text:    'Hola! Este es un mensaje de prueba desde el backend de Paola 🚀',
  }),
})

const data = await res.json()
console.log('Status:', res.status)
console.log('Response:', JSON.stringify(data, null, 2))
