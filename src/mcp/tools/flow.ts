/**
 * The three tools that drive the guided flow.
 *
 * They are the only entry point a user who has not named a task needs: start_flow
 * shows the menu, flow_choose answers whatever the current step asked, and get_flow
 * re-reads a session. All the branching lives in ../../flow/session.ts; these are
 * a thin surface over it so that the state machine is described in one place.
 */

import { z } from 'zod';
import { advanceFlow, getFlow, startFlow } from '../../flow/session.js';
import type { ToolDefinition } from './result.js';
import { ok } from './result.js';

const startFlowTool: ToolDefinition = {
  name: 'start_flow',
  title: 'Show the menu',
  description:
    'Returns the three things this server can do, as a menu, plus a session_id. CALL THIS FIRST ' +
    'whenever the user opens with an unscoped request -- "can we start", "let\'s start", "show ' +
    'me what you have", "what can you do", "hi", "begin" -- and whenever they finish one thing ' +
    'and want another. Show the three options to the user and wait for their pick; do not ask ' +
    'any question of your own before or after, and do not begin work until they have chosen. ' +
    'The options are: 1 video script + slide deck for a module, 2 read a handbook unit word for ' +
    'word, 3 course storyboard. Answer with flow_choose. Sessions are independent and cheap, so ' +
    'call this again rather than reusing a finished one.',
  inputSchema: {},
  handler: () => ok(startFlow()),
};

const flowChooseTool: ToolDefinition = {
  name: 'flow_choose',
  title: 'Answer the current flow step',
  description:
    "Applies the user's answer to the step a session is on and returns the next step, with its " +
    'prompt and options. Pass what the user actually said. Each step accepts its option values, ' +
    'and the menu also accepts 1, 2 or 3. An answer that matches no option is tried as a topic ' +
    'name before it is rejected, so a user who types "quality control of biomass pellets" at the ' +
    'subject or module step is taken straight to the unit that holds it. An answer that matches ' +
    'neither re-asks the same step with an explanation rather than guessing. Two answers work ' +
    'everywhere, finished steps included: "back" changes the previous answer, and "restart" ' +
    'clears the session and returns to the menu. Follow the step\'s next_action exactly; when a ' +
    'step reports done, everything it needed has been asked, so generate without further ' +
    'questions.',
  inputSchema: {
    session_id: z.string(),
    choice: z
      .string()
      .describe(
        'What the user said: an option value ("module_content", "biofuels", "7", "7.1"), the ' +
          'menu number 1-3, a topic name, or "back" / "restart".',
      ),
  },
  handler: async (args) => ok(await advanceFlow(String(args.session_id), String(args.choice))),
};

const flowStatusTool: ToolDefinition = {
  name: 'get_flow',
  title: 'Get flow session',
  description:
    'Re-renders the step a session is on, with its prompt, options and selections so far. Use it ' +
    'to resume after a gap. It advances nothing.',
  inputSchema: { session_id: z.string() },
  handler: (args) => ok(getFlow(String(args.session_id))),
};

export const FLOW_TOOLS: ToolDefinition[] = [startFlowTool, flowChooseTool, flowStatusTool];
