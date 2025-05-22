const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint для создания нового потока
app.get('/new-thread', async (req, res) => {
  process.stdout.write('Создание нового потока...\n');
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
    process.stdout.write(`Новый thread_id создан: ${response.data.id}\n`);
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`Ошибка при создании thread_id: ${err.message}\n`);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// Функция получения курса валют
const getExchangeRate = async (from, to, amount = 1) => {
  try {
    const response = await axios.get('https://api.exchangerate.host/convert', {
      params: {
        access_key: process.env.EXCHANGE_API_KEY,
        from,
        to,
        amount
      }
    });

    if (response.data && response.data.result) {
      return {
        from,
        to,
        message: `1 ${from} = ${response.data.result / amount} ${to}`,
      };
    } else {
      throw new Error('Некорректный ответ от API');
    }
  } catch (error) {
    process.stdout.write(`Ошибка курса валют: ${error.message}\n`);
    return { from, to, message: `1 ${from} = undefined ${to}` };
  }
};

// Функция получения погоды
const getWeather = async (location, unit) => {
  try {
    const geoResponse = await axios.get(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`
    );
    process.stdout.write(`🌍 Геоданные: ${JSON.stringify(geoResponse.data)}\n`);

    const { latitude, longitude } = geoResponse.data.results[0];

    const weatherResponse = await axios.get(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m&temperature_unit=${unit === 'c' ? 'celsius' : 'fahrenheit'}`
    );

    return {
      temperature: weatherResponse.data.current.temperature_2m,
      wind_speed: weatherResponse.data.current.wind_speed_10m,
      unit: unit === 'c' ? '°C' : '°F',
      location: location,
    };
  } catch (error) {
    process.stdout.write(`Ошибка погоды: ${error.message}\n`);
    return { error: "Не удалось получить погоду. Проверьте название города." };
  }
};

// Функция поиска авиабилетов
     const searchFlights = async (origin, destination, depart_date, return_date = null) => {
  try {
    const params = {
      origin,
      destination,
      departure_at: depart_date,
      currency: 'KZT',
      market: 'kz',
      limit: 30,
      token: process.env.TRAVELPAYOUTS_API_KEY
    };

    if (return_date) {
      params.return_at = return_date;
      params.one_way = false;
    } else {
      params.one_way = true;
    }

    process.stdout.write(`📡 Отправляем запрос в Travelpayouts (prices_for_dates) с параметрами: ${JSON.stringify(params)}\n`);

    let response = await axios.get('https://api.travelpayouts.com/aviasales/v3/prices_for_dates', { params });
    let tickets = response.data.data || [];

    // Если билеты не найдены — пробуем fallback
    if (!tickets.length) {
      process.stdout.write('⚠️ Нет результатов в prices_for_dates — пробуем get_latest_prices\n');

      const fallbackParams = {
        origin,
        destination,
        beginning_of_period: depart_date,
        period_type: 'month',
        one_way: !return_date,
        currency: 'KZT',
        token: process.env.TRAVELPAYOUTS_API_KEY
      };

      const fallbackRes = await axios.get('https://api.travelpayouts.com/aviasales/v3/get_latest_prices', { params: fallbackParams });
      tickets = fallbackRes.data.data || [];
    }

    process.stdout.write(`📥 Всего получено билетов: ${tickets.length}\n`);

    const formatDate = (isoString) => {
      const [datePart] = isoString.split('T');
      const [year, month, day] = datePart.split('-');
      return `${day}${month}`;
    };

    // Сортировка по цене
    tickets.sort((a, b) => a.price - b.price);

    // Удаление дубликатов
    const seen = new Set();
    const uniqueTickets = [];
    for (const ticket of tickets) {
      const key = `${ticket.departure_at}_${ticket.return_at}_${ticket.price}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueTickets.push(ticket);
      }
    }

    // Группируем билеты по дате вылета и возврата
const groupedByDates = {};
for (const ticket of uniqueTickets) {
  const key = `${ticket.departure_at}_${ticket.return_at}`;
  if (!groupedByDates[key]) {
    groupedByDates[key] = [];
  }
  groupedByDates[key].push(ticket);
}

// Для каждой группы оставляем только самый дешевый билет
const filteredTickets = Object.values(groupedByDates).map(group => {
  return group.reduce((min, ticket) => ticket.price < min.price ? ticket : min);
});

// Сортируем по цене и берём до 3 штук
const finalTickets = filteredTickets
  .sort((a, b) => a.price - b.price)
  .slice(0, 3)
  .map(ticket => ({
    price: ticket.price,
    airline: ticket.airline,
    departure_at: ticket.departure_at,
    return_at: ticket.return_at,
    transfers: ticket.transfers,
    link: `https://aviasales.kz/search/${origin}${formatDate(ticket.departure_at)}${destination}${ticket.return_at ? formatDate(ticket.return_at) : ''}1`
  }));

    return { tickets: finalTickets };
  } catch (error) {
    process.stdout.write(`Ошибка поиска авиабилетов: ${error.message}\n`);
    return { error: 'Не удалось получить данные по авиабилетам.' };
  }
};

