const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

async function getWeather(location, unit) {
  try {
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}`);
    const geoData = await geoRes.json();

    if (!geoData || !geoData[0]) {
      return `Не удалось найти координаты для ${location}`;
    }

    const lat = geoData[0].lat;
    const lon = geoData[0].lon;

    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&temperature_unit=${unit === 'f' ? 'fahrenheit' : 'celsius'}`);
    const weatherData = await weatherRes.json();

    const temp = weatherData.current?.temperature_2m;

    if (temp === undefined) {
      return `Не удалось получить данные о погоде в ${location}`;
    }

    const suffix = unit === 'f' ? '°F' : '°C';
    return `Сейчас в ${location} около ${temp}${suffix}.`;
  } catch (err) {
    return `Произошла ошибка при получении погоды: ${err.message}`;
  }
}

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

app.get('/submit-tool-outputs', async (req, res) => {
  const { run_id, thread_id, tool_call_id, tool_name, args } = req.query;

  process.stdout.write(`🔧 Обработка функции ${tool_name}...\n`);

  let output = '';

  if (tool_name === 'get_weather') {
    const parsed = JSON.parse(args);
    output = await getWeather(parsed.location, parsed.unit);
  } else {
    output = 'Функция не найдена';
  }

  try {
    const result = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}/submit_tool_outputs`,
      {
        tool_outputs: [
          {
            tool_call_id,
            output
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ success: true, data: result.data });
  } catch (error) {
    process.stdout.write(`❌ Ошибка при submit_tool_outputs: ${error.message}\n`);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
