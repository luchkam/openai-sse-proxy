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
    process.stdout.write('Ошибка: отсутствует thread_id\n');
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  process.stdout.write(`Запрос к OpenAI с thread_id: ${threadId}, сообщение: ${userMessage}\n`);

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

          // Пытаемся распарсить JSON
          let data;
          try {
            data = JSON.parse(jsonStr);
          } catch (e) {
            continue;
          }

          // ✅ Проверка на requires_action
          if (data.required_action && data.required_action.submit_tool_outputs) {
            const toolCall = data.required_action.submit_tool_outputs.tool_calls[0];
            const args = JSON.parse(toolCall.function.arguments);
            const { location, unit } = args;
            const tool_call_id = toolCall.id;
            const run_id = data.id;

            process.stdout.write(`🌍 Вызов функции get_weather: ${location}, ${unit}\n`);

            try {
              // Определяем координаты через Nominatim
              const geo = await axios.get('https://nominatim.openstreetmap.org/search', {
                params: {
                  q: location,
                  format: 'json',
                  limit: 1,
                },
              });

              if (!geo.data.length) throw new Error('Город не найден');

              const lat = geo.data[0].lat;
              const lon = geo.data[0].lon;

              // Получаем погоду через OpenMeteo
              const meteo = await axios.get('https://api.open-meteo.com/v1/forecast', {
                params: {
                  latitude: lat,
                  longitude: lon,
                  current: 'temperature_2m',
                },
              });

              const tempC = meteo.data.current.temperature_2m;
              const temp = unit === 'f' ? (tempC * 9) / 5 + 32 : tempC;
              const formatted = `${temp.toFixed(1)}°${unit === 'f' ? 'F' : 'C'}`;

              // Отправка результата в OpenAI
              await axios.post(
                `https://api.openai.com/v1/threads/${threadId}/runs/${run_id}/submit_tool_outputs`,
                {
                  tool_outputs: [
                    {
                      tool_call_id,
                      output: `The temperature in ${location} is ${formatted}`,
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

              process.stdout.write(`✅ Отправлен результат: ${formatted}\n`);
            } catch (err) {
              process.stdout.write(`❌ Ошибка в обработке get_weather: ${err.message}\n`);
              res.write(`data: {"error":"${err.message}"}\n\n`);
              res.end();
              return;
            }
          } else {
            // Обычные текстовые ответы
            res.write(`data: ${jsonStr}\n\n`);
            process.stdout.write(`Отправлено: ${jsonStr}\n`);
          }
        }
      }
    });

  } catch (error) {
    process.stdout.write(`Ошибка в /ask: ${error.message}\n`);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