// SSE endpoint
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    process.stdout.write('❌ Ошибка: отсутствует thread_id\n');
    return res.status(400).json({ error: 'thread_id отсутствует' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  process.stdout.write(`📨 Запрос к OpenAI с thread_id: ${threadId}, сообщение: ${userMessage}\n`);

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: false,
        additional_messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    const runId = run.data.id;

    let completed = false;
    while (!completed) {
      const statusRes = await axios.get(
        `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2',
          },
        }
      );

      if (statusRes.data.status === 'completed') {
        completed = true;
        break;
      } else if (statusRes.data.status === 'requires_action') {
        const toolCalls = statusRes.data.required_action.submit_tool_outputs.tool_calls;
        const outputs = [];

        for (const call of toolCalls) {
          if (call.function.name === 'get_weather') {
            let args;
            try {
              args = JSON.parse(call.function.arguments);
            } catch (err) {
              process.stdout.write(`⚠️ Ошибка парсинга arguments: ${err.message}\n`);
              continue;
            }

            const weather = await getWeather(args.location, args.unit);
            outputs.push({
              tool_call_id: call.id,
              output: JSON.stringify(weather),
            });
          }

          if (call.function.name === 'get_exchange_rate') {
            let args;
            try {
              args = JSON.parse(call.function.arguments);
            } catch (err) {
              process.stdout.write(`⚠️ Ошибка парсинга arguments: ${err.message}\n`);
              continue;
            }

            const amount = args.amount || 1;
            const rate = await getExchangeRate(args.from, args.to, amount);
            outputs.push({
              tool_call_id: call.id,
              output: JSON.stringify(rate),
            });
          }

          if (call.function.name === 'search_flights') {
            let args;
            try {
              args = JSON.parse(call.function.arguments);
              process.stdout.write(`🧾 Аргументы от ассистента: ${JSON.stringify(args)}\n`);
            } catch (err) {
              process.stdout.write(`⚠️ Ошибка парсинга arguments: ${err.message}\n`);
              continue;
            }

            const flights = await searchFlights(args.origin, args.destination, args.depart_date, args.return_date);  
            outputs.push({
              tool_call_id: call.id,
              output: JSON.stringify(flights),
            });
          }
        }

        try {
          process.stdout.write(`📤 Отправка tool_outputs: ${JSON.stringify(outputs)}\n`);
          await axios.post(
            `https://api.openai.com/v1/threads/${threadId}/runs/${runId}/submit_tool_outputs`,
            { tool_outputs: outputs },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'OpenAI-Beta': 'assistants=v2',
              },
            }
          );
          process.stdout.write('✅ submit_tool_outputs успешно отправлены\n');
        } catch (err) {
          process.stdout.write(`❌ Ошибка отправки tool_outputs: ${err.message}\n`);
        }
      } else {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const messagesRes = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    const last = messagesRes.data.data.find((m) => m.role === 'assistant');
    process.stdout.write(`📤 Ответ ассистента: ${JSON.stringify(last)}\n`);
    res.write(`data: ${JSON.stringify(last)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    process.stdout.write('✅ Поток завершен\n');
  } catch (error) {
    process.stdout.write(`❌ Ошибка в /ask: ${error.message}\n`);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`);
});
