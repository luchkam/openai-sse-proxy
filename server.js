const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Параметры авторизации для Tourvisor и OpenAI
const TOURVISOR_LOGIN = process.env.TOURVISOR_LOGIN;
const TOURVISOR_PASS = process.env.TOURVISOR_PASS;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;

// Новый endpoint для создания потока (OpenAI)
app.get('/new-thread', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
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

// SSE endpoint для генерации и потоковой передачи ответа (OpenAI)
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
        assistant_id: ASSISTANT_ID,
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
          Authorization: `Bearer ${OPENAI_API_KEY}`,
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
            process.stdout.write(`\n🔍 Ответ от OpenAI: ${JSON.stringify(jsonStr)}`);
            res.write(`data: ${jsonStr}\n\n`);
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

// Новый endpoint для поиска туров через Tourvisor
app.post('/search-tours', async (req, res) => {
  const { country, city, datefrom, dateto, adults, child } = req.body;

  // Формируем URL для запроса к Tourvisor API
  const searchUrl = `http://tourvisor.ru/xml/search.php?authlogin=${TOURVISOR_LOGIN}&authpass=${TOURVISOR_PASS}&departure=${city}&country=${country}&datefrom=${datefrom}&dateto=${dateto}&nightsfrom=7&nightsto=10&adults=${adults}&child=${child}&format=json`;

  try {
    const response = await axios.get(searchUrl);
    const data = response.data;

    // Логируем полученный requestid
    process.stdout.write(`\n📩 Получен requestid от TourVisor: ${data.requestid}`);
    res.json({ requestid: data.requestid });
  } catch (error) {
    process.stdout.write(`\n❌ Ошибка при поиске туров через TourVisor: ${error.message}`);
    res.status(500).json({ error: "Не удалось выполнить запрос на поиск туров" });
  }
});

// Эндпоинт для отслеживания статуса поиска туров через Tourvisor
app.get('/check-status', async (req, res) => {
  const { requestid } = req.query;

  const statusUrl = `http://tourvisor.ru/xml/result.php?authlogin=${TOURVISOR_LOGIN}&authpass=${TOURVISOR_PASS}&requestid=${requestid}&type=status`;

  try {
    const response = await axios.get(statusUrl);
    const data = response.data;

    process.stdout.write(`\n🔍 Ответ от TourVisor (status): ${JSON.stringify(data.status)}`);
    if (data.status.state === 'finished') {
      res.json({ status: 'finished', hotelsfound: data.status.hotelsfound });
    } else {
      res.json({ status: 'searching', progress: data.status.progress });
    }
  } catch (error) {
    process.stdout.write(`\n❌ Ошибка при получении статуса поиска от TourVisor: ${error.message}`);
    res.status(500).json({ error: "Не удалось получить статус поиска" });
  }
});

// Эндпоинт для получения результатов поиска туров через Tourvisor
app.get('/get-results', async (req, res) => {
  const { requestid } = req.query;

  const resultsUrl = `http://tourvisor.ru/xml/result.php?authlogin=${TOURVISOR_LOGIN}&authpass=${TOURVISOR_PASS}&requestid=${requestid}&type=result`;

  try {
    const response = await axios.get(resultsUrl);
    const data = response.data;

    process.stdout.write(`\n📦 Ответ по результату поиска: ${JSON.stringify(data)}`);

    const tours = data.result.hotel.map(hotel => ({
      name: hotel.hotelname,
      price: hotel.price,
      country: hotel.countryname,
      rating: hotel.hotelrating,
      link: hotel.fulldesclink,
    }));

    res.json({ tours });
  } catch (error) {
    process.stdout.write(`\n❌ Ошибка при получении результатов поиска от TourVisor: ${error.message}`);
    res.status(500).json({ error: "Не удалось получить результаты поиска" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
