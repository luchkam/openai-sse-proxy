const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Новый endpoint для создания потока
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
    process.stdout.write(`Новый thread_id создан: ${response.data.id}\n`);
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`Ошибка при создании thread_id: ${err.message}\n`);
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

    run.data.on('data', async (chunk) => {
      const lines = chunk.toString().split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') {
          res.write('data: [DONE]\n\n');
          res.end();
          process.stdout.write('Поток завершен\n');
          return;
        }

        let data;
        try {
          data = JSON.parse(jsonStr);
        } catch (e) {
          continue;
        }

        if (
          data.event === 'thread.run.requires_action' &&
          data.data?.required_action?.submit_tool_outputs
        ) {
          const toolCall = data.data.required_action.submit_tool_outputs.tool_calls[0];
          const run_id = data.data.id;
          const args = JSON.parse(toolCall.function.arguments);
          const { location, unit } = args;

          process.stdout.write(`🌍 Обработка get_weather для: ${location} (${unit})\n`);

          try {
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

            await axios.post(
              `https://api.openai.com/v1/threads/${threadId}/runs/${run_id}/submit_tool_outputs`,
              {
                tool_outputs: [
                  {
                    tool_call_id: toolCall.id,
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

            process.stdout.write(`✅ Температура отправлена: ${formatted}\n`);
          } catch (err) {
            process.stdout.write(`❌ Ошибка get_weather: ${err.message}\n`);
            res.write(`data: {"error":"${err.message}"}\n\n`);
            res.end();
            return;
          }
        }

        if (data.event === 'thread.message.delta') {
          const content = data.delta?.content?.[0]?.text?.value;
          if (content) {
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
            process.stdout.write(`📤 ${content}\n`);
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
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`);
});
