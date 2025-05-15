const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current temperature for provided coordinates in celsius.",
    parameters: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" }
      },
      required: ["latitude", "longitude"],
      additionalProperties: false
    },
    strict: true
  }
}];

// Ваша реальная функция
async function get_weather({ latitude, longitude }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m`;
  const res = await axios.get(url);
  return `Current temperature is ${res.data.current.temperature_2m}°C`;
}

// SSE endpoint
app.get('/weather-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const messages = [
    { role: "user", content: "What's the weather like in Paris today?" }
  ];

  const stream = await openai.beta.threads.createAndRun({
    assistant_id: process.env.ASSISTANT_ID,
    thread: { messages },
    tools,
    stream: true
  });

  const final_tool_calls = {};

  for await (const event of stream) {
    if (event.event === 'thread.run.requires_action') {
      const toolCalls = event.data.required_action.submit_tool_outputs.tool_calls;

      const results = await Promise.all(toolCalls.map(async (toolCall) => {
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        let output = '';
        if (name === 'get_weather') {
          output = await get_weather(args);
        }

        return {
          tool_call_id: toolCall.id,
          output: output.toString()
        };
      }));

      await openai.beta.threads.runs.submitToolOutputs({
        thread_id: event.data.thread_id,
        run_id: event.data.id,
        tool_outputs: results
      });

    } else if (event.event === 'thread.message.delta') {
      const text = event.data.delta.content;
      if (text) {
        res.write(`data: ${text}\n\n`);
      }
    } else if (event.event === 'thread.run.completed') {
      res.write(`data: [done]\n\n`);
      res.end();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌤️ Weather function server running on port ${PORT}`));
