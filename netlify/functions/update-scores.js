const https = require('https');

function getAccessToken(email, privateKey) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    })).toString('base64url');
    const crypto = require('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(privateKey, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;
    const postData = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.access_token) resolve(parsed.access_token);
        else reject(new Error(data));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Lee un rango de Sheets y devuelve las filas con sus índices reales (para saber en qué fila escribir)
function readSheetWithRows(token, sheetId, sheetName, range) {
  return new Promise((resolve, reject) => {
    const encodedRange = encodeURIComponent(`${sheetName}!${range}`);
    const path = `/v4/spreadsheets/${sheetId}/values/${encodedRange}`;
    const options = {
      hostname: 'sheets.googleapis.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).values || []); }
        catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// Actualiza una celda específica en Sheets
function updateCell(token, sheetId, sheetName, rowIndex, colIndex, value) {
  return new Promise((resolve, reject) => {
    // rowIndex es 0-based desde fila 2 (A2), así que fila real = rowIndex + 2
    const rowNum = rowIndex + 2;
    const colLetter = String.fromCharCode(65 + colIndex); // A=0, B=1, D=3...
    const cellRef = encodeURIComponent(`${sheetName}!${colLetter}${rowNum}`);
    const body = JSON.stringify({ values: [[value]] });
    const path = `/v4/spreadsheets/${sheetId}/values/${cellRef}?valueInputOption=USER_ENTERED`;
    const options = {
      hostname: 'sheets.googleapis.com',
      path,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const email      = process.env.GOOGLE_SERVICE_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sheetId    = process.env.GOOGLE_SHEET_ID;

  if (!email || !privateKey || !sheetId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  try {
    const { quiz, updates } = JSON.parse(event.body);
    // updates: [{ name, cls, score }]

    if (!quiz || !Array.isArray(updates) || updates.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos' }) };
    }

    const token = await getAccessToken(email, privateKey);

    // Leer Hoja 1 para encontrar las filas de cada alumno+control
    const rows = await readSheetWithRows(token, sheetId, 'Hoja 1', 'A2:H');

    let updated = 0;
    for (const upd of updates) {
      const cleanName = (upd.name || '').trim();
      const cleanQuiz = (quiz || '').trim();

      // Buscar la fila más reciente que coincida con nombre + control
      // (puede haber varias si entregó más de una vez — actualizamos la última)
      let lastMatchIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const rowName = (rows[i][0] || '').trim();
        const rowQuiz = (rows[i][2] || '').trim();
        if (rowName === cleanName && rowQuiz === cleanQuiz) {
          lastMatchIdx = i;
        }
      }

      if (lastMatchIdx >= 0) {
        // Columna D (índice 3) es la nota
        await updateCell(token, sheetId, 'Hoja 1', lastMatchIdx, 3, upd.score);
        updated++;
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, updated })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
