const { config } = require('dotenv');
const { OpenAI } = require('openai');
const fs = require('fs');

config(); // загружаем .env

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function createAssistant() {
  try {
    const assistant = await client.beta.assistants.create({
      name: "ТурПомощник",
      instructions:
        "Ты виртуальный помощник туристического агентства. Когда пользователь просит найти тур, вызывай функцию search_tours, передай её параметры как JSON POST-запрос на https://sse-proxy.onrender.com/search-tours. Верни 3 самых дешевых тура.",
      model: "gpt-4o",
      tools: [
        {
          type: "function",
          function: {
            name: "search_tours",
            description: "Поиск туров по заданным параметрам с использованием API Tourvisor",
            parameters: {
              type: "object",
              properties: {
                departure: { type: "string", description: "Город вылета, например 'Астана'" },
                country: { type: "string", description: "Страна назначения, например 'Турция'" },
                datefrom: { type: "string", description: "Дата вылета, формат ДД.ММ.ГГГГ" },
                dateto: { type: "string", description: "Дата окончания, формат ДД.ММ.ГГГГ" },
                nightsfrom: { type: "integer", description: "Минимум ночей" },
                nightsto: { type: "integer", description: "Максимум ночей" },
                adults: { type: "integer", description: "Количество взрослых" },
                child: { type: "integer", description: "Количество детей" },
                childage1: { type: "integer", description: "Возраст 1-го ребенка (если есть)" },
                childage2: { type: "integer", description: "Возраст 2-го ребенка (если есть)" },
              },
              required: ["departure", "country", "datefrom", "dateto", "nightsfrom", "nightsto", "adults"],
            },
          },
        },
      ],
    });

    console.log(`✅ Assistant создан: ${assistant.id}`);

    // Сохраняем в .env
    const envPath = '.env';
    let envContent = fs.readFileSync(envPath, 'utf-8');
    if (!envContent.includes('ASSISTANT_ID=')) {
      envContent += `\nASSISTANT_ID=${assistant.id}\n`;
    } else {
      envContent = envContent.replace(/ASSISTANT_ID=.*/g, `ASSISTANT_ID=${assistant.id}`);
    }
    fs.writeFileSync(envPath, envContent);
    console.log('✅ ID ассистента записан в .env');
  } catch (error) {
    console.error('❌ Ошибка создания ассистента:', error.response?.data || error.message);
  }
}

createAssistant();
