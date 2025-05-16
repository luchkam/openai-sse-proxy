const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint для создания нового потока
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

// Функция получения погоды
const getWeather = async (location, unit) => {
  try {
    const geoResponse = await axios.get(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`
    );
    const { latitude, longitude } = geoResponse.data.results[0];

    const weatherResponse = await axios.get(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m&temperature_unit=${unit === 'c' ? 'celsius' : 'fahrenheit'}`
    );

    return {
      temperature: weatherResponse.data.current.temperature_2m,
      wind_speed: weatherResponse.data.current.wind_speed_10m,
      unit: unit === 'c' ? '°C' : '°F',
      location: location,
    };
  } catch (error) {
    process.stdout.write(`Ошибка погоды: ${error.message}\n`);
    return { error: "Не удалось получить погоду. Проверьте название города." };
  }
};

// SSE endpoint
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    process.stdout.write('❌ Ошибка: отсутствует thread_id\n');
    return res.status(400).json({ error: 'thread_id отсутствует' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  process.stdout.write(`📨 Запрос к OpenAI с thread_id: ${threadId}, сообщение: ${userMessage}\n`);

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [{ role: 'user', content: userMessage }],
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
        if (jsonStr === '[DONE]') return;

        let data;
        try {
          data = JSON.parse(jsonStr);
        } catch (err) {
          if (
            jsonStr.includes('"instructions":"') ||
            jsonStr.includes('"tool_calls":["') ||
            jsonStr.includes('"arguments":"{') ||
            jsonStr.includes('"location')
          ) {
            return;
          }
          process.stdout.write(`⛔️ Ошибка парсинга JSON: ${err.message}\n`);
          process.stdout.write(`Строка: ${jsonStr}\n`);
          return;
        }

        if (
          data.event === 'thread.run.requires_action' &&
          data.data?.required_action?.type === 'submit_tool_outputs'
        ) {
          const toolCalls = data.data.required_action.submit_tool_outputs.tool_calls;
          const outputs = [];

          for (const call of toolCalls) {
            if (call.function.name === 'get_weather') {
              let args;
              try {
                args = JSON.parse(call.function.arguments);
              } catch (err) {
                process.stdout.write(`⚠️ Ошибка парсинга arguments: ${err.message}\n`);
                continue;
              }

              const weather = await getWeather(args.location, args.unit);
              outputs.push({
                tool_call_id: call.id,
                output: JSON.stringify(weather),
              });
            }
          }

          try {
            process.stdout.write(`📤 Отправка tool_outputs: ${JSON.stringify(outputs)}\n`);
            await axios.post(
              `https://api.openai.com/v1/threads/${threadId}/runs/${data.data.id}/submit_tool_outputs`,
              { tool_outputs: outputs },
              {
                headers: {
                  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                  'OpenAI-Beta': 'assistants=v2',
                },
              }
            );
            process.stdout.write('✅ submit_tool_outputs успешно отправлены\n');
          } catch (err) {
            process.stdout.write(`❌ Ошибка отправки tool_outputs: ${err.message}\n`);
          }
        }

        res.write(`data: ${jsonStr}\n\n`);
        process.stdout.write(`📤 Отправлено клиенту: ${jsonStr}\n`);
      }
    });

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
      process.stdout.write('✅ Поток завершен\n');
    });

    // Автоматически проверим, есть ли незавершённые действия
    runAndCheckForActions(threadId);
  } catch (error) {
    process.stdout.write(`❌ Ошибка в /ask: ${error.message}\n`);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

// Фоновая проверка незавершённых действий
async function runAndCheckForActions(threadId) {
  try {
    const runsResponse = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    const runs = runsResponse.data.data;
    for (const run of runs) {
      process.stdout.write(`🔍 Run ${run.id} - status: ${run.status}\n`);
      if (run.status === 'requires_action') {
        process.stdout.write(`⚙️ Этот run требует submit_tool_outputs: ${JSON.stringify(run.required_action)}\n`);
      }
    }
  } catch (err) {
    process.stdout.write(`❌ Ошибка проверки runs: ${err.message}\n`);
  }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`);
});
