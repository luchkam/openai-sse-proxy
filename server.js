// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

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
    const response = await axios.post('https://api.openai.com/v1/threads', {}, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
      },
    });
    res.json({ thread_id: response.data.id });
  } catch (err) {
    console.error('Ошибка при создании треда:', err.message);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

async function getTourvisorResults(requestId) {
  const url = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
    ...TOURVISOR_AUTH,
    requestid: requestId,
    format: 'json',
    page: 1,
    onpage: 1
  })}`;

  try {
    const res = await axios.get(url);
    return res.data?.result?.hotel || [];
  } catch (err) {
    console.error('Ошибка получения результатов:', err.message);
    return [];
  }
}

async function handleFunctionCall(threadId, funcCall) {
  if (funcCall.name !== 'search_tours') return null;

  try {
    const args = JSON.parse(funcCall.arguments);
    console.log('📦 Аргументы:', args);

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
    if (!requestId) return '❌ Не удалось запустить поиск.';

    const hotels = await getTourvisorResults(requestId);
    if (!hotels?.length) return '😞 По вашему запросу туров не найдено.';

    const tours = hotels.flatMap(h => Array.isArray(h.tours?.tour) ? h.tours.tour : [h.tours?.tour].filter(Boolean));
    const top = tours.slice(0, 1)[0];
    if (!top) return '😞 Туров не найдено';

    return `🏨 ${top.hotelname || 'Отель'}\n✈️ ${top.flydate}, ${top.nights} ночей\n🍽 ${top.mealrussian || 'Питание не указано'}\n💰 От ${top.price || '---'} KZT`;
  } catch (err) {
    console.error('❌ Ошибка search_tours:', err.message);
    return '⚠️ Ошибка при поиске.';
  }
}

app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  if (!thread_id) return res.status(400).json({ error: 'thread_id отсутствует' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let isFunctionCall = false;

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [{ role: 'user', content: message }]
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
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') return;

        try {
          const data = JSON.parse(jsonStr);
          if (data.function_call) {
            isFunctionCall = true;
            handleFunctionCall(thread_id, data.function_call)
              .then(result => axios.post(
                `https://api.openai.com/v1/threads/${thread_id}/messages`,
                {
                  role: 'function',
                  name: data.function_call.name,
                  content: result || 'Нет данных'
                },
                {
                  headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    'OpenAI-Beta': 'assistants=v2',
                  }
                })
              .then(() => axios.post(
                `https://api.openai.com/v1/threads/${thread_id}/runs`,
                { assistant_id: process.env.ASSISTANT_ID, stream: true },
                {
                  headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    'OpenAI-Beta': 'assistants=v2',
                  },
                  responseType: 'stream',
                }))
              .then(newRun => newRun.data.on('data', chunk => {
                chunk.toString().split('\n').forEach(line => {
                  if (line.startsWith('data: ')) sendEvent(JSON.parse(line.slice(6)));
                });
              }))
              .catch(err => {
                console.error('Ошибка function_call:', err);
                sendEvent({ error: 'Ошибка при получении тура' });
              });
          } else if (!isFunctionCall && data.delta?.content) {
            sendEvent(data);
          }
        } catch (e) {
          console.warn('Парсинг stream error:', e.message);
        }
      }
    });

    run.data.on('end', () => {
      if (!isFunctionCall) {
        sendEvent('[DONE]');
        res.end();
      }
    });
  } catch (err) {
    console.error('🔥 Ошибка /ask:', err.message);
    sendEvent({ error: err.message });
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
