// Illustrative only — not compiled as part of this repo. See ../../../README.md.

import { convertToModelMessages, streamText, tool, type UIMessage } from 'ai';
import { z } from 'zod';

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'your-provider/your-model', // e.g. openai('gpt-...') or anthropic('claude-...')
    messages: await convertToModelMessages(messages),
    tools: {
      sendEmail: tool({
        description: 'Send an email on behalf of the user.',
        inputSchema: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
        // AI SDK pauses here and emits a tool part in `approval-requested` state.
        // fromUIMessages() turns that into APPROVAL_REQUESTED in the session log.
        needsApproval: true,
        execute: async ({ to, subject }) => ({ sent: true, to, subject }),
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
