import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  ollamaUrl: z
    .string()
    .default("http://localhost:11434")
    .describe("Ollama API base URL"),
  model: z
    .string()
    .default("qwen3:14b")
    .describe("Ollama model to use"),
});

const ResultSchema = z.object({
  input: z.string().describe("The input that was sent"),
  raw: z.string().describe("Raw response from the model"),
  parsed: z.record(z.string(), z.unknown()).optional().describe(
    "Parsed JSON if response was valid JSON",
  ),
  model: z.string().describe("Model used"),
  duration: z.number().describe("Generation time in ms"),
});

export async function ollamaGenerate(
  ollamaUrl: string,
  model: string,
  prompt: string,
  input: string,
): Promise<string> {
  const resp = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `${prompt}\n\n${input}` }],
      stream: false,
      options: { num_predict: 1024 },
      think: false,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama error (${resp.status}): ${await resp.text()}`);
  }

  // deno-lint-ignore no-explicit-any
  const json: any = await resp.json();
  let raw = (json.message?.content ?? "").trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return raw;
}

export const model = {
  type: "@keeb/ollama",
  version: "2026.03.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "LLM generation result",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    generate: {
      description:
        "Send a prompt and input to Ollama, return structured output",
      arguments: z.object({
        prompt: z.string().describe("System prompt / instructions"),
        input: z.string().describe("Input to process"),
        instanceName: z
          .string()
          .optional()
          .describe("Resource instance name (defaults to slugified input)"),
      }),
      execute: async (
        args: { prompt: string; input: string; instanceName?: string },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const { ollamaUrl, model: ollamaModel } = context.globalArgs;

        const start = Date.now();
        const raw = await ollamaGenerate(
          ollamaUrl,
          ollamaModel,
          args.prompt,
          args.input,
        );
        const duration = Date.now() - start;

        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // not JSON, that's fine
        }

        const name = args.instanceName ?? slugify(args.input);
        const handle = await context.writeResource("result", name, {
          input: args.input,
          raw,
          parsed,
          model: ollamaModel,
          duration,
        });

        context.logger.info(
          `Generated in ${duration}ms (${raw.length} chars)`,
        );

        return { dataHandles: [handle] };
      },
    },

    unload: {
      description: "Unload the model from VRAM to free GPU memory",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: any, context: any) => {
        const { ollamaUrl, model: ollamaModel } = context.globalArgs;

        const resp = await fetch(`${ollamaUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: ollamaModel,
            keep_alive: 0,
          }),
        });

        if (!resp.ok) {
          throw new Error(
            `Ollama error (${resp.status}): ${await resp.text()}`,
          );
        }

        context.logger.info(`Unloaded ${ollamaModel} from VRAM`);

        const handle = await context.writeResource("result", "unload", {
          input: "unload",
          raw: "model unloaded",
          model: ollamaModel,
          duration: 0,
        });

        return { dataHandles: [handle] };
      },
    },

    generate_batch: {
      description:
        "Send multiple inputs through the same prompt (factory: one resource per input)",
      arguments: z.object({
        prompt: z.string().describe("System prompt / instructions"),
        inputs: z
          .array(z.string())
          .describe("List of inputs to process"),
      }),
      execute: async (
        args: { prompt: string; inputs: string[] },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const { ollamaUrl, model: ollamaModel } = context.globalArgs;
        // deno-lint-ignore no-explicit-any
        const handles: any[] = [];

        for (const input of args.inputs) {
          const start = Date.now();

          let raw: string;
          try {
            raw = await ollamaGenerate(
              ollamaUrl,
              ollamaModel,
              args.prompt,
              input,
            );
          } catch (err) {
            context.logger.error(
              `Ollama error for "${input}": ${err}`,
            );
            continue;
          }

          const duration = Date.now() - start;

          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // not JSON
          }

          const handle = await context.writeResource(
            "result",
            slugify(input),
            {
              input,
              raw,
              parsed,
              model: ollamaModel,
              duration,
            },
          );
          handles.push(handle);

          context.logger.info(
            `[${handles.length}/${args.inputs.length}] "${
              input.slice(0, 60)
            }" → ${duration}ms`,
          );
        }

        return { dataHandles: handles };
      },
    },
  },
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
