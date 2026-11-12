// Bot OFICIAL de WhatsApp con IA para "La Bodega de Don Lucho"
// Usa: WhatsApp Cloud API (Meta) + Claude API. Pensado para correr 24/7 en un servidor (Render, Railway, etc.)
//
// - Responde libremente con IA (sin menús).
// - Toma pedidos y se los avisa a Don Lucho.
// - Si el tema necesita a Don Lucho, le avisa y se pausa en ese chat.
// - (Modo Coexistence) Si Don Lucho responde desde su app WhatsApp Business,
//   el bot se calla en ese chat por un rato. "#bot off" / "#bot on" desde la app.

const express = require('express');

// ===== VARIABLES DE ENTORNO (se configuran en el servidor) =====
const {
  WHATSAPP_TOKEN,        // token de acceso de Meta
  PHONE_NUMBER_ID,       // ID del número de WhatsApp (en Meta for Developers)
  VERIFY_TOKEN,          // una palabra secreta que tú inventas, ej: donlucho2026
  ANTHROPIC_API_KEY,     // clave de Claude
  NUMERO_DON_LUCHO,      // número personal de Don Lucho para avisos, ej: 51987654321 (opcional)
  GRAPH_VERSION = 'v23.0',
  PORT = 3000,
} = process.env;

const MINUTOS_PAUSA = 30;
const MODELO = 'claude-haiku-5-5';

// ===== DATOS DE LA BODEGA (edita aquí) =====
const INFO_BODEGA = `
Nombre: Bodega de Don Lucho
Dirección: Jr. Los Olivos 245 (frente al parque)
Horario de atención en tienda: lunes a domingo, 7:00 am a 10:00 pm
(Por WhatsApp se pueden dejar pedidos a cualquier hora; los de la noche se entregan al abrir.)
Delivery: gratis en compras desde S/ 20, solo por la zona (5 cuadras a la redonda)
Pagos: efectivo, Yape y Plin

Productos y precios:
- Arroz Costeño 1 kg: S/ 4.50
- Azúcar rubia 1 kg: S/ 4.00
- Aceite Primor 1 L: S/ 10.50
- Leche Gloria lata grande: S/ 4.20
- Huevos (1 kg): S/ 8.50
- Pan francés: S/ 0.30 c/u
- Inca Kola 1.5 L: S/ 7.00
- Coca Cola 1.5 L: S/ 7.00
- Fideos Don Vittorio 500 g: S/ 3.80
- Atún Florida: S/ 6.50
`;

const PROMPT_SISTEMA = `Atiendes el WhatsApp de la Bodega de Don Lucho.
Hablas en nombre de la bodega, de forma cálida, cercana y breve (2-3 oraciones), como un bodeguero amable del barrio.
Usa trato cordial ("vecino", "vecina", "casero") sin exagerar.

Información de la bodega:
${INFO_BODEGA}

Reglas:
- Usa SOLO los productos y precios de la lista. Si preguntan por algo que no está, di que vas a confirmar si hay y termina con [AVISAR_DUENO].
- Si el cliente quiere hacer un pedido: confirma productos y cantidades, calcula el total,
  pregunta su dirección y forma de pago. Cuando tengas todo, confirma el pedido y termina tu mensaje con:
  [PEDIDO] seguido de un resumen en una línea (productos, total, dirección, forma de pago).
- Si es un reclamo, piden fiado, un descuento especial o algo que no puedes resolver, di amablemente que Don Lucho le responde pronto y termina con [AVISAR_DUENO].
- Si alguien pregunta sinceramente si eres un bot o una persona, responde con la verdad: eres el asistente virtual de la bodega.
- No inventes promociones, precios ni productos.`;
// ===========================================

const historiales = {};
const pausados = {};
const procesados = new Set(); // evita responder dos veces el mismo mensaje

const estaPausado = (id) => pausados[id] && Date.now() < pausados[id];
const pausar = (id, min = MINUTOS_PAUSA) => { pausados[id] = Date.now() + min * 60 * 1000; };

