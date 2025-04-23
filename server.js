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
    process.stdout.write(`\n📩 Получен requestid: ${response.data.id}`); // Логируем requestid
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`\n❌ Ошибка при создании потока: ${err.message}`);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// SSE endpoint для генерации и потоковой передачи ответа
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
    process.stdout.write(`\n❌ Ошибка в /ask: ${error.message}`);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

// Новый endpoint для обработки запроса поиска туров
app.get('/search-tours', async (req, res) => {
  const { country, city, datefrom, dateto, adults, children } = req.query;

  process.stdout.write(`\n🔍 Получены параметры поиска туров:
    Страна: ${country}, Город: ${city}, Даты: с ${datefrom} по ${dateto}, 
    Взрослые: ${adults}, Дети: ${children}`);

  // Формируем запрос для TourVisor API
  const searchParams = {
    authlogin: process.env.TOURVISOR_LOGIN,
    authpass: process.env.TOURVISOR_PASS,
    departure: city,  // передаем город вылета
    country: country, // передаем страну
    datefrom: datefrom, // передаем дату вылета
    dateto: dateto, // передаем дату возвращения
    adults: adults, // количество взрослых
    child: children, // количество детей
    format: 'json' // формат ответа
  };

  try {
    // Логируем передаваемые параметры для поиска
    process.stdout.write(`\n📩 Запрос к TourVisor: ${JSON.stringify(searchParams)}`);

    const response = await axios.get('http://tourvisor.ru/xml/search.php', { params: searchParams });

    // Логируем ответ от TourVisor
    process.stdout.write(`\n🔍 Ответ от TourVisor: ${JSON.stringify(response.data)}`);

    if (response.data.requestid) {
      process.stdout.write(`\n📩 Получен requestid от TourVisor: ${response.data.requestid}`);
      
      // Теперь получаем статус по requestid
      const statusResponse = await axios.get('http://tourvisor.ru/xml/result.php', {
        params: {
          authlogin: process.env.TOURVISOR_LOGIN,
          authpass: process.env.TOURVISOR_PASS,
          requestid: response.data.requestid,
          type: 'status'
        }
      });

      // Логируем статус
      process.stdout.write(`\n🔍 Статус поиска: ${JSON.stringify(statusResponse.data)}`);
      
      if (statusResponse.data.status.state === 'finished') {
        // Если поиск завершен, получаем результаты
        const resultResponse = await axios.get('http://tourvisor.ru/xml/result.php', {
          params: {
            authlogin: process.env.TOURVISOR_LOGIN,
            authpass: process.env.TOURVISOR_PASS,
            requestid: response.data.requestid,
            type: 'result'
          }
        });

        // Логируем результаты
        process.stdout.write(`\n📦 Результаты поиска: ${JSON.stringify(resultResponse.data)}`);

        res.json(resultResponse.data); // Отправляем результаты пользователю
      } else {
        res.json({ message: 'Поиск еще не завершен', status: statusResponse.data.status });
      }
    } else {
      res.status(500).json({ error: 'Не удалось получить requestid от TourVisor' });
    }
  } catch (error) {
    process.stdout.write(`\n❌ Ошибка при запросе к TourVisor: ${error.message}`);
    res.status(500).json({ error: 'Ошибка при запросе к TourVisor' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}`);
});
