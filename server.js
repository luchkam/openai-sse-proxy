const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Новый endpoint для создания потока
app.get('/new-thread', async (req, res) => {
  process.stdout.write('Создание нового потока...\n'); // Логируем начало
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
    process.stdout.write(`Новый thread_id создан: ${response.data.id}\n`); // Логируем успешный ответ
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`Ошибка при создании thread_id: ${err.message}\n`); // Логируем ошибку
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// SSE endpoint для генерации и потоковой передачи ответа
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    process.stdout.write('Ошибка: отсутствует thread_id\n'); // Логируем отсутствие thread_id
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  process.stdout.write(`Запрос к OpenAI с thread_id: ${threadId}, сообщение: ${userMessage}\n`); // Логируем начало запроса

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

    run.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr !== '[DONE]') {
            res.write(`data: ${jsonStr}\n\n`);
            process.stdout.write(`Отправлено: ${jsonStr}\n`); // Логируем отправку данных
          }
        }
      }
    });

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
      process.stdout.write('Поток завершен\n'); // Логируем завершение потока
    });

  } catch (error) {
    process.stdout.write(`Ошибка в /ask: ${error.message}\n`); // Логируем ошибку
    console.error('Ошибка в /ask:', error.message);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
    authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
  },
  timeout: 15000,
  retries: 6
};

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function searchTours(params) {
  const formatDate = (dateStr) => {
    const [day, month, year] = dateStr.split('.');
    return `${day}.${month}.${year}`;
  };

  const searchParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    departure: params.departure,
    country: params.country,
    datefrom: formatDate(params.datefrom),
    dateto: formatDate(params.dateto),
    nightsfrom: params.nightsfrom,
    nightsto: params.nightsto,
    adults: params.adults,
    child: params.child,
    format: 'json'
  });

  const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
  const searchData = await fetchTourvisorData(searchUrl);
  const requestId = searchData?.result?.requestid;
  process.stdout.write(`\n📩 Получен requestid: ${requestId}`);
  if (!requestId) throw new Error('Не удалось получить requestid');

  const resultParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    requestid: requestId,
    format: 'json',
    type: 'status',
    operatorstatus: 1
  });

  const resultUrl = `http://tourvisor.ru/xml/result.php?${resultParams}`;
  let attempts = 0;
  let status;

  while (attempts < TOURVISOR_CONFIG.retries) {
    await delay(2000);
    const result = await fetchTourvisorData(resultUrl);
    status = result?.data?.status;
    process.stdout.write(`\n🔍 Ответ от Tourvisor (status): ${JSON.stringify(result)}`);

    if (status?.state === 'finished') break;
    attempts++;
  }

  if (status?.state !== 'finished') {
    throw new Error('Поиск не завершен за отведенное время');
  }

  const finalResultParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    requestid: requestId,
    format: 'json',
    type: 'result',
    onpage: 5
  });

  const finalUrl = `http://tourvisor.ru/xml/result.php?${finalResultParams}`;
  const finalData = await fetchTourvisorData(finalUrl);
  process.stdout.write(`\n📦 Ответ по результату поиска: ${JSON.stringify(finalData)}\n`);
  const result = finalData?.data?.result?.hotel;

  if (!result || result.length === 0) {
    throw new Error('Нет результатов поиска');
  }

  process.stdout.write(`\n✅ Найдено отелей: ${result.length}\n`);
  return result;
}

module.exports = searchTours;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
