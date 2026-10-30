import {
  BaseChatModel,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

export type ScriptStep =
  AIMessage | ((messages: BaseMessage[]) => AIMessage | Promise<AIMessage>);

/**
 * Deterministic model double for offline tests: each invocation returns the
 * next scripted step, so tests drive the real graph and executor.
 */
export class ScriptedChatModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = [];
  /** Names of the tools bound when each call was made. */
  readonly toolsPerCall: string[][] = [];
  boundTools: BindToolsInput[] = [];
  private index = 0;

  constructor(private readonly steps: ScriptStep[]) {
    super({});
  }

  _llmType() {
    return "scripted";
  }

  override bindTools(tools: BindToolsInput[]) {
    this.boundTools = tools;
    return this as unknown as ReturnType<BaseChatModel["withConfig"]>;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const step = this.steps[this.index];
    if (!step) {
      throw new Error(`Scripted model exhausted after ${this.index} calls`);
    }
    this.index += 1;
    this.calls.push(messages);
    this.toolsPerCall.push(
      this.boundTools.map(
        (tool) => (tool as { function: { name: string } }).function.name,
      ),
    );
    const message = typeof step === "function" ? await step(messages) : step;
    return { generations: [{ message, text: message.text }] };
  }
}

export const toolCall = (
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}`,
) =>
  new AIMessage({
    content: "",
    tool_calls: [{ id, name, args, type: "tool_call" }],
  });

export const reply = (text: string) => new AIMessage(text);
