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

app.post('/search-tours', async (req, res) => {
  const { departureId, countryId, dateFrom, nights, adults, children, stars, mealCode } = req.body;

  // Логируем запрос
  process.stdout.write(`🔍 Поиск туров: ${JSON.stringify(req.body)}\n`);

  // 1. Запуск поиска через Tourvisor API
  try {
    const searchParams = new URLSearchParams({
      authlogin: process.env.TOURVISOR_LOGIN,
      authpass: process.env.TOURVISOR_PASS,
      departure: departureId,
      country: countryId,
      datefrom: dateFrom,
      nightsto: nights,
      adults: adults,
      child: children || 0,
      stars: stars || 0,
      meal: mealCode || '',
      currency: 3, // Тенге
      format: 'json'
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
    process.stdout.write(`🚀 Запрос к Tourvisor: ${searchUrl}\n`);

    const searchResponse = await axios.get(searchUrl);
    const requestId = searchResponse.data.requestid;
    process.stdout.write(`🆔 ID запроса Tourvisor: ${requestId}\n`);

    // 2. Ожидаем завершения поиска (проверяем статус каждые 2 секунды)
    let attempts = 0;
    let searchData;

    while (attempts < 5) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const statusUrl = `http://tourvisor.ru/xml/result.php?requestid=${requestId}&type=status&format=json`;
      const statusResponse = await axios.get(statusUrl);

      if (statusResponse.data.status.state === 'finished') {
        process.stdout.write(`✅ Поиск завершен. Найдено туров: ${statusResponse.data.status.toursfound}\n`);
        // 3. Получаем результаты
        const resultUrl = `http://tourvisor.ru/xml/result.php?requestid=${requestId}&type=result&format=json`;
        searchData = (await axios.get(resultUrl)).data;
        break;
      }
      attempts++;
    }

    if (!searchData) {
      throw new Error('Превышено время ожидания ответа от Tourvisor');
    }

    // 4. Форматируем топ-3 тура для Assistant
    const topTours = searchData.result.hotel.slice(0, 3).map(hotel => ({
      hotel: hotel.hotelname,
      price: hotel.price,
      nights: hotel.tours[0].nights,
      date: hotel.tours[0].flydate,
      meal: hotel.tours[0].mealrussian,
      operator: hotel.tours[0].operatorname
    }));

    res.json({ tours: topTours });

  } catch (error) {
    process.stdout.write(`❌ Ошибка: ${error.message}\n`);
    res.status(500).json({ error: 'Не удалось найти туры' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
