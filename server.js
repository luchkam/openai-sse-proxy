const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Новый endpoint для создания потока
app.get('/new-thread', async (req, res) => {
  process.stdout.write('Создание нового потока...\n'); // Логируем начало
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
    process.stdout.write(`Новый thread_id создан: ${response.data.id}\n`); // Логируем успешный ответ
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`Ошибка при создании thread_id: ${err.message}\n`); // Логируем ошибку
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

const getWeather = async (location, unit) => {
  try {
    // 1. Геокодинг: Получаем координаты города (используем Open-Meteo Geocoding)
    const geoResponse = await axios.get(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`
    );
    const { latitude, longitude } = geoResponse.data.results[0];

    // 2. Запрос погоды
    const weatherResponse = await axios.get(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m&temperature_unit=${unit === 'c' ? 'celsius' : 'fahrenheit'}`
    );

    return {
      temperature: weatherResponse.data.current.temperature_2m,
      wind_speed: weatherResponse.data.current.wind_speed_10m,
      unit: unit === 'c' ? '°C' : '°F',
      location: location
    };
  } catch (error) {
    console.error('Ошибка:', error.message);
    return { error: "Не удалось получить погоду. Проверьте название города." };
  }
};

// SSE endpoint для генерации и потоковой передачи ответа
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    process.stdout.write('Ошибка: отсутствует thread_id\n'); // Логируем отсутствие thread_id
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  process.stdout.write(`Запрос к OpenAI с thread_id: ${threadId}, сообщение: ${userMessage}\n`); // Логируем начало запроса

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

    app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    process.stdout.write('Ошибка: отсутствует thread_id\n');
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  process.stdout.write(`Запрос к OpenAI с thread_id: ${threadId}, сообщение: ${userMessage}\n`);

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

    let buffer = '';
    
    run.data.on('data', async (chunk) => {
      buffer += chunk.toString();
      
      // Обрабатываем все завершенные строки
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Оставляем неполную строку в буфере
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          
          if (jsonStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          
          try {
            const data = JSON.parse(jsonStr);
            
            // Обработка вызова функции get_weather
            if (data.event === 'thread.run.requires_action' && 
                data.data?.required_action?.type === 'submit_tool_outputs') {
              const toolCalls = data.data.required_action.submit_tool_outputs.tool_calls;
              const outputs = [];

              for (const call of toolCalls) {
                if (call.function.name === 'get_weather') {
                  try {
                    const args = JSON.parse(call.function.arguments);
                    const weather = await getWeather(args.location, args.unit);
                    outputs.push({
                      tool_call_id: call.id,
                      output: JSON.stringify(weather)
                    });
                  } catch (err) {
                    console.error('Ошибка обработки функции:', err);
                    outputs.push({
                      tool_call_id: call.id,
                      output: JSON.stringify({ error: err.message })
                    });
                  }
                }
              }

              if (outputs.length > 0) {
                await axios.post(
                  `https://api.openai.com/v1/threads/${threadId}/runs/${data.data.id}/submit_tool_outputs`,
                  { tool_outputs: outputs },
                  { headers: { 
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 
                    'OpenAI-Beta': 'assistants=v2' 
                  }}
                );
              }
            }
            
            res.write(`data: ${jsonStr}\n\n`);
            process.stdout.write(`Отправлено: ${jsonStr}\n`);
            
          } catch (err) {
            console.error('Ошибка парсинга JSON:', err);
            console.error('Оригинальные данные:', jsonStr);
          }
        }
      }
    });

    run.data.on('end', () => {
      if (buffer.trim()) {
        console.warn('Необработанные данные в буфере:', buffer);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      process.stdout.write('Поток завершен\n');
    });

  } catch (error) {
    process.stdout.write(`Ошибка в /ask: ${error.message}\n`);
    console.error('Ошибка в /ask:', error);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
