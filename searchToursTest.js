const axios = require('axios');
require('dotenv').config();

const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
    authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
  },
  timeout: 15000,
  retries: 6
};

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTourvisorData(url, attempt = 1) {
  try {
    const res = await axios.get(url, { timeout: TOURVISOR_CONFIG.timeout });
    return res.data;
  } catch (err) {
    if (attempt >= TOURVISOR_CONFIG.retries) throw err;
    await delay(2000);
    return fetchTourvisorData(url, attempt + 1);
  }
}

async function searchTours(params) {
  const formatDate = (dateStr) => {
    const [day, month, year] = dateStr.split('.');
    return `${day}.${month}.${year}`;
  };

  const searchParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    departure: params.departure,
    country: params.country,
    datefrom: formatDate(params.datefrom),
    dateto: formatDate(params.dateto),
    nightsfrom: params.nightsfrom,
    nightsto: params.nightsto,
    adults: params.adults,
    child: params.child,
    format: 'json'
  });

  const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
  const searchData = await fetchTourvisorData(searchUrl);
  const requestId = searchData?.result?.requestid;
  process.stdout.write(`\n📩 Получен requestid: ${requestId}`);
  if (!requestId) throw new Error('Не удалось получить requestid');

  const resultParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    requestid: requestId,
    format: 'json',
    type: 'status',
    operatorstatus: 1
  });

  const resultUrl = `http://tourvisor.ru/xml/result.php?${resultParams}`;
  let attempts = 0;
  let status;

  while (attempts < TOURVISOR_CONFIG.retries) {
    await delay(2000);
    const result = await fetchTourvisorData(resultUrl);
    status = result?.data?.status;
    process.stdout.write(`\n🔍 Ответ от Tourvisor (status): ${JSON.stringify(result)}`);

    if (status?.state === 'finished') break;
    attempts++;
  }

  if (status?.state !== 'finished') {
    throw new Error('Поиск не завершен за отведенное время');
  }

  const finalResultParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    requestid: requestId,
    format: 'json',
    type: 'result',
    onpage: 5
  });

  const finalUrl = `http://tourvisor.ru/xml/result.php?${finalResultParams}`;
  const finalData = await fetchTourvisorData(finalUrl);
  process.stdout.write(`\n📦 Ответ по результату поиска: ${JSON.stringify(finalData)}\n`);
  const result = finalData?.data?.result?.hotel;

  if (!result || result.length === 0) {
    throw new Error('Нет результатов поиска');
  }

  process.stdout.write(`\n✅ Найдено отелей: ${result.length}\n`);
  return result;
}

module.exports = searchTours;
