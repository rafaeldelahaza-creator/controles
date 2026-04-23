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

function readSheet(token, sheetId, sheetName, range) {
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

// Detecta si la fila usa el formato nuevo (5 cols/pregunta) o el antiguo (3 cols/pregunta)
// Formato antiguo: P | R | ✓  (3 cols)
// Formato nuevo:   P | R | ✓ | pts | maxPts  (5 cols)
function detectColStride(row) {
  // A partir de col 5, si col 8 parece un número asumimos stride=5, si no stride=3
  const val = (row[8] || '').toString().replace(',', '.');
  if (val !== '' && !isNaN(parseFloat(val))) return 5;
  return 3;
}

// Agrupa por texto de pregunta (ignora el orden shuffle de cada alumno)
// Estructura fila antigua: Alumno|Control|Fecha|Hora|Nota | P1texto|R1alumno|✓1 | P2texto|R2alumno|✓2 | ...
// Estructura fila nueva:   Alumno|Control|Fecha|Hora|Nota | P1texto|R1alumno|✓1|pts1|max1 | ...
function buildQuestionStats(rows, quizTitle) {
  const statsMap = {};

  for (const row of rows) {
    if ((row[1] || '').trim() !== quizTitle) continue;
    const stride = detectColStride(row);

    let col = 5;
    while (col + 2 <= row.length) {
      const texto     = (row[col]     || '').trim();
      const resultado = (row[col + 2] || '').trim().toLowerCase();
      col += stride;
      if (!texto) continue;

      const key = texto.substring(0, 80).toLowerCase();
      if (!statsMap[key]) {
        statsMap[key] = { text: texto, si: 0, no: 0, parcial: 0, total: 0 };
      }
      statsMap[key].total++;
      if (resultado === 'sí' || resultado === 'si') statsMap[key].si++;
      else if (resultado === 'parcial')             statsMap[key].parcial++;
      else                                          statsMap[key].no++;
    }
  }

  return Object.values(statsMap)
    .filter(q => q.total > 0)
    .map(q => ({
      text:    q.text,
      si:      q.si,
      parcial: q.parcial,
      no:      q.no,
      total:   q.total,
      pct:     Math.round(((q.si + q.parcial * 0.5) / q.total) * 100)
    }))
    .sort((a, b) => a.pct - b.pct);
}

// Extrae las respuestas individuales de cada alumno/a para el control dado
// Devuelve: [{ name, answers: [{ question, answer, result, pts, maxPts }] }]
function buildStudentAnswers(rows, quizTitle) {
  const students = [];

  for (const row of rows) {
    if ((row[1] || '').trim() !== quizTitle) continue;

    const name = (row[0] || '').trim();
    if (!name) continue;

    const stride = detectColStride(row);
    const answers = [];
    let col = 5;
    let qNum = 1;
    while (col + 2 <= row.length) {
      const question = (row[col]     || '').trim();
      const answer   = (row[col + 1] || '').trim();
      const result   = (row[col + 2] || '').trim().toLowerCase();
      const pts      = stride === 5 ? parseFloat((row[col + 3] || '').toString().replace(',', '.')) : undefined;
      const maxPts   = stride === 5 ? parseFloat((row[col + 4] || '').toString().replace(',', '.')) : undefined;
      col += stride;
      if (!question) continue;

      answers.push({
        num: qNum++,
        question,
        answer,
        result,
        ...(isNaN(pts)    ? {} : { pts }),
        ...(isNaN(maxPts) ? {} : { maxPts })
      });
    }

    students.push({ name, answers });
  }

  return students;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const email      = process.env.GOOGLE_SERVICE_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sheetId    = process.env.GOOGLE_SHEET_ID;

  if (!email || !privateKey || !sheetId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  const quizTitle = (event.queryStringParameters?.quiz || '').trim();
  if (!quizTitle) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing quiz parameter' }) };
  }

  const clsParam = (event.queryStringParameters?.cls || '').trim();

  try {
    const token = await getAccessToken(email, privateKey);

    // 1) Hoja principal → notas
    const mainRows = await readSheet(token, sheetId, 'Hoja 1', 'A2:H');
    const submissions = mainRows
      .filter(r => (r[2] || '').trim() === quizTitle)
      .map(r => ({
        name:        (r[0] || '').trim(),
        cls:         (r[1] || '').trim(),
        score:       parseFloat((r[3] || '').toString().replace(',', '.')) || 0,
        date:        r[4] || '',
        time:        r[5] || '',
        tabSwitches: parseInt(r[6]) || 0,
        blurCount:   parseInt(r[7]) || 0
      }));

    // 2) Hoja de respuestas → stats por pregunta + detalle por alumno/a
    const clsHint = clsParam || (submissions[0]?.cls || '');
    let respSheet = null;
    if      (clsHint.includes('5')) respSheet = 'Respuestas 5°';
    else if (clsHint.includes('6')) respSheet = 'Respuestas 6°';

    let questionStats  = [];
    let studentAnswers = [];
    if (respSheet) {
      // CB cubre hasta 15 preguntas × 5 cols + 5 cols iniciales = col 80
      const respRows = await readSheet(token, sheetId, respSheet, 'A2:CB');
      questionStats  = buildQuestionStats(respRows, quizTitle);
      studentAnswers = buildStudentAnswers(respRows, quizTitle);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ ok: true, submissions, questionStats, studentAnswers })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
