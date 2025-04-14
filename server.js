require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;

app.post('/create-thread', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );
    res.json({ thread_id: response.data.id });
  } catch (error) {
    console.error('Ошибка при создании thread:', error.message);
    res.status(500).json({ error: 'Ошибка создания thread' });
  }
});

app.post('/add-message', async (req, res) => {
  const { thread_id, message } = req.body;
  try {
    await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/messages`,
      {
        role: 'user',
        content: message,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при добавлении сообщения:', error.message);
    res.status(500).json({ error: 'Ошибка добавления сообщения' });
  }
});

app.post('/run-assistant', async (req, res) => {
  const { thread_id } = req.body;
  try {
    const response = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        assistant_id: ASSISTANT_ID,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );
    res.json({ run_id: response.data.id });
  } catch (error) {
    console.error('Ошибка при запуске ассистента:', error.message);
    res.status(500).json({ error: 'Ошибка запуска ассистента' });
  }
});

app.post('/get-response-stream', async (req, res) => {
  const { thread_id, run_id } = req.body;
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const interval = setInterval(async () => {
      try {
        const runStatus = await axios.get(
          `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`,
          {
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              'OpenAI-Beta': 'assistants=v2',
            },
          }
        );

        if (runStatus.data.status === 'completed') {
          clearInterval(interval);

          const messages = await axios.get(
            `https://api.openai.com/v1/threads/${thread_id}/messages`,
            {
              headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'assistants=v2',
              },
            }
          );

          const lastMessage = messages.data.data.find(
            (msg) => msg.role === 'assistant'
          );

          if (lastMessage) {
            res.write(`data: ${lastMessage.content[0].text.value}\n\n`);
          } else {
            res.write('data: [No message from assistant]\n\n');
          }

          res.end();
        }
      } catch (err) {
        clearInterval(interval);
        console.error('Ошибка в потоке:', err.message);
        res.write('data: [Ошибка получения ответа от OpenAI]\n\n');
        res.end();
      }
    }, 1000);
  } catch (error) {
    console.error('Ошибка в stream:', error.message);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on http://localhost:${PORT}`);
});