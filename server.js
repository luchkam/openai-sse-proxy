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

// Новый endpoint для обработки запроса от Assistant Function и запуска поиска в Tourvisor
app.get('/search-tours', async (req, res) => {
  process.stdout.write('\n📩 Получен GET-запрос от Assistant Function');
  process.stdout.write(`\nПараметры: ${JSON.stringify(req.query)}`);

  const { country, city, datefrom, dateto, adults = 2, child = 0 } = req.query;

  if (!country || !city || !datefrom || !dateto) {
    res.status(400).json({ error: 'Не хватает обязательных параметров: country, city, datefrom, dateto' });
    return;
  }

  const searchUrl = `http://tourvisor.ru/xml/search.php?authlogin=${process.env.TOURVISOR_LOGIN}&authpass=${process.env.TOURVISOR_PASS}&country=${country}&departure=${city}&datefrom=${datefrom}&dateto=${dateto}&nightsfrom=7&nightsto=10&adults=${adults}&child=${child}&format=json`;

  process.stdout.write(`\n📤 Отправляем запрос в Tourvisor:\n${searchUrl}`);

  try {
    const response = await axios.get(searchUrl);
    process.stdout.write(`\n📩 Ответ от Tourvisor (requestid): ${JSON.stringify(response.data)}`);
    res.json({ status: 'поиск отправлен', requestid: response.data.requestid });
  } catch (error) {
    process.stdout.write(`\n❌ Ошибка при запросе в Tourvisor: ${error.message}`);
    res.status(500).json({ error: 'Ошибка при обращении к Tourvisor API' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SSE Proxy Server listening on port ${PORT}`);
});
