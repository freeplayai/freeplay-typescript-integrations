import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
} from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import {
  getPrompt,
  FreeplayModel,
  createFreeplayTelemetry,
} from "@freeplayai/vercel";

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
    const inputVariables = {
      character: "Cowboy",
    };

    /**
     * Get prompt from Freeplay
     *
     * This prompt is set up as:
     *
     * {
     *   "role": "system",
     *   "content": "Please answer the user's queries by playing the character of a {{character}}"
     * }
     */
    const prompt = await getPrompt({
      templateName: "support-character", // TODO: Replace with your prompt name
      variables: inputVariables,
      messages,
    });

    // Automatically select the correct model provider based on the prompt
    const model = await FreeplayModel(prompt);

    const tools = await client.tools();

    const result = streamText({
      model,
      tools,
      stopWhen: stepCountIs(5),
      system: prompt.systemContent,
      messages: await convertToModelMessages(messages),
      onFinish: async () => {
        await client.close();
      },
      experimental_telemetry: createFreeplayTelemetry(prompt, {
        functionId: "next-example-with-freeplay",
        sessionId: id,
        inputVariables,
      }),
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Unexpected error" }, { status: 500 });
  }
}
