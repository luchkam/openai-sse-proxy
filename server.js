// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Проверка обязательных переменных окружения
['OPENAI_API_KEY', 'ASSISTANT_ID', 'TOURVISOR_LOGIN', 'TOURVISOR_PASS'].forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`❌ Переменная окружения ${key} не установлена`);
  }
});

const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN,
    authpass: process.env.TOURVISOR_PASS
  },
  timeout: 15000,
  retries: 6
};

let citiesList = [];
let countriesList = [];

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

async function loadDictionaries() {
  try {
    const citiesUrl = `http://tourvisor.ru/xml/list.php?${new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      type: 'departure',
      format: 'json'
    })}`;
    const countriesUrl = `http://tourvisor.ru/xml/list.php?${new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      type: 'country',
      format: 'json'
    })}`;

    const citiesData = await fetchTourvisorData(citiesUrl);
    const countriesData = await fetchTourvisorData(countriesUrl);

    citiesList = citiesData?.departure || [];
    countriesList = countriesData?.country || [];

    process.stdout.write(`\n✅ Справочники загружены: ${citiesList.length} городов, ${countriesList.length} стран`);
  } catch (err) {
    process.stdout.write(`\n❌ Ошибка загрузки справочников: ${err.message}`);
  }
}

// Загружаем справочники при старте и обновляем их раз в сутки
loadDictionaries();
setInterval(loadDictionaries, 24 * 60 * 60 * 1000);

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

// SSE endpoint для OpenAI
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  process.stdout.write(`\n➡️ Получено сообщение от пользователя: ${message}`);

  if (!thread_id) {
    process.stdout.write(`\n❌ Ошибка: thread_id отсутствует`);
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let streamAborted = false;

  req.on('close', () => {
    streamAborted = true;
    process.stdout.write(`\n⚡️ Клиент закрыл соединение`);
  });

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
      if (streamAborted) {
        run.data.destroy();
        return;
      }
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(jsonStr);
              process.stdout.write(`\n🔍 Частичный ответ: ${JSON.stringify(parsed)}`);
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            } catch (e) {
              process.stdout.write(`\n⚠️ Ошибка парсинга: ${e.message}`);
            }
          }
        }
      }
    });

    run.data.on('end', () => {
      if (!streamAborted) {
        process.stdout.write(`\n✅ Поток завершен`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    run.data.on('error', (error) => {
      process.stdout.write(`\n❌ Ошибка в потоке: ${error.message}`);
      if (!streamAborted) {
        res.write(`data: {"error":"${error.message}"}\n\n`);
        res.end();
      }
    });

  } catch (error) {
    process.stdout.write(`\n❌ Ошибка запроса: ${error.message}`);
    if (!res.headersSent) {
      res.write(`data: {"error":"${error.message}"}\n\n`);
      res.end();
    }
  }
});

// Endpoint поиска туров через Tourvisor
app.get('/search-tours', async (req, res) => {
  process.stdout.write(`\n📩 Запрос на поиск: ${JSON.stringify(req.query)}`);
  const { country, city, datefrom, dateto, adults, child = 0 } = req.query;

  if (!country || !city || !datefrom || !dateto || !adults) {
    process.stdout.write(`\n❌ Ошибка: Нехватка данных`);
    return res.status(400).json({ error: 'Обязательные параметры поиска тура не переданы' });
  }

  try {
    // Поиск кода города и страны в справочниках
    const cityEntry = citiesList.find(c => c.name.toLowerCase() === city.toLowerCase());
    const countryEntry = countriesList.find(c => c.name.toLowerCase() === country.toLowerCase());

    if (!cityEntry || !countryEntry) {
      throw new Error('Не удалось найти код города или страны в справочниках');
    }

    const searchParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      departure: cityEntry.id,
      country: countryEntry.id,
      datefrom,
      dateto,
      nightsfrom: 7,
      nightsto: 10,
      adults,
      child,
      format: 'json'
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
    process.stdout.write(`\n🌍 Запрос Tourvisor: ${searchUrl}`);

    const searchData = await fetchTourvisorData(searchUrl);
    const requestId = searchData?.result?.requestid;

    if (!requestId) throw new Error('Не удалось получить requestid');
    process.stdout.write(`\n📩 requestid: ${requestId}`);

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
      process.stdout.write(`\n🔍 Статус: ${JSON.stringify(status)}`);

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
    process.stdout.write(`\n🌍 Результаты поиска: ${resultUrl}`);

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
