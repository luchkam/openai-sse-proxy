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
    process.stdout.write(`\n📩 Получен requestid: ${response.data.id}`);
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`\n❌ Не удалось создать thread_id: ${err.message}`);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// SSE endpoint для генерации и потоковой передачи ответа
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  process.stdout.write(`\n➡️ Сообщение от пользователя: ${userMessage}`);

  if (!threadId) {
    process.stdout.write(`\n❌ thread_id отсутствует`);
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
            process.stdout.write(`\n🔍 Ответ от OpenAI: ${JSON.stringify(jsonStr)}`);
            res.write(`data: ${jsonStr}\n\n`);
          }
        }
      }
    });

    run.data.on('end', () => {
      process.stdout.write(`\n✅ Ответ от OpenAI завершен`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (error) {
    process.stdout.write(`\n❌ Ошибка в /ask: ${error.message}`);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

// Новый endpoint для обработки запроса от Assistant Function и запроса в Tourvisor
app.get('/search-tours', async (req, res) => {
  process.stdout.write('\n📩 Получен GET-запрос от Assistant Function');
  process.stdout.write(`\nПараметры: ${JSON.stringify(req.query)}`);

  const { thread_id, run_id, tool_call_id, country, city, datefrom, dateto, adults, child = 0 } = req.query;

  if (!thread_id || !run_id || !tool_call_id) {
    process.stdout.write(`\n❌ Отсутствует thread_id, run_id или tool_call_id`);
    return res.status(400).json({ error: 'thread_id, run_id и tool_call_id обязательны' });
  }

  try {
    const args = {
      tool_outputs: [
        {
          tool_call_id: tool_call_id,
          output: 'Поиск запущен, данные переданы в Tourvisor API',
        },
      ],
    };

    await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}/submit_tool_outputs`,
      args,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );
    process.stdout.write(`\n✅ Информация отправлена обратно в Assistant`);

    const tourvisorUrl = `http://tourvisor.ru/xml/search.php?authlogin=${process.env.TV_LOGIN}&authpass=${process.env.TV_PASS}` +
      `&departure=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&datefrom=${datefrom}` +
      `&dateto=${dateto}&nightsfrom=7&nightsto=10&adults=${adults}&child=${child}&format=json`;

    const tourvisorResponse = await axios.get(tourvisorUrl);
    process.stdout.write(`\n🌍 Ответ от Tourvisor: ${JSON.stringify(tourvisorResponse.data)}`);

    res.json({ status: 'Tourvisor запрос отправлен и обработан', data: tourvisorResponse.data });

  } catch (err) {
    process.stdout.write(`\n❌ Ошибка в /search-tours: ${err.message}`);
    res.status(500).json({ error: 'Ошибка при обработке запроса /search-tours' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
