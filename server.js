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

    let toolCallInfo = null;

    run.data.on('data', async (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          let parsed;
try {
  parsed = JSON.parse(jsonStr);
} catch (e) {
  process.stdout.write(`⚠️ Пропущен chunk с некорректным JSON: ${jsonStr}\n`);
  return; // или continue
}

          // Если модель вызывает функцию
          if (parsed.type === 'function_call') {
            toolCallInfo = parsed;
            const tool_call_id = parsed.call_id || parsed.id;
            const args = JSON.parse(parsed.arguments);
            const { location, unit } = args;

            const output = await getWeather(location, unit);

            // Отправка результата обратно в OpenAI
            await axios.post(
              `https://api.openai.com/v1/threads/${threadId}/runs/${parsed.run_id}/submit_tool_outputs`,
              {
                tool_outputs: [
                  {
                    tool_call_id,
                    output,
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
          } else {
            // Если обычный текст
            res.write(`data: ${jsonStr}\n\n`);
          }
        }
      }
    });

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (error) {
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
