const axios = require('axios');

async function searchToursTest(payload) {
  const { departure, country, datefrom, dateto, nightsfrom, nightsto, adults, child } = payload;

  const searchParams = {
    format: 'json',
    departure,
    country,
    datefrom,
    dateto,
    nightsfrom,
    nightsto,
    adults,
    child: child || 0,
    authlogin: 'info@meridiantt.com',
    authpass: 'Mh4GdKPUtwZT'
  };

  try {
    const { data } = await axios.get('https://tourvisor.ru/xml/search.php', { params: searchParams });

console.log('🔍 Ответ от search.php:', JSON.stringify(data)); // Добавим лог

const requestid = data.requestid;
if (!requestid) {
  console.log('⚠️ RequestID отсутствует. Возможно, проблема в параметрах или авторизации.');
  throw new Error('Не получен requestid');
}

    for (let i = 0; i < 6; i++) {
      const res = await axios.get('https://tourvisor.ru/xml/result.php', {
        params: {
          requestid,
          format: 'json',
          authlogin: searchParams.authlogin,
          authpass: searchParams.authpass
        }
      });

      if (res.data.status?.state === 'finished' && res.data.result?.hotel?.length > 0) {
        return res.data.result.hotel.slice(0, 3);
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  } catch (error) {
    return { error: error.message };
  }
}

module.exports = { searchToursTest };
