const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Эндпоинт для создания thread с Assistant
app.get('/new-thread', async (req, res) => {
  process.stdout.write('Создание нового потока...\n');
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
    process.stdout.write(`Новый thread_id: ${response.data.id}\n`);
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`Ошибка: ${err.message}\n`);
    res.status(500).json({ error: 'Ошибка создания thread' });
  }
});

// Эндпоинт для общения с Assistant
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  
  if (!thread_id) {
    process.stdout.write('Ошибка: нет thread_id\n');
    return res.status(400).json({ error: 'Требуется thread_id' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  process.stdout.write(`Запрос к Assistant: ${message}\n`);

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [{ role: 'user', content: message }],
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
      lines.forEach(line => {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data !== '[DONE]') {
            res.write(`data: ${data}\n\n`);
            process.stdout.write(`Данные: ${data}\n`);
          }
        }
      });
    });

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
      process.stdout.write('Поток завершен\n');
    });

  } catch (error) {
    process.stdout.write(`Ошибка: ${error.message}\n`);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

// Эндпоинт для поиска туров (GET)
app.get('/search-tours', async (req, res) => {
  const { departureId, countryId, dateFrom, nights, adults, children = 0, stars = 0, mealCode = '' } = req.query;

  // Валидация параметров
  if (!departureId || !countryId || !dateFrom || !nights || !adults) {
    process.stdout.write('❌ Не хватает обязательных параметров\n');
    return res.status(400).json({ error: 'Укажите departureId, countryId, dateFrom, nights, adults' });
  }

  process.stdout.write(`🔍 Поиск туров: ${JSON.stringify(req.query)}\n`);

  try {
    const searchParams = new URLSearchParams({
      authlogin: process.env.TOURVISOR_LOGIN,
      authpass: process.env.TOURVISOR_PASS,
      departure: departureId,
      country: countryId,
      datefrom: dateFrom,
      nightsto: nights,
      adults: adults,
      child: children,
      stars: stars,
      meal: mealCode,
      currency: 3, // Тенге
      format: 'json'
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
    process.stdout.write(`🚀 Запрос к Tourvisor: ${searchUrl}\n`);

    const { data: { requestid } } = await axios.get(searchUrl);
    process.stdout.write(`🆔 ID запроса: ${requestid}\n`);

    // 2. Получение результатов
    let searchData;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const { data: statusData } = await axios.get(
        `http://tourvisor.ru/xml/result.php?requestid=${requestid}&type=status&format=json`
      );

      if (statusData.status.state === 'finished') {
        process.stdout.write(`✅ Найдено туров: ${statusData.status.toursfound}\n`);
        const { data } = await axios.get(
          `http://tourvisor.ru/xml/result.php?requestid=${requestid}&type=result&format=json`
        );
        searchData = data;
        break;
      }
    }

    if (!searchData) {
      throw new Error('Tourvisor не ответил за 10 секунд');
    }

    // 3. Форматирование ответа
    const tours = searchData.result.hotel.slice(0, 3).map(hotel => ({
      hotel: hotel.hotelname,
      price: hotel.price,
      nights: hotel.tours[0].nights,
      date: hotel.tours[0].flydate,
      meal: hotel.tours[0].mealrussian,
      operator: hotel.tours[0].operatorname
    }));

    res.json({ tours });

  } catch (error) {
    process.stdout.write(`❌ Ошибка: ${error.message}\n`);
    res.status(500).json({ error: 'Ошибка поиска туров' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ Сервер запущен на порту ${PORT}\n`);
});
