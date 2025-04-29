// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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
    process.stdout.write(`\n⏳ Повторная попытка запроса к Tourvisor (${attempt})...`);
    await delay(2000);
    return fetchTourvisorData(url, attempt + 1);
  }
}

// Endpoint для создания нового потока OpenAI
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
    process.stdout.write(`\n📩 Новый thread_id создан: ${response.data.id}`);
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`\n❌ Ошибка создания thread_id: ${err.message}`);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// SSE endpoint для общения с OpenAI
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  process.stdout.write(`\n➡️ Получено сообщение от пользователя: ${message}`);

  if (!thread_id) {
    process.stdout.write(`\n❌ Ошибка: отсутствует thread_id`);
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [{ role: 'user', content: message }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
        responseType: 'stream'
      }
    );

    let buffer = '';
    run.data.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(jsonStr);
              process.stdout.write(`\n🔍 Частичный ответ от OpenAI: ${JSON.stringify(parsed)}`);
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            } catch (e) {
              process.stdout.write(`\n⚠️ Ошибка парсинга ответа OpenAI: ${e.message}`);
            }
          }
        }
      }
    });

    run.data.on('end', () => {
      process.stdout.write(`\n✅ Потоковый ответ OpenAI завершен`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (error) {
    process.stdout.write(`\n❌ Ошибка запроса к OpenAI: ${error.message}`);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

// Новый endpoint для поиска туров через Tourvisor
app.get('/search-tours', async (req, res) => {
  process.stdout.write(`\n📩 Запрос на поиск тура от Assistant: ${JSON.stringify(req.query)}`);
  const { country, city, datefrom, dateto, adults, child = 0 } = req.query;

  try {
    const formatDate = (dateStr) => {
      const [day, month, year] = dateStr.split('.');
      return `${day}.${month}.${year}`;
    };

    const searchParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      departure: city,
      country: country,
      datefrom: formatDate(datefrom),
      dateto: formatDate(dateto),
      nightsfrom: 7,
      nightsto: 10,
      adults: adults,
      child: child,
      format: 'json'
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
    process.stdout.write(`\n🌍 Отправляем запрос в Tourvisor: ${searchUrl}`);

    const searchData = await fetchTourvisorData(searchUrl);
    const requestId = searchData?.result?.requestid;

    if (!requestId) throw new Error('Не удалось получить requestid от Tourvisor');
    process.stdout.write(`\n📩 Получен requestid: ${requestId}`);

    const statusParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      requestid: requestId,
      format: 'json',
      type: 'status',
      operatorstatus: 1
    });

    const statusUrl = `http://tourvisor.ru/xml/result.php?${statusParams}`;
    let attempts = 0;
    let status;

    while (attempts < TOURVISOR_CONFIG.retries) {
      await delay(2000);
      const result = await fetchTourvisorData(statusUrl);
      status = result?.data?.status;
      process.stdout.write(`\n🔍 Статус поиска: ${JSON.stringify(status)}`);

      if (status?.state === 'finished') break;
      attempts++;
    }

    if (status?.state !== 'finished') throw new Error('Поиск не завершился вовремя');

    const resultParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      requestid: requestId,
      format: 'json',
      type: 'result',
      onpage: 5
    });

    const resultUrl = `http://tourvisor.ru/xml/result.php?${resultParams}`;
    process.stdout.write(`\n🌍 Получаем результаты поиска: ${resultUrl}`);

    const finalData = await fetchTourvisorData(resultUrl);
    const hotels = finalData?.data?.result?.hotel;

    if (!hotels || hotels.length === 0) {
      throw new Error('Нет отелей в результатах поиска');
    }

    process.stdout.write(`\n✅ Найдено отелей: ${hotels.length}`);

    const tours = hotels.map(hotel => ({
      name: hotel.hotelname,
      price: hotel.price,
      country: hotel.countryname,
      rating: hotel.hotelrating,
      link: hotel.fulldesclink,
      picture: hotel.picturelink,
      description: hotel.hoteldescription
    }));

    res.json({ tours });

  } catch (error) {
    process.stdout.write(`\n❌ Ошибка поиска туров: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`\n✅ Сервер запущен на порту ${PORT}`);
});
