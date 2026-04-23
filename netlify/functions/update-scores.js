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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
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

function updateCell(token, sheetId, sheetName, rowIndex, colIndex, value) {
  return new Promise((resolve, reject) => {
    const rowNum = rowIndex + 2;
    // Convertir índice de columna a letra(s) — soporta columnas > Z (AA, AB...)
    let col = colIndex;
    let colStr = '';
    col++;
    while (col > 0) {
      const rem = (col - 1) % 26;
      colStr = String.fromCharCode(65 + rem) + colStr;
      col = Math.floor((col - 1) / 26);
    }
    const cellRef = encodeURIComponent(`${sheetName}!${colStr}${rowNum}`);
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

function detectStride(row) {
  const col8 = (row[8] || '').toString().replace(',', '.');
  if (!isNaN(parseFloat(col8)) && col8 !== '') {
    const col10 = row[10];
    return (col10 !== undefined && isNaN(parseFloat((col10 || '').toString().replace(',', '.')))) ? 6 : 5;
  }
  return 3;
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
    // updates: [{ name, cls, score, answers: [{num, pts}] }]
    if (!quiz || !Array.isArray(updates) || updates.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos' }) };
    }

    const token = await getAccessToken(email, privateKey);

    // ── 1) Actualizar nota en Hoja 1 ──────────────────────────────────
    const mainRows = await readSheetWithRows(token, sheetId, 'Hoja 1', 'A2:H');
    let updatedMain = 0;
    for (const upd of updates) {
      const cleanName = (upd.name || '').trim();
      const cleanQuiz = (quiz || '').trim();
      let lastIdx = -1;
      for (let i = 0; i < mainRows.length; i++) {
        if ((mainRows[i][0] || '').trim() === cleanName &&
            (mainRows[i][2] || '').trim() === cleanQuiz) lastIdx = i;
      }
      if (lastIdx >= 0) {
        await updateCell(token, sheetId, 'Hoja 1', lastIdx, 3, upd.score);
        updatedMain++;
      }
    }

    // ── 2) Actualizar pts en hojas de respuestas ───────────────────────
    const sheets = new Set();
    updates.forEach(upd => {
      const cls = (upd.cls || '').trim();
      if (cls.includes('5')) sheets.add('Respuestas 5°');
      if (cls.includes('6')) sheets.add('Respuestas 6°');
    });

    for (const respSheet of sheets) {
      const respRows = await readSheetWithRows(token, sheetId, respSheet, 'A2:CN');
      for (const upd of updates) {
        if (!Array.isArray(upd.answers) || upd.answers.length === 0) continue;
        const cleanName = (upd.name || '').trim();
        const cleanQuiz = (quiz || '').trim();

        let rowIdx = -1;
        for (let i = 0; i < respRows.length; i++) {
          if ((respRows[i][0] || '').trim() === cleanName &&
              (respRows[i][1] || '').trim() === cleanQuiz) rowIdx = i;
        }
        if (rowIdx < 0) continue;

        const stride = detectStride(respRows[rowIdx]);
        if (stride < 5) continue; // sin columnas de pts, no actualizar

        for (const ans of upd.answers) {
          // col pts = 5 (inicio preguntas) + (num-1)*stride + 3
          const ptsColIdx = 5 + (ans.num - 1) * stride + 3;
          await updateCell(token, sheetId, respSheet, rowIdx, ptsColIdx, ans.pts);
        }
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, updated: updatedMain })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
