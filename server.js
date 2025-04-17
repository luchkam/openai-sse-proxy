// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(cors());
app.use(express.json());

const TOURVISOR_AUTH = {
  authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
  authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
};

app.get('/new-thread', async (req, res) => {
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
    res.json({ thread_id: response.data.id });
  } catch (err) {
    console.error('Ошибка при создании треда:', err.message);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// ======== Tourvisor API helpers ========
async function getTourvisorResults(requestId) {
  const baseUrl = 'http://tourvisor.ru/xml/result.php';
  const statusUrl = `${baseUrl}?${new URLSearchParams({
    ...TOURVISOR_AUTH,
    requestid: requestId,
    type: 'status',
    format: 'json'
  })}`;

  let attempts = 0;
  while (attempts < 5) {
    try {
      const statusRes = await axios.get(statusUrl);
      if (statusRes.data?.status?.state === 'finished') break;
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    } catch (err) {
      console.error('Ошибка проверки статуса:', err.message);
      return null;
    }
  }

  const results = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const resultUrl = `${baseUrl}?${new URLSearchParams({
        ...TOURVISOR_AUTH,
        requestid: requestId,
        format: 'json',
        page: page,
        onpage: 10
      })}`;

      const resultRes = await axios.get(resultUrl);
      const hotels = resultRes.data?.result?.hotel;
      if (!hotels || !hotels.length) break;
      results.push(...hotels);
    } catch (err) {
      console.error(`Ошибка при получении страницы ${page}:`, err.message);
      break;
    }
  }
  return results;
}

async function handleFunctionCall(threadId, funcCall) {
  if (funcCall.name !== 'search_tours') return null;

  try {
    const args = JSON.parse(funcCall.arguments);
    console.log('🔍 Параметры поиска:', args);

    const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams({
      ...TOURVISOR_AUTH,
      departure: args.departure,
      country: args.country,
      datefrom: args.datefrom,
      dateto: args.dateto,
      nightsfrom: args.nightsfrom || 7,
      nightsto: args.nightsto || 10,
      adults: args.adults || 2,
      child: args.child || 0,
      format: 'json'
    })}`;

    const searchRes = await axios.get(searchUrl);
    const requestId = searchRes.data?.result?.requestid;
    if (!requestId) return '❌ Не удалось запустить поиск. Попробуйте позже.';

    const hotels = await getTourvisorResults(requestId);
    if (!hotels?.length) return '😞 По вашему запросу туров не найдено.';

    const allTours = hotels.flatMap(h => 
      Array.isArray(h.tours?.tour) ? h.tours.tour : [h.tours?.tour].filter(Boolean)
    );

    const topTours = allTours.sort((a, b) => a.price - b.price).slice(0, 3);

    return topTours.map((tour, i) => 
      `${i + 1}. 🏨 ${tour.hotelname || 'Отель не указан'}\n` +
      `   ✈️ ${tour.flydate}, ${tour.nights} ночей\n` +
      `   🍽 ${tour.mealrussian || 'Питание не указано'}\n` +
      `   💰 От ${tour.price?.toLocaleString() || '---'} KZT`
    ).join('\n\n');

  } catch (err) {
    console.error('❌ Ошибка в search_tours:', err.message);
    return '⚠️ Ошибка при поиске. Попробуйте позже.';
  }
}

app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  if (!thread_id) return res.status(400).json({ error: 'Отсутствует thread_id' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const initialRun = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: false,
        additional_messages: [{ role: 'user', content: message }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        }
      }
    );

    let runId = initialRun.data.id;

    // Получаем результат run-а (проверка на function_call)
    let runResult;
    for (let i = 0; i < 20; i++) {
      const runStatus = await axios.get(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${runId}`,
        { headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
        }}
      );
      if (runStatus.data.status === 'completed' || runStatus.data.status === 'requires_action') {
        runResult = runStatus.data;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (runResult?.required_action?.type === 'submit_tool_outputs') {
      const funcCall = runResult.required_action.submit_tool_outputs.tool_calls[0].function;
      const toolResult = await handleFunctionCall(thread_id, funcCall);

      await axios.post(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${runId}/submit_tool_outputs`,
        {
          tool_outputs: [
            {
              tool_call_id: runResult.required_action.submit_tool_outputs.tool_calls[0].id,
              output: toolResult,
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );

      const finalRun = await axios.post(
        `https://api.openai.com/v1/threads/${thread_id}/runs`,
        { assistant_id: process.env.ASSISTANT_ID, stream: true },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          },
          responseType: 'stream'
        }
      );

      finalRun.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') res.end();
            else sendEvent(JSON.parse(jsonStr));
          }
        });
      });

    } else {
      sendEvent({ error: 'Нет вызова функции или данных для вывода.' });
      res.end();
    }

  } catch (err) {
    console.error('🔥 Ошибка в /ask:', err.message);
    sendEvent({ error: 'Ошибка сервера' });
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
