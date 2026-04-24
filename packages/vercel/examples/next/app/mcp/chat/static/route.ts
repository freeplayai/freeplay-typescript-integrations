import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
} from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";

export async function POST(req: Request) {
  const url = new URL("http://localhost:3000/mcp/server");
  const transport = new StreamableHTTPClientTransport(url);

  const [client, { messages, id }] = await Promise.all([
    createMCPClient({
      transport,
    }),
    req.json(),
  ]);

  try {
    const tools = await client.tools();

    const result = streamText({
      model: openai("gpt-4o"),
      tools,
      stopWhen: stepCountIs(5),
      system: "You are a helpful assistant.",
      messages: await convertToModelMessages(messages),
      onFinish: async () => {
        await client.close();
      },
      experimental_telemetry: {
        isEnabled: true,
        functionId: "next-example-static",
        metadata: {
          sessionId: id,
        },
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Unexpected error" }, { status: 500 });
  }
}
