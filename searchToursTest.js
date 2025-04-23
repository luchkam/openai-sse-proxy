// === searchToursTest.js ===
const axios = require('axios');
require('dotenv').config();

const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
    authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
  },
  timeout: 12000, // увеличим на 12 секунд
  retries: 6      // до 6 попыток
};

async function fetchTourvisorData(url, attempt = 1) {
  try {
    const response = await axios.get(url, {
      timeout: TOURVISOR_CONFIG.timeout,
      responseType: 'json'
    });

    if (!response.data) throw new Error('Пустой ответ от Tourvisor');
    return response.data;
  } catch (err) {
    if (attempt >= TOURVISOR_CONFIG.retries) throw err;
    await new Promise(r => setTimeout(r, 2000 * attempt));
    return fetchTourvisorData(url, attempt + 1);
  }
}

async function searchTours(params) {
  const formatDate = (dateStr) => {
    const [year, month, day] = dateStr.split('-');
    return `${day}.${month}.${year}`;
  };

  const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    departure: params.departure,
    country: params.country,
    datefrom: formatDate(params.datefrom),
    dateto: formatDate(params.dateto),
    nightsfrom: params.nightsfrom || 7,
    nightsto: params.nightsto || 10,
    adults: params.adults || 2,
    child: params.child || 0,
    format: 'json'
  })}`;

  const searchData = await fetchTourvisorData(searchUrl);
  const requestId = searchData?.result?.requestid;
  if (!requestId) throw new Error('Не удалось получить requestid');
  process.stdout.write(`📨 Получен requestid: ${requestId}\n`);

  const resultUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    requestid: requestId,
    format: 'json',
    onpage: 25,
    type: 'result'
  })}`;

  for (let i = 1; i <= TOURVISOR_CONFIG.retries; i++) {
    const result = await fetchTourvisorData(resultUrl);
    const state = result?.data?.status?.state;
    const timepassed = result?.data?.status?.timepassed;
    const hotels = result?.data?.result?.hotel;

    process.stdout.write(`⏱️ Попытка ${i}: state=${state}, timepassed=${timepassed}s\n`);

    if (state === 'finished' && Array.isArray(hotels) && hotels.length > 0) {
      process.stdout.write(`✅ Найдено отелей: ${hotels.length}\n`);
      return hotels;
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error('Нет результатов поиска');
}

module.exports = searchTours;
