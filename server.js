const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 🔹 Endpoint для создания thread
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

// 🔹 SSE endpoint для отправки сообщений и получения потока ответов
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

    run.data.on('data', (chunk) => {
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

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });
  } catch (error) {
    console.error('Ошибка в /ask:', error.message);
    res.write(`data: {\"error\":\"${error.message}\"}\n\n`);
    res.end();
  }
});

// 🔹 Tool implementation: fetch_tours вызывается Assistant'ом через OpenAI API
app.post('/functions/fetch_tours', async (req, res) => {
  const {
    cityFrom,
    country,
    adults,
    nightsMin,
    nightsMax,
    dateFrom,
    dateTo
  } = req.body;

  const authlogin = process.env.TOURVISOR_LOGIN || 'info@meridiantt.com';
  const authpass = process.env.TOURVISOR_PASSWORD || 'Mh4GdKPUtwZT';

  const searchUrl = `http://tourvisor.ru/xml/search.php?authlogin=${authlogin}&authpass=${authpass}&departure=${cityFrom}&country=${country}&datefrom=${dateFrom}&dateto=${dateTo}&nightsfrom=${nightsMin}&nightsto=${nightsMax}&adults=${adults}&format=json`;

  try {
    const searchResponse = await axios.get(searchUrl);
    const requestId = searchResponse.data.requestid;

    const statusUrl = `http://tourvisor.ru/xml/result.php?authlogin=${authlogin}&authpass=${authpass}&requestid=${requestId}&type=status`;
    let attempts = 0;
    let isReady = false;
    let statusData;

    while (attempts < 5 && !isReady) {
      const statusResponse = await axios.get(statusUrl);
      statusData = statusResponse.data.status;
      if (statusData.state === 'finished') {
        isReady = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
    }

    if (!isReady) {
      return res.status(202).json({ message: 'Поиск не завершен, попробуйте позже.' });
    }

    const resultUrl = `http://tourvisor.ru/xml/result.php?authlogin=${authlogin}&authpass=${authpass}&requestid=${requestId}&type=result`;
    const resultResponse = await axios.get(resultUrl);
    res.json({ result: resultResponse.data });

  } catch (error) {
    console.error('Ошибка при поиске туров:', error.message);
    res.status(500).json({ error: 'Ошибка при получении туров' });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
