// Обновлённый server.js с полной диагностикой (не редактировать без необходимости)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Новый поток
app.get('/new-thread', async (req, res) => {
  try {
    const response = await axios.post('https://api.openai.com/v1/threads', {}, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2'
      }
    });
    res.json({ thread_id: response.data.id });
  } catch (err) {
    console.error('Ошибка создания thread:', err);
    res.status(500).json({ error: 'Thread create failed' });
  }
});

// Поиск туров
async function handleFunctionCall(threadId, funcCall) {
  if (funcCall.name !== 'search_tours') return null;
  try {
    const args = JSON.parse(funcCall.arguments);
    console.log('📦 Аргументы:', args);

    const auth = { authlogin: 'info@meridiantt.com', authpass: 'Mh4GdKPUtwZT' };
    const searchParams = new URLSearchParams({
      ...auth,
      departure: args.departure,
      country: args.country,
      datefrom: args.datefrom,
      dateto: args.dateto,
      nightsfrom: args.nightsfrom || 7,
      nightsto: args.nightsto || 10,
      adults: args.adults || 2,
      child: args.child || 0,
      format: 'json'
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
    const baseResultUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams(auth)}&format=json`;

    const searchRes = await axios.get(searchUrl);
    const requestId = searchRes.data?.result?.requestid;
    if (!requestId) return '❌ Не удалось запустить поиск туров';

    const statusUrl = `${baseResultUrl}&requestid=${requestId}&type=status`;
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const status = await axios.get(statusUrl);
      if (status.data?.status?.state === 'finished') break;
    }

    const resultUrl = `${baseResultUrl}&requestid=${requestId}&type=result`;
    const result = await axios.get(resultUrl);
    const hotels = result.data?.result?.hotel;
    if (!hotels || !hotels.length) return '😞 Туров не найдено';

    const allTours = [];
    for (const hotel of hotels) {
      const hotelName = hotel.hotelname;
      const region = hotel.regionname;
      const stars = hotel.hotelstars;
      const tours = Array.isArray(hotel.tours?.tour) ? hotel.tours.tour : [hotel.tours?.tour];
      for (const t of tours) {
        allTours.push({
          price: t.price,
          nights: t.nights,
          flydate: t.flydate,
          meal: t.mealrussian,
          room: t.room,
          hotelName,
          region,
          stars
        });
      }
    }

    const top = allTours.sort((a, b) => a.price - b.price).slice(0, 3);
    return top.map((t, i) => `${i + 1}. 🏨 ${t.hotelName} (${t.stars}★, ${t.region}) — от ${t.price.toLocaleString()} KZT\n   - ${t.flydate}, ${t.nights} ночей, ${t.meal}, номер: ${t.room}`).join('\n\n');
  } catch (err) {
    console.error('❌ Ошибка в handleFunctionCall:', err);
    return '🚫 Ошибка поиска тура';
  }
}

// SSE-обработка
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
          'OpenAI-Beta': 'assistants=v2'
        },
        responseType: 'stream'
      }
    );

    let functionCallBuffer = '';
    let functionCallName = null;
    let isFunctionCall = false;

    run.data.on('data', async (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') return finish();

        try {
          const data = JSON.parse(jsonStr);
          if (data.function_call) {
            isFunctionCall = true;
            functionCallName = data.function_call.name;
            functionCallBuffer += data.function_call.arguments || '';
            continue;
          }
          if (!isFunctionCall && data.delta?.content) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        } catch (e) {
          console.warn('Ошибка парсинга JSON:', e.message);
        }
      }
    });

    run.data.on('end', async () => {
      if (!isFunctionCall) return finish();

      const funcCall = { name: functionCallName, arguments: functionCallBuffer };
      const resultText = await handleFunctionCall(thread_id, funcCall);

      await axios.post(
        `https://api.openai.com/v1/threads/${thread_id}/messages`,
        {
          role: 'function',
          name: funcCall.name,
          content: resultText || 'Ошибка обработки'
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );

      const secondRun = await axios.post(
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

      secondRun.data.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            if (payload !== '[DONE]') res.write(`data: ${payload}\n\n`);
          }
        }
      });
      secondRun.data.on('end', finish);
    });
  } catch (err) {
    console.error('🔥 Ошибка в /ask:', err);
    res.write(`data: {"error":"${err.message}"}\n\n`);
    finish();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
