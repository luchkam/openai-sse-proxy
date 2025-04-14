require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/create-thread', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json',
        },
      }
    );

    const thread_id = response.data.id;
    res.json({ thread_id });
  } catch (error) {
    console.error('Ошибка создания thread:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Ошибка при создании потока.' });
  }
});

app.post('/chat', async (req, res) => {
  const { thread_id, message } = req.body;

  try {
    // Добавляем сообщение в thread
    await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/messages`,
      {
        role: 'user',
        content: message,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json',
        },
      }
    );

    // Запускаем assistant
    const response = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
      }),
    });

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }

    res.end();
  } catch (err) {
    console.error('Ошибка при обработке запроса:', err.message);
    res.status(500).json({ error: 'Ошибка сервера при запуске ассистента.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SSE proxy listening on http://localhost:${PORT}`);
});