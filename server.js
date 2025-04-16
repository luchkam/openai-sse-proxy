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

// Новый thread
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
    res.status(500).json({ error: 'Не удалось создать thread' });
  }
});

// FunctionCall обработка
async function handleFunctionCall(threadId, funcCall) {
  if (funcCall.name !== 'search_tours') return null;
  try {
    const args = JSON.parse(funcCall.arguments);
    console.log('📦 Аргументы:', args);

    const auth = {
      authlogin: 'info@meridiantt.com',
      authpass: 'Mh4GdKPUtwZT',
    };

    const queryParams = new URLSearchParams({
      ...auth,
      departure: args.departure,
      country: args.country,
      datefrom: args.datefrom,
      dateto: args.dateto,
      nightsfrom: args.nightsfrom || 7,
      nightsto: args.nightsto || 10,
      adults: args.adults || 2,
      child: args.child || 0,
      format: 'json',
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${queryParams}`;
    const baseUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams(auth)}&format=json`;

    const searchRes = await axios.get(searchUrl);
    const requestId = searchRes.data?.result?.requestid;
    if (!requestId) return '❌ Поиск не запустился';

    const statusUrl = `${baseUrl}&requestid=${requestId}&type=status`;
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const statusRes = await axios.get(statusUrl);
      if (statusRes.data?.status?.state === 'finished') break;
    }

    const resultUrl = `${baseUrl}&requestid=${requestId}&type=result`;
    const resultRes = await axios.get(resultUrl);
    const hotels = resultRes.data?.result?.hotel;

    if (!hotels || hotels.length === 0) return '😞 Ничего не найдено';

    const allTours = [];
    for (const hotel of hotels) {
      const hotelName = hotel.hotelname || 'Без названия';
      const region = hotel.regionname || '';
      const stars = hotel.hotelstars || '-';
      const tours = hotel.tours?.tour || hotel.tours || [];
      const normalized = Array.isArray(tours) ? tours : [tours];
      for (const tour of normalized) {
        allTours.push({
          price: tour.price || 999999999,
          nights: tour.nights,
          flydate: tour.flydate,
          meal: tour.mealrussian,
          room: tour.room,
          hotelName,
          region,
          stars,
        });
      }
    }

    const top = allTours.sort((a, b) => a.price - b.price).slice(0, 3);
    return top.map((t, i) => `${i + 1}. 🏨 ${t.hotelName} (${t.stars}★, ${t.region}) — от ${t.price.toLocaleString()} KZT\n   - ${t.flydate}, ${t.nights} ночей, ${t.meal}, номер: ${t.room}`).join('\n\n');
  } catch (err) {
    console.error('❌ Ошибка поиска:', err.message);
    return '🚫 Ошибка при поиске';
  }
}

// === /ask endpoint ===
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  if (!thread_id) return res.status(400).json({ error: 'thread_id отсутствует' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const keepAlive = setInterval(() => res.write(':\n\n'), 10000);
  const finish = () => {
    clearInterval(keepAlive);
    res.write('data: [DONE]\n\n');
    res.end();
  };

  let functionCallBuffer = '';
  let functionCallName = '';
  let isFunctionCall = false;

  try {
    const run = await axios.post(
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

    run.data.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') return;
        try {
          const data = JSON.parse(jsonStr);
          if (data.function_call) {
            isFunctionCall = true;
            functionCallName = data.function_call.name;
            functionCallBuffer += data.function_call.arguments || '';
          } else if (data.delta?.content && !isFunctionCall) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        } catch (err) {
          console.warn('JSON ошибка:', err.message);
        }
      }
    });

    run.data.on('end', async () => {
      if (!isFunctionCall) return finish();

      try {
        const funcCall = { name: functionCallName, arguments: functionCallBuffer };
        console.log('📦 Полный functionCallBuffer:', functionCallBuffer);
        const resultText = await handleFunctionCall(thread_id, funcCall);

        await axios.post(
          `https://api.openai.com/v1/threads/${thread_id}/messages`,
          {
            role: 'function',
            name: funcCall.name,
            content: resultText,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'OpenAI-Beta': 'assistants=v2',
            },
          }
        );

        const newRun = await axios.post(
          `https://api.openai.com/v1/threads/${thread_id}/runs`,
          { assistant_id: process.env.ASSISTANT_ID, stream: true },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'OpenAI-Beta': 'assistants=v2',
            },
            responseType: 'stream',
          }
        );

        newRun.data.on('data', (chunk2) => {
          const lines = chunk2.toString().split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              if (jsonStr !== '[DONE]') {
                res.write(`data: ${jsonStr}\n\n`);
              }
            }
          }
        });

        newRun.data.on('end', finish);
      } catch (err) {
        console.error('🔥 Ошибка обработки:', err.message);
        finish();
      }
    });
  } catch (err) {
    console.error('🔥 Ошибка в /ask:', err.message);
    res.write(`data: {"error": "${err.message}"}\n\n`);
    finish();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
