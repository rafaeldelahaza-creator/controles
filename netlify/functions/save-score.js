const https = require('https');

function getAccessToken(email, privateKey) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
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

function appendToSheet(token, sheetId, sheetName, values) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ values });
    const range = encodeURIComponent(`${sheetName}!A:A`);
    const path = `/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;
    const options = {
      hostname: 'sheets.googleapis.com',
      path,
      method: 'POST',
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

  const email = process.env.GOOGLE_SERVICE_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!email || !privateKey || !sheetId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  try {
    const { name, cls, quiz, score, date, time, tabSwitches, blurCount, review } = JSON.parse(event.body);

    const cleanName = (name || '').trim();
    const cleanCls  = (cls  || '').trim();
    const cleanQuiz = (quiz || '').trim();

    const token = await getAccessToken(email, privateKey);

    // ── 1) Hoja principal de notas (igual que antes) ──────────────────
    await appendToSheet(token, sheetId, 'Hoja 1', [[
      cleanName, cleanCls, cleanQuiz, score, date, time,
      tabSwitches || 0, blurCount || 0
    ]]);

    // ── 2) Hoja de respuestas por clase ───────────────────────────────
    let respuestasSheet = null;
    if (cleanCls.includes('5')) respuestasSheet = 'Respuestas 5°';
    if (cleanCls.includes('6')) respuestasSheet = 'Respuestas 6°';

    if (respuestasSheet && Array.isArray(review) && review.length > 0) {
      // Fila: Alumno | Control | Fecha | Hora | Nota | P1 | R1 | ✓1 | P2 | R2 | ✓2 | …
      const row = [cleanName, cleanQuiz, date, time, score];
      review.forEach(r => {
        row.push(r.text          || '–');
        row.push(r.studentAnswer || '–');
        row.push(r.correct ? 'Sí' : r.partial ? 'Parcial' : 'No');
      });
      await appendToSheet(token, sheetId, respuestasSheet, [row]);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
