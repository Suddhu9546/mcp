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
    'Returns the menu of the three things this server does, plus a session_id. CALL THIS FIRST ' +
    'whenever the user opens without naming one of them -- "hi", "hello", "start", "let\'s ' +
    'start", "can we start", "let\'s get started", "i want to generate a storyboard", "how can ' +
    'you help me", "what can you do", "begin" -- and again whenever they finish one thing and ' +
    'want another. Print the three options exactly as returned and wait. Add no preamble, no ' +
    'explanation of the options, no recommendation and no question of your own, and begin no ' +
    'work until the user picks one. The options are: 1 generate storyboard, 2 generate video ' +
    'script, 3 read handbook content. Answer with flow_choose. Sessions are independent and ' +
    'cheap, so call this again rather than reusing a finished one.',
  inputSchema: {},
  handler: () => ok(startFlow()),
};

const flowChooseTool: ToolDefinition = {
  name: 'flow_choose',
  title: 'Answer the current flow step',
  description:
    "Applies the user's answer to the step a session is on and returns the next step, with its " +
    'prompt and options. Pass what the user actually said. Every step accepts the number it ' +
    'showed and the option value; a subject step also accepts the subject name. The storyboard ' +
    'flow runs menu -> course (Entrepreneur / Orientation / CDR) -> subject, and then it is ' +
    'done: it asks nothing more and generation starts. The video-script flow runs menu -> ' +
    'subject -> module, and the reading flow one level further to the unit. In the content ' +
    'flows an answer that matches no option is tried as a topic name before it is rejected, so ' +
    'a user who types "quality control of biomass pellets" is taken straight to the unit that ' +
    'holds it. An answer that matches nothing re-asks the same step with an explanation rather ' +
    'than guessing. Two answers work everywhere, finished steps included: "back" changes the ' +
    "previous answer, and \"restart\" returns to the menu. Follow the step's next_action " +
    'exactly; when a step reports done, everything it needed has been asked, so generate with ' +
    'no further questions and no confirmation.',
  inputSchema: {
    session_id: z.string(),
    choice: z
      .string()
      .describe(
        'What the user said: the number shown ("1"), an option value ("storyboard", ' +
          '"entrepreneur", "solar-pv", "7.1"), a subject or topic name, or "back" / "restart".',
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
