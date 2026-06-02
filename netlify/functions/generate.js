const https = require('https');

// ─── RATE LIMITING EN MEMORIA ───────────────────────────────────────────────
// Se resetea con cada cold start, pero es suficiente para proteger contra
// ataques sostenidos. Límite: 15 peticiones por IP por minuto.
const requestLog = new Map();
const RATE_LIMIT  = 60;
const RATE_WINDOW = 60 * 1000; // 1 minuto en ms

function isRateLimited(ip) {
  const now    = Date.now();
  const record = requestLog.get(ip) || { count: 0, start: now };

  if (now - record.start > RATE_WINDOW) {
    // Ventana expirada → resetear
    requestLog.set(ip, { count: 1, start: now });
    return false;
  }

  if (record.count >= RATE_LIMIT) return true;

  record.count++;
  requestLog.set(ip, record);
  return false;
}

// Limpiar entradas antiguas cada 500 peticiones para evitar fuga de memoria
let cleanupCounter = 0;
function maybeCleanup() {
  if (++cleanupCounter < 500) return;
  cleanupCounter = 0;
  const cutoff = Date.now() - RATE_WINDOW * 2;
  for (const [key, val] of requestLog.entries()) {
    if (val.start < cutoff) requestLog.delete(key);
  }
}

// ─── ORÍGENES PERMITIDOS ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://keen-horse-7b3b53.netlify.app',
  'https://animated-marigold-422012.netlify.app',
  // Añade aquí tu dominio personalizado si tienes uno:
  // 'https://controles.tudominio.es',
];

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────────────
exports.handler = async function(event) {

  // 1. Solo POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // 2. Comprobación de origen (evita que webs externas usen tu función)
  const origin = (event.headers['origin'] || '').trim();
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Origen no autorizado.' })
    };
  }

  // 3. Rate limiting por IP
  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || event.headers['client-ip']
          || 'unknown';

  maybeCleanup();

  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: { 'Retry-After': '60' },
      body: JSON.stringify({ error: 'Demasiadas peticiones. Espera un momento e inténtalo de nuevo.' })
    };
  }

  // 4. API key presente
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  // 5. Validar tamaño del payload (máx. 60 KB)
  const rawBody = event.body || '';
  if (rawBody.length > 500_000) {
    return {
      statusCode: 413,
      body: JSON.stringify({ error: 'Payload demasiado grande.' })
    };
  }

  // 6. Parsear y sanear el body
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  // 7. Solo permitir los campos que necesita la app (whitelist)
  //    Esto evita que alguien envíe parámetros peligrosos a la API de Anthropic
  const allowedModels = [
    'claude-sonnet-4-20250514',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
  ];

  const model = body.model || 'claude-sonnet-4-20250514';
  if (!allowedModels.includes(model)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Modelo no permitido.' })
    };
  }

  const safeBody = {
    model,
    max_tokens: Math.min(Number(body.max_tokens) || 1000, 8000), // nunca más de 8000
    messages: body.messages,
    ...(body.system ? { system: body.system } : {}),
  };

  // 8. Llamada a la API de Anthropic
  try {
    return new Promise((resolve) => {
      const postData = JSON.stringify(safeBody);

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({
          statusCode: res.statusCode || 200,
          headers: { 'Content-Type': 'application/json' },
          body: data
        }));
      });

      req.on('error', (err) => resolve({
        statusCode: 500,
        body: JSON.stringify({ error: err.message })
      }));

      req.write(postData);
      req.end();
    });

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
