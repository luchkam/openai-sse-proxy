const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

async function getWeather(location, unit) {
  try {
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}`);
    const geoData = await geoRes.json();

    if (!geoData || !geoData[0]) return `Не удалось найти координаты для ${location}`;
    const lat = geoData[0].lat;
    const lon = geoData[0].lon;

    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&temperature_unit=${unit === 'f' ? 'fahrenheit' : 'celsius'}`);
    const weatherData = await weatherRes.json();

    const temp = weatherData.current?.temperature_2m;
    if (temp === undefined) return `Не удалось получить данные о погоде в ${location}`;

    const suffix = unit === 'f' ? '°F' : '°C';
    return `Сейчас в ${location} около ${temp}${suffix}.`;
  } catch (err) {
    return `Произошла ошибка при получении погоды: ${err.message}`;
  }
}

// Новый thread
app.get('/new-thread', async (req, res) => {
  try {
    const response = await axios.post('https://api.openai.com/v1/threads', {}, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
      },
    });
    console.log(`🧵 Новый thread: ${response.data.id}`);
    res.json({ thread_id: response.data.id });
  } catch (err) {
    console.error('Ошибка создания thread:', err.message);
    res.status(500).json({ error: 'Ошибка создания потока' });
  }
});

// SSE ask endpoint
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  if (!message || !thread_id) return res.status(400).json({ error: 'message и thread_id обязательны' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  console.log(`📨 Сообщение: ${message}, thread_id: ${thread_id}`);

  try {
    const response = await axios.post(
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

    const toolCalls = {};

    response.data.on('data', async (chunk) => {
      const lines = chunk.toString().split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);

        if (jsonStr === '[DONE]') {
          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
        }

        try {
          const parsed = JSON.parse(jsonStr);

          // Обычный ответ
          if (parsed?.delta?.content) {
            const text = parsed.delta.content[0]?.text?.value;
            if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }

          // Первый шаг вызова функции
          if (parsed.type === 'function_call') {
            toolCalls[parsed.id] = { ...parsed, arguments: '' };
          }

          // Дельта аргументов
          if (parsed.type === 'function_call_arguments.delta') {
            const id = parsed.item_id;
            if (!toolCalls[id]) toolCalls[id] = { arguments: '' };
            toolCalls[id].arguments += parsed.delta;
          }

          // Функция готова к запуску
          if (parsed.type === 'function_call_arguments.done') {
            const call = toolCalls[parsed.item.id];
            const args = JSON.parse(call.arguments);
            const result = await getWeather(args.location, args.unit);

            await axios.post(
              `https://api.openai.com/v1/threads/${thread_id}/runs/${parsed.response_id}/submit_tool_outputs`,
              {
                tool_outputs: [
                  {
                    tool_call_id: parsed.item.id,
                    output: result,
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

            console.log(`✅ Результат функции отправлен: ${result}`);
          }
        } catch (err) {
          console.warn(`⚠️ Пропущен chunk: ${jsonStr.slice(0, 100)}...`);
        }
      }
    });

    response.data.on('end', () => {
      res.write(`data: [DONE]\n\n`);
      res.end();
      console.log('⛔️ Поток завершён');
    });
  } catch (error) {
    console.error(`❌ Ошибка в /ask: ${error.message}`);
    res.write(`data: {"error": "${error.message}"}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
