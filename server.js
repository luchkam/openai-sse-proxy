const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Новый endpoint для создания потока
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
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// SSE endpoint с поддержкой вызова Tourvisor
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [
          { role: 'user', content: userMessage },
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
          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
        }

        const data = JSON.parse(jsonStr);
        const funcCall = data?.function_call;

        if (funcCall && funcCall.name === 'search_tours') {
          const args = JSON.parse(funcCall.arguments);
          const queryParams = new URLSearchParams({
            authlogin: 'info@meridiantt.com',
            authpass: 'Mh4GdKPUtwZT',
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

          const searchUrl = `http://tourvisor.ru/xml/search.php?${queryParams.toString()}`;
          const resultUrl = `http://tourvisor.ru/xml/result.php?authlogin=info@meridiantt.com&authpass=Mh4GdKPUtwZT&type=result&format=json`;

          try {
            const searchRes = await axios.get(searchUrl);
            const requestId = searchRes.data?.result?.requestid;
            if (!requestId) {
              res.write(`data: ${JSON.stringify({ content: 'Ошибка при запуске поиска туров' })}\n\n`);
              res.end();
              return;
            }

            await new Promise((resolve) => setTimeout(resolve, 5000));

            const resultRes = await axios.get(`${resultUrl}&requestid=${requestId}`);
            const hotels = resultRes.data?.result?.hotel;

            if (!hotels || hotels.length === 0) {
              res.write(`data: ${JSON.stringify({ content: 'По вашему запросу ничего не найдено.' })}\n\n`);
              res.end();
              return;
            }

            const reply = hotels.slice(0, 3).map((hotel, i) => {
              const tour = hotel.tours?.[0];
              return `🏨 ${hotel.hotelname} (${hotel.hotelstars}★, ${hotel.regionname}) — от ${tour.price} руб. (${tour.nights} ночей, питание: ${tour.mealrussian})`;
            }).join('\n\n');

            res.write(`data: ${JSON.stringify({ content: reply })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          } catch (e) {
            res.write(`data: ${JSON.stringify({ content: 'Ошибка получения результатов от Tourvisor' })}\n\n`);
            res.end();
            return;
          }
        } else {
          res.write(`data: ${jsonStr}\n\n`);
        }
      }
    });

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
