import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ModelMessage,
  stepCountIs,
  streamText,
} from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFreeplaySpanProcessor,
  getPrompt,
  FreeplayModel,
  createFreeplayTelemetry,
} from "@freeplayai/vercel";
import {
  expressToIncomingMessage,
  wrapExpressResponse,
} from "./mcp/express-adapter.js";
import { createMcpHandler } from "./mcp/handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from shared examples/.env
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// Initialize OpenTelemetry with Freeplay
const sdk = new NodeSDK({
  spanProcessors: [createFreeplaySpanProcessor()],
});

// Start the SDK
sdk.start();

// Graceful shutdown
process.on("SIGTERM", async () => {
  await sdk.shutdown();
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Validate Freeplay configuration
app.get("/api/validate/freeplay", (req, res) => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for at least one model provider API key
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const hasVertex =
    !!process.env.GOOGLE_VERTEX_PROJECT && !!process.env.GOOGLE_CLIENT_EMAIL;
  const hasAIGateway = !!process.env.AI_GATEWAY_API_KEY;

  if (
    !hasOpenAI &&
    !hasAnthropic &&
    !hasGoogle &&
    !hasVertex &&
    !hasAIGateway
  ) {
    errors.push(
      "No model provider API key found. Please set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or configure Google Vertex AI",
    );
  }

  // Add helpful warnings
  if (!process.env.FREEPLAY_OTEL_ENDPOINT) {
    warnings.push(
      "FREEPLAY_OTEL_ENDPOINT is not set. Using default: https://api.freeplay.ai/api/v0/otel/v1/traces",
    );
  }

  res.json({
    valid: errors.length === 0,
    errors,
    warnings,
  });
});

// MCP Server endpoint
const mcpHandler = createMcpHandler();
app.post("/api/mcp/server", async (req, res) => {
  const incomingMessage = expressToIncomingMessage(req);
  const serverResponse = wrapExpressResponse(res);
  await mcpHandler(incomingMessage, serverResponse);
});

// MCP Chat endpoint with Freeplay Prompt Management
app.post("/api/mcp/chat/freeplay", async (req, res) => {
  try {
    const { messages, sessionId } = req.body;

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

    // Create MCP client connecting to our local server
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${PORT}/api/mcp/server`),
    );

    const client = await createMCPClient({
      transport,
    });

    const tools = await client.tools();

    const result = streamText({
      model,
      tools,
      stopWhen: stepCountIs(5),
      system: prompt.systemContent,
      messages: messages,
      onFinish: async () => {
        await client.close();
      },
      experimental_telemetry: createFreeplayTelemetry(prompt, {
        functionId: "node-example-with-freeplay",
        sessionId: sessionId,
        inputVariables,
      }),
    });

    // Set headers for streaming
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Stream the response
    const stream = result.textStream;

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unexpected error" });
  }
});

// MCP Chat endpoint without Freeplay (Static values)
app.post("/api/mcp/chat/static", async (req, res) => {
  try {
    const { messages, sessionId } = req.body;

    // Import anthropic model provider
    const { openai } = await import("@ai-sdk/openai");

    // Create MCP client connecting to our local server
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${PORT}/api/mcp/server`),
    );

    const client = await createMCPClient({
      transport,
    });

    const tools = await client.tools();

    const result = streamText({
      model: openai("gpt-4.1"),
      tools,
      stopWhen: stepCountIs(5),
      system: "You are a helpful assistant.",
      messages: messages,
      onFinish: async () => {
        await client.close();
      },
      experimental_telemetry: {
        isEnabled: true,
        functionId: "node-example-static",
        metadata: {
          sessionId: sessionId,
        },
      },
    });

    // Set headers for streaming
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Stream the response
    const stream = result.textStream;

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unexpected error" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n⏳ SIGINT received, shutting down gracefully...");

  server.close(async () => {
    console.log("✅ HTTP server closed");

    try {
      await sdk.shutdown();
      console.log("✅ OpenTelemetry SDK shut down successfully");
      process.exit(0);
    } catch (error) {
      console.error("❌ Error shutting down SDK:", error);
      process.exit(1);
    }
  });
});