async function preguntarIA(chatId, texto) {
  if (!historiales[chatId]) historiales[chatId] = [];
  const h = historiales[chatId];
  h.push({ role: 'user', content: texto });
  while (h.length > 20) h.shift();
  while (h.length && h[0].role !== 'user') h.shift();

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODELO, max_tokens: 600, system: PROMPT_SISTEMA, messages: h }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Claude: ' + JSON.stringify(data));

  const respuesta = data.content[0].text;
  h.push({ role: 'assistant', content: respuesta });
  return respuesta;
}

async function enviarWhatsApp(para, texto) {
  const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: para,
      type: 'text',
      text: { body: texto },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) console.error('Error enviando a', para, JSON.stringify(data));
  return resp.ok;
}

async function marcarLeido(messageId) {
  await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {});
}

async function avisarADonLucho(texto) {
  if (!NUMERO_DON_LUCHO) { console.log('AVISO (sin número configurado):', texto); return; }
  const ok = await enviarWhatsApp(NUMERO_DON_LUCHO, texto);
  if (!ok) console.log('No se pudo avisar a Don Lucho. Aviso:', texto);
}

async function atenderMensaje(msg, nombreCliente) {
  const de = msg.from;
  if (procesados.has(msg.id)) return;
  procesados.add(msg.id);
  if (procesados.size > 5000) procesados.clear();

  if (msg.type !== 'text') {
    await enviarWhatsApp(de, 'Por ahora solo puedo leer mensajes de texto, casero. ¿Me lo escribes por favor? 🙏');
    return;
  }
  const texto = msg.text.body;
  if (estaPausado(de)) { console.log(`(pausado) ${de}: ${texto}`); return; }

  console.log(`📩 ${de}: ${texto}`);
  marcarLeido(msg.id);

  let respuesta = await preguntarIA(de, texto);

  let resumenPedido = null;
  const i = respuesta.indexOf('[PEDIDO]');
  if (i !== -1) {
    resumenPedido = respuesta.slice(i + 8).trim();
    respuesta = respuesta.slice(0, i).trim();
  }
  const necesitaDueno = respuesta.includes('[AVISAR_DUENO]');
  respuesta = respuesta.replace('[AVISAR_DUENO]', '').trim();

  if (respuesta) await enviarWhatsApp(de, respuesta);
  console.log(`🤖 ${respuesta}`);

  const cliente = nombreCliente || de;
  if (resumenPedido) {
    await avisarADonLucho(`🛒 NUEVO PEDIDO de ${cliente} (+${de}):\n${resumenPedido}`);
  }
  if (necesitaDueno) {
    pausar(de, 24 * 60);
    await avisarADonLucho(`🔔 ${cliente} (+${de}) necesita que lo atiendas.\nÚltimo mensaje: "${texto}"`);
  }
}

// Mensajes que Don Lucho envía desde su app WhatsApp Business (modo Coexistence)
function manejarEcoDelDueno(eco) {
  const chatId = eco.to;
  const texto = (eco.text?.body || '').trim().toLowerCase();
  if (texto === '#bot on') { delete pausados[chatId]; console.log(`▶️ Bot activo en ${chatId}`); return; }
  if (texto === '#bot off') { pausar(chatId, 24 * 60); console.log(`⏸️ Bot apagado en ${chatId}`); return; }
  pausar(chatId);
  console.log(`🙋 Don Lucho atiende ${chatId}, bot en pausa ${MINUTOS_PAUSA} min`);
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Bot de la Bodega de Don Lucho funcionando ✅'));

// Verificación del webhook (Meta lo llama una vez al configurarlo)
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('Webhook verificado ✅');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Aquí llegan los mensajes
app.post('/webhook', (req, res) => {
  res.sendStatus(200); // responder rápido a Meta
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        if (change.field === 'smb_message_echoes') {
          for (const eco of value.message_echoes || []) manejarEcoDelDueno(eco);
          continue;
        }

        const contactos = value.contacts || [];
        for (const msg of value.messages || []) {
          const nombre = contactos.find((c) => c.wa_id === msg.from)?.profile?.name;
          atenderMensaje(msg, nombre).catch((e) => console.error('Error:', e.message));
        }
      }
    }
  } catch (e) {
    console.error('Error procesando webhook:', e.message);
  }
});

app.listen(PORT, () => console.log(`✅ Servidor escuchando en el puerto ${PORT}`));
