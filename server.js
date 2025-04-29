const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Константы для Tourvisor
const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN,
    authpass: process.env.TOURVISOR_PASS,
  },
  timeout: 15000,
  retries: 6,
};

// Функция задержки
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Упрощённая обёртка для запросов с повторами
async function fetchTourvisorData(url, attempt = 1) {
  try {
    const res = await axios.get(url, { timeout: TOURVISOR_CONFIG.timeout });
    return res.data;
  } catch (err) {
    if (attempt >= TOURVISOR_CONFIG.retries) throw err;
    await delay(2000);
    return fetchTourvisorData(url, attempt + 1);
  }
}

// Новый endpoint для создания потока OpenAI
app.get('/new-thread', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );
    process.stdout.write(`\n📩 Получен requestid: ${response.data.id}`);
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`\n❌ Не удалось создать thread_id: ${err.message}`);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// SSE для общения с OpenAI
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    process.stdout.write(`\n❌ thread_id отсутствует`);
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
        responseType: 'stream',
      }
    );

    let buffer = '';

    run.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(jsonStr);
              process.stdout.write(`\n🔍 Ответ от OpenAI: ${JSON.stringify(parsed)}`);
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            } catch (e) {
              process.stdout.write(`\n⚠️ Ошибка парсинга JSON: ${e.message}`);
            }
          }
        }
      }
    });

    run.data.on('end', () => {
      process.stdout.write(`\n✅ Ответ от OpenAI завершен`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (error) {
    process.stdout.write(`\n❌ Ошибка в /ask: ${error.message}`);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

// Новый endpoint поиска туров через Tourvisor
app.get('/search-tours', async (req, res) => {
  const { country, city, datefrom, dateto, adults, child = 0 } = req.query;

  process.stdout.write(`\n📩 Параметры поиска: ${JSON.stringify(req.query)}`);

  try {
    // Формируем начальный URL поиска
    const searchParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      departure: city,
      country: country,
      datefrom: datefrom,
      dateto: dateto,
      nightsfrom: 7,
      nightsto: 10,
      adults: adults,
      child: child,
      format: 'json',
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
    const searchData = await fetchTourvisorData(searchUrl);

    const requestId = searchData?.result?.requestid;
    process.stdout.write(`\n📩 Получен requestid: ${requestId}`);

    if (!requestId) throw new Error('Не удалось получить requestid');

    // Проверяем статус поиска
    const statusParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      requestid: requestId,
      type: 'status',
      format: 'json',
      operatorstatus: 1
    });

    const statusUrl = `http://tourvisor.ru/xml/result.php?${statusParams}`;
    let attempts = 0;
    let status;

    while (attempts < TOURVISOR_CONFIG.retries) {
      await delay(2000);
      const statusData = await fetchTourvisorData(statusUrl);
      status = statusData?.data?.status;
      process.stdout.write(`\n🔍 Ответ от Tourvisor (status): ${JSON.stringify(statusData)}`);

      if (status?.state === 'finished') break;
      attempts++;
    }

    if (status?.state !== 'finished') {
      throw new Error('Поиск не завершен за отведенное время');
    }

    // Получаем финальные результаты поиска
    const resultParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      requestid: requestId,
      type: 'result',
      format: 'json',
      onpage: 5
    });

    const finalUrl = `http://tourvisor.ru/xml/result.php?${resultParams}`;
    const finalData = await fetchTourvisorData(finalUrl);

    process.stdout.write(`\n📦 Ответ по результату поиска: ${JSON.stringify(finalData)}`);

    const result = finalData?.data?.result?.hotel;
    if (!result || result.length === 0) {
      throw new Error('Нет результатов поиска');
    }

    res.json({ tours: result });

  } catch (err) {
    process.stdout.write(`\n❌ Ошибка в /search-tours: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
