const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const headers = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'OpenAI-Beta': 'assistants=v2',
};

app.get('/new-thread', async (req, res) => {
  try {
    const response = await axios.post('https://api.openai.com/v1/threads', {}, { headers });
    process.stdout.write(`Новый thread_id создан: ${response.data.id}\n`);
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`Ошибка при создании thread_id: ${err.message}\n`);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

const getWeather = async (location, unit) => {
  try {
    const geo = await axios.get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`);
    const { latitude, longitude } = geo.data.results[0];
    const weather = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m&temperature_unit=${unit === 'c' ? 'celsius' : 'fahrenheit'}`);
    return { temperature: weather.data.current.temperature_2m, wind_speed: weather.data.current.wind_speed_10m, unit: unit === 'c' ? '°C' : '°F', location };
  } catch (e) {
    process.stdout.write(`Ошибка погоды: ${e.message}\n`);
    return { error: "Не удалось получить погоду." };
  }
};

app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  if (!thread_id) return res.status(400).json({ error: 'thread_id отсутствует' });

  try {
    const runRes = await axios.post(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      assistant_id: process.env.ASSISTANT_ID,
      stream: false,
      additional_messages: [{ role: 'user', content: message }],
    }, { headers });

    const run = runRes.data;
    process.stdout.write(`\n🔍 Run ${run.id} - status: ${run.status}\n`);

    if (run.status === 'requires_action') {
      const toolCalls = run.required_action.submit_tool_outputs.tool_calls;
      const outputs = [];

      for (const call of toolCalls) {
        if (call.function.name === 'get_weather') {
          const args = JSON.parse(call.function.arguments);
          const result = await getWeather(args.location, args.unit);
          outputs.push({ tool_call_id: call.id, output: JSON.stringify(result) });
        }
      }

      await axios.post(`https://api.openai.com/v1/threads/${thread_id}/runs/${run.id}/submit_tool_outputs`, {
        tool_outputs: outputs
      }, { headers });

      // после submit запускаем второй run со stream
      const secondRun = await axios.post(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true
      }, { headers, responseType: 'stream' });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      secondRun.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr !== '[DONE]') {
              res.write(`data: ${jsonStr}\n\n`);
            }
          }
        }
      });

      secondRun.data.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
        process.stdout.write('✅ Поток завершен\n');
      });

    } else {
      // Если не требуется действие - повторно делаем stream
      const rerun = await axios.post(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true
      }, { headers, responseType: 'stream' });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      rerun.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr !== '[DONE]') {
              res.write(`data: ${jsonStr}\n\n`);
            }
          }
        }
      });

      rerun.data.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
        process.stdout.write('✅ Поток завершен (без действий)\n');
      });
    }

  } catch (err) {
    process.stdout.write(`❌ Ошибка в /ask: ${err.message}\n`);
    res.write(`data: {"error":"${err.message}"}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`));
