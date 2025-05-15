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

  process.stdout.write(`\nЗапрос к OpenAI с thread_id: ${threadId}, сообщение: ${userMessage}\n`);

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

    run.data.on('data', async (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);

          if (jsonStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            res.end();
            process.stdout.write('Поток завершен\n');
            return;
          }

          buffer += jsonStr;

          try {
            const parsed = JSON.parse(buffer);
            buffer = ''; // очищаем после удачного парса

            // 🔧 Вызов функции
            if (parsed?.type === 'function_call') {
              const tool_call_id = parsed.call_id || parsed.id;
              const args = JSON.parse(parsed.arguments);
              const { location, unit } = args;

              process.stdout.write(`🛠 Вызов get_weather: ${JSON.stringify(args)}\n`);
              const output = await getWeather(location, unit);

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

              process.stdout.write(`✅ Ответ отправлен: ${output}\n`);
            }

            // 📤 Обычный текст
            if (parsed?.delta?.content) {
              const text = parsed.delta.content[0]?.text?.value || '';
              res.write(`data: ${JSON.stringify({ text })}\n\n`);
              process.stdout.write(`Отправлено: ${text}\n`);
            }
          } catch (err) {
            // Пропускаем незавершённые JSON куски
            process.stdout.write(`⚠️ Пропущен chunk (ожидаем продолжения): ${jsonStr.slice(0, 100)}...\n`);
          }
        }
      }
    });

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
      process.stdout.write('⛔️ Поток завершён (END)\n');
    });

  } catch (error) {
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
    process.stdout.write(`❌ Ошибка в /ask: ${error.message}\n`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
