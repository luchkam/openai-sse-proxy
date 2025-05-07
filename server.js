// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

// Улучшенная конфигурация CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Константы для конфигурации
const MAX_RETRIES = 6;
const REQUEST_TIMEOUT = 15000;
const RETRY_DELAY = 2000;

// Проверка обязательных переменных окружения
const REQUIRED_ENV_VARS = [
  'OPENAI_API_KEY', 
  'ASSISTANT_ID', 
  'TOURVISOR_LOGIN', 
  'TOURVISOR_PASS',
  'PORT'
];

REQUIRED_ENV_VARS.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Critical: Environment variable ${key} is not set`);
    process.exit(1);
  }
});

// Конфигурация Tourvisor
const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN,
    authpass: process.env.TOURVISOR_PASS
  },
  timeout: REQUEST_TIMEOUT,
  retries: MAX_RETRIES
};

// Утилитарные функции
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTourvisorData(url, attempt = 1) {
  try {
    const res = await axios.get(url, { 
      timeout: TOURVISOR_CONFIG.timeout,
      headers: {
        'User-Agent': 'TourvisorAPI/1.0'
      }
    });
    return res.data;
  } catch (err) {
    if (attempt >= TOURVISOR_CONFIG.retries) {
      console.error(`❌ Max retries reached for URL: ${url}`);
      throw err;
    }
    console.log(`⏳ Retry attempt ${attempt} for ${url}`);
    await delay(RETRY_DELAY);
    return fetchTourvisorData(url, attempt + 1);
  }
}

// Загрузка справочников с обработкой ошибок
function loadReferenceData() {
  try {
    const countriesData = fs.readFileSync('./countries.json', 'utf8');
    const departureData = fs.readFileSync('./departure.json', 'utf8');
    
    return {
      countriesList: JSON.parse(countriesData),
      departureList: JSON.parse(departureData)
    };
  } catch (error) {
    console.error(`❌ Error loading reference data: ${error.message}`);
    throw error;
  }
}

let { countriesList, departureList } = loadReferenceData();

// Middleware для логирования
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Endpoint для создания нового потока OpenAI
app.get('/new-thread', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json'
        },
        timeout: REQUEST_TIMEOUT
      }
    );
    
    console.log(`📩 New thread created: ${response.data.id}`);
    res.json({ 
      status: 'success',
      thread_id: response.data.id 
    });
  } catch (err) {
    console.error(`❌ Error creating thread: ${err.message}`);
    res.status(500).json({ 
      status: 'error',
      error: 'Failed to create thread',
      details: err.response?.data || err.message
    });
  }
});

// SSE endpoint для OpenAI
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  
  if (!thread_id || !message) {
    return res.status(400).json({ 
      error: 'Both thread_id and message are required' 
    });
  }

  console.log(`➡️ User message: ${message}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let isConnectionClosed = false;
  req.on('close', () => {
    isConnectionClosed = true;
    console.log('⚡️ Client closed connection');
  });

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [{ 
          role: 'user', 
          content: message 
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json'
        },
        responseType: 'stream',
        timeout: REQUEST_TIMEOUT
      }
    );

    let buffer = '';
    
    run.data.on('data', (chunk) => {
      if (isConnectionClosed) {
        run.data.destroy();
        return;
      }
      
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          
          if (jsonStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            return;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          } catch (e) {
            console.error(`⚠️ Parsing error: ${e.message}`);
          }
        }
      }
    });

    run.data.on('end', () => {
      if (!isConnectionClosed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    run.data.on('error', (error) => {
      console.error(`❌ Stream error: ${error.message}`);
      if (!isConnectionClosed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
      }
    });

  } catch (error) {
    console.error(`❌ API request failed: ${error.message}`);
    if (!res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ 
        error: 'API request failed',
        details: error.message 
      })}\n\n`);
      res.end();
    }
  }
});

// Endpoint поиска туров через Tourvisor
app.get('/search-tours', async (req, res) => {
  const { country, departure, datefrom, dateto, adults, child = 0 } = req.query;
  
  // Валидация параметров
  if (!country || !departure || !datefrom || !dateto || !adults) {
    return res.status(400).json({ 
      error: 'Missing required parameters: country, departure, datefrom, dateto, adults' 
    });
  }

  if (isNaN(adults)) {
    return res.status(400).json({ 
      error: 'Adults must be a number' 
    });
  }

  console.log(`📩 Search request: ${JSON.stringify(req.query)}`);

  try {
    // Поиск в справочниках
    const countryEntry = countriesList.find(c => 
      c.name.toLowerCase() === country.toLowerCase()
    );
    
    const departureEntry = departureList.find(d => 
      d.name.toLowerCase() === departure.toLowerCase()
    );

    if (!countryEntry || !departureEntry) {
      return res.status(400).json({ 
        error: 'Country or departure city not found in reference data',
        availableCountries: countriesList.map(c => c.name),
        availableDepartures: departureList.map(d => d.name)
      });
    }

    // Форматирование даты
    const formatDate = (dateStr) => {
      const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
      if (!dateRegex.test(dateStr)) {
        throw new Error('Invalid date format. Expected DD.MM.YYYY');
      }
      return dateStr;
    };

    // Параметры поиска
    const searchParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      departure: departureEntry.id,
      country: countryEntry.id,
      datefrom: formatDate(datefrom),
      dateto: formatDate(dateto),
      nightsfrom: 7,
      nightsto: 10,
      adults: adults,
      child: child,
      format: 'json'
    });

    const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
    console.log(`🌍 Tourvisor request: ${searchUrl}`);

    const searchData = await fetchTourvisorData(searchUrl);
    const requestId = searchData?.result?.requestid;

    if (!requestId) {
      throw new Error('Failed to get requestId from Tourvisor');
    }

    console.log(`📩 Request ID: ${requestId}`);

    // Проверка статуса
    let status;
    let attempts = 0;
    
    while (attempts < MAX_RETRIES) {
      await delay(RETRY_DELAY);
      
      const statusParams = new URLSearchParams({
        ...TOURVISOR_CONFIG.auth,
        requestid: requestId,
        format: 'json',
        type: 'status',
        operatorstatus: 1
      });

      const statusUrl = `http://tourvisor.ru/xml/result.php?${statusParams}`;
      const result = await fetchTourvisorData(statusUrl);
      
      status = result?.data?.status;
      console.log(`🔍 Status check: ${JSON.stringify(status)}`);

      if (status?.state === 'finished') break;
      attempts++;
    }

    if (status?.state !== 'finished') {
      throw new Error('Search did not complete in time');
    }

    // Получение результатов
    const resultParams = new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      requestid: requestId,
      format: 'json',
      type: 'result',
      onpage: 5
    });

    const resultUrl = `http://tourvisor.ru/xml/result.php?${resultParams}`;
    console.log(`🌍 Results request: ${resultUrl}`);

    const finalData = await fetchTourvisorData(resultUrl);
    const hotels = finalData?.data?.result?.hotel;

    if (!hotels || !Array.isArray(hotels) || hotels.length === 0) {
      return res.status(404).json({ 
        error: 'No hotels found for the given criteria' 
      });
    }

    console.log(`✅ Hotels found: ${hotels.length}`);

    // Форматирование результатов
    const tours = hotels.map(hotel => ({
      name: hotel.hotelname,
      price: hotel.price,
      country: hotel.countryname,
      rating: hotel.hotelrating,
      link: hotel.fulldesclink,
      picture: hotel.picturelink,
      description: hotel.hoteldescription,
      meal: hotel.meal,
      room: hotel.room
    }));

    res.json({ 
      status: 'success',
      count: tours.length,
      tours 
    });

  } catch (error) {
    console.error(`❌ Tour search error: ${error.message}`);
    res.status(500).json({ 
      status: 'error',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error(`🔥 Unhandled error: ${err.message}`);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received. Shutting down gracefully');
  server.close(() => {
    console.log('🚪 Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received. Shutting down gracefully');
  server.close(() => {
    console.log('🚪 Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
});
