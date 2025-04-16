const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// === Явные заголовки CORS ===
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // или 'https://turpoisk.kz'
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(cors());
app.use(express.json());

// === Создание нового thread ===
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
    console.error('Ошибка создания thread:', err.message);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// === Обработчик search_tours через Tourvisor ===
async function handleFunctionCall(threadId, funcCall) {
  if (funcCall.name !== 'search_tours') return null;

  try {
    const args = JSON.parse(funcCall.arguments);
    console.log('📩 Аргументы функции:', args);

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

    const searchUrl = `http://tourvisor.ru/xml/search.php?${queryParams.toString()}`;
    const resultBaseUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams(auth)}&format=json`;

    // 1. Старт поиска
    const searchRes = await axios.get(searchUrl);
    const requestId = searchRes.data?.result?.requestid;
    if (!requestId) return '❌ Не удалось запустить поиск туров.';
    console.log('🔍 Request ID:', requestId);

    // 2. Ожидание завершения поиска
    const statusUrl = `${resultBaseUrl}&requestid=${requestId}&type=status`;
    const maxAttempts = 4;
    let status = null;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await axios.get(statusUrl);
      status = statusRes.data?.status?.state;
      console.log(`⌛ Статус поиска [${i + 1}/${maxAttempts}]:`, status);
      if (status === 'finished') break;
    }

    // 3. Получение результата
    const resultUrl = `${resultBaseUrl}&requestid=${requestId}&type=result`;
    const resultRes = await axios.get(resultUrl);
    const hotels = resultRes.data?.result?.hotel;

    if (!hotels || hotels.length === 0) return '😞 По данному запросу туров не найдено.';

    const reply = hotels.slice(0, 3).map((hotel) => {
      const tour = hotel.tours?.[0];
      if (!tour) return null;
      return `🏨 ${hotel.hotelname} (${hotel.hotelstars}★, ${hotel.regionname}) — от ${tour.price} руб. (${tour.nights} ночей, питание: ${tour.mealrussian})`;
    }).filter(Boolean).join('\n\n');

    return reply || '🔎 Поиск завершён, но туров не найдено.';
  } catch (err) {
    console.error('❌ Ошибка в search_tours:', err.message);
    return '🚫 Произошла ошибка при поиске туров.';
  }
}

// === SSE /ask endpoint ===
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    return res.status(400).json({ error: 'thread_id отсутствует' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 🧠 Keep-alive для Render
  const keepAliveInterval = setInterval(() => {
    res.write(':\n\n'); // SSE-комментарий
  }, 10000);

  let finished = false;
  const finish = () => {
    if (!finished) {
      clearInterval(keepAliveInterval);
      finished = true;
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };

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
        if (jsonStr === '[DONE]') return finish();

        try {
          const data = JSON.parse(jsonStr);
          const funcCall = data?.function_call;

          if (funcCall) {
            console.log('⚙️ Вызов функции:', funcCall.name);
            const resultText = await handleFunctionCall(threadId, funcCall);

            await axios.post(
              `https://api.openai.com/v1/threads/${threadId}/messages`,
              {
                role: 'function',
                name: funcCall.name,
                content: resultText || 'Ошибка обработки',
              },
              {
                headers: {
                  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                  'OpenAI-Beta': 'assistants=v2',
                },
              }
            );

            const newRun = await axios.post(
              `https://api.openai.com/v1/threads/${threadId}/runs`,
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
              const lines2 = chunk2.toString().split('\n');
              for (const line2 of lines2) {
                if (line2.startsWith('data: ')) {
                  const jsonStr2 = line2.slice(6);
                  if (jsonStr2 !== '[DONE]') {
                    res.write(`data: ${jsonStr2}\n\n`);
                  }
                }
              }
            });

            newRun.data.on('end', finish);
            return;
          } else {
            res.write(`data: ${jsonStr}\n\n`);
          }
        } catch (parseErr) {
          console.error('❗ Ошибка парсинга потока:', parseErr.message);
        }
      }
    });

    run.data.on('end', finish);
  } catch (error) {
    console.error('🔥 Ошибка /ask:', error.message);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    finish();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
