// server.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Настройки авторизации для Tourvisor
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Функция для получения данных от Tourvisor с повторными попытками
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

// SSE endpoint для общения с OpenAI
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;

  if (!thread_id) {
    res.status(400).json({ error: 'Отсутствует thread_id' });
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
        additional_messages: [
          {
            role: 'user',
            content: message,
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
          }
        }
      }
    });

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });
  } catch (err) {
    res.write(`data: {"error":"${err.message}"}\n\n`);
    res.end();
  }
});

// Endpoint поиска туров через Assistant Function
app.get('/search-tours', async (req, res) => {
  const { thread_id, run_id, tool_call_id, country, city, datefrom, dateto, adults, child = 0 } = req.query;

  if (!thread_id || !run_id || !tool_call_id) {
    res.status(400).json({ error: 'Отсутствует thread_id, run_id или tool_call_id' });
    return;
  }

  try {
    // Уведомляем OpenAI о старте обработки
    await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}/submit_tool_outputs`,
      {
        tool_outputs: [
          {
            tool_call_id,
            output: 'Поиск тура запущен',
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    // Этап 1: Поиск тура
    const searchParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      departure: city,
      country,
      datefrom,
      dateto,
      nightsfrom: 7,
      nightsto: 10,
      adults,
      child,
      format: 'json',
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
    const searchData = await fetchTourvisorData(searchUrl);
    const requestId = searchData?.result?.requestid;

    if (!requestId) throw new Error('Не удалось получить requestid от Tourvisor');

    // Этап 2: Ожидание завершения поиска
    let attempts = 0;
    let status;

    while (attempts < TOURVISOR_CONFIG.retries) {
      await delay(2000);
      const statusParams = new URLSearchParams({
        ...TOURVISOR_CONFIG.auth,
        requestid: requestId,
        type: 'status',
        format: 'json',
        operatorstatus: 1,
      });

      const statusUrl = `http://tourvisor.ru/xml/result.php?${statusParams}`;
      const statusData = await fetchTourvisorData(statusUrl);

      status = statusData?.data?.status;
      if (status?.state === 'finished') break;
      attempts++;
    }

    if (status?.state !== 'finished') {
      throw new Error('Поиск не завершен вовремя');
    }

    // Этап 3: Получение результатов
    const resultParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      requestid: requestId,
      type: 'result',
      format: 'json',
      onpage: 5,
    });

    const resultUrl = `http://tourvisor.ru/xml/result.php?${resultParams}`;
    const finalData = await fetchTourvisorData(resultUrl);
    const hotels = finalData?.data?.result?.hotel;

    if (!hotels || hotels.length === 0) {
      throw new Error('Нет доступных туров');
    }

    const tours = hotels.map((hotel) => ({
      name: hotel.hotelname,
      price: hotel.price,
      country: hotel.countryname,
      rating: hotel.hotelrating,
      link: hotel.fulldesclink,
      picture: hotel.picturelink,
      description: hotel.hoteldescription,
    }));

    res.json({ tours });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создание нового потока OpenAI
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
    res.json({ thread_id: response.data.id });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось создать новый поток' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
