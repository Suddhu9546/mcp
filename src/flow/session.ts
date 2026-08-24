/**
 * The guided flow: one menu, then the shortest path to the thing the user asked
 * for.
 *
 * Three flows share this machine and never mix. A session records which flow it
 * is in and which step it reached, so a module-content session cannot wander into
 * the reading flow's terminal step, and a reading session can never reach
 * generation at all -- its branch has no generation step to reach.
 *
 * The design rule is that the flow asks only for what it cannot work out. It does
 * not ask how the user would like to choose, or which course type, or how long the
 * output should be: the menu is followed by subject, then module, and for reading
 * one more level to the unit. Anything the user types that is not an option is
 * tried as a topic name first, so someone who already knows their topic reaches it
 * by typing it rather than by being offered a mode.
 *
 * State is in SQLite rather than memory, so a session survives a server restart
 * and "where did we get to" is an answerable question. Sessions are cheap:
 * "restart" at any point, finished steps included, returns to the menu, and
 * start_flow opens an independent one.
 */

import { TRACK_LABELS, listSubjectStatuses, type CourseTrack } from '../catalog/subject-catalog.js';
import { findPhUnits, getPhOutline, readPhModule, readPhUnit } from '../documents/ph-outline.js';
import { ingestCourse } from '../documents/ingest.js';
import { isCdrCourse, cdrCourseStatus } from '../cdr/catalog.js';
import {
  describeExisting,
  findReusableStoryboard,
  listReusableStoryboards,
  matchReuseAnswer,
  renderedLabel,
  reuseOptions,
  type ReusableStoryboard,
} from '../storyboard/reuse.js';
import {
  isPreparedCourse,
  listPreparedCdrStoryboards,
  preparedStoryboard,
  type PreparedStoryboard,
} from '../cdr/prepared.js';
import { templateTrackFor } from '../courses/course-config.js';
import {
  findStoryboardCourse,
  findTrack,
  listStoryboardCourses,
  listStoryboardTracks,
  storyboardCourseStatus,
} from './storyboard-catalog.js';
import { getDb, nowIso } from '../storage/db.js';
import { buildModulePlan } from '../video/module-plan.js';
import { createModulePackage, getModulePackage } from '../video/module-store.js';
import { renderUnitReading } from '../video/render.js';

export type FlowKind = 'storyboard' | 'module_content' | 'ph_reading';

/**
 * Menu answers.
 *
 * The numbers are what the user is shown and so are what they type. The words
 * are there because a user who says "storyboard" rather than "1" has answered
 * the question just as clearly, and the older names are kept so a client holding
 * a previous menu's vocabulary still lands on the right flow.
 */
const FLOW_ALIASES: Record<string, FlowKind> = {
  '1': 'storyboard',
  storyboard: 'storyboard',
  story_board: 'storyboard',
  cdr_storyboard: 'storyboard',
  '2': 'module_content',
  video_script: 'module_content',
  module_content: 'module_content',
  video_transcript: 'module_content',
  video: 'module_content',
  script: 'module_content',
  '3': 'ph_reading',
  handbook_reading: 'ph_reading',
  ph_reading: 'ph_reading',
  reading: 'ph_reading',
  read: 'ph_reading',
};

export type FlowStepName =
  | 'choose_flow'
  | 'choose_track'
  | 'choose_subject'
  | 'choose_module'
  | 'choose_unit'
  | 'choose_candidate'
  | 'choose_storyboard_source'
  | 'storyboard_ready'
  | 'module_ready'
  | 'reading_complete';

interface Candidate {
  unit_code: string;
  subject_id: string;
  course_id: string;
  module_number: number;
  label: string;
}

interface FlowState {
  flow?: FlowKind;
  track?: CourseTrack;
  subject_id?: string;
  course_id?: string;
  module_number?: number;
  /** Reading flow only. The module-content flow stops at the module. */
  unit_code?: string;
  package_id?: string;
  candidates?: Candidate[];
  /**
   * Storyboard flow only. The saved storyboard the user chose to reuse or
   * re-render, so the terminal step can name it without looking it up again.
   */
  reuse_artifact_id?: string;
  /**
   * The document the user picked. Held as a path rather than an artifact id
   * because several of a subject's storyboards can be on offer and one of them may
   * carry no id in its filename at all.
   */
  reuse_docx_path?: string;
  reuse_rendered_at?: string;
  /**
   * Set when the user was offered a saved storyboard and asked for a new one
   * anyway. The build instruction then carries regenerate: true, because the tool
   * refuses by default -- it has to, since a client that skips these questions
   * would otherwise rebuild a subject that already had a finished document.
   */
  declined_existing?: boolean;
}

export interface FlowOption {
  value: string;
  label: string;
  detail?: string;
  /** Set when the option cannot be chosen yet, with the reason in `blocker`. */
  disabled?: boolean;
  blocker?: string;
}

export interface FlowStep {
  session_id: string;
  flow?: FlowKind;
  step: FlowStepName;
  /** Ask the user this -- it is the question the step needs answered. */
  prompt: string;
  options?: FlowOption[];
  /** Payload for terminal steps: the module plan, the handbook text, and so on. */
  data?: Record<string, unknown>;
  /** What the client should do next, when it is not simply "ask the prompt". */
  next_action?: string;
  /** Set when the previous choice could not be applied; the step is unchanged. */
  error?: string;
  done: boolean;
  selections: FlowState;
}

const GREETING = 'I can build content from the SCGJ course documents. What would you like?';

const ALWAYS_AVAILABLE =
  'Show the options as a numbered list, exactly as given, and let the user reply with a number ' +
  'or a name. Add nothing of your own: no preamble, no explanation of the options, no ' +
  'recommendation, no follow-up question. "back" changes the previous answer; "restart" returns ' +
  'to the menu from any step, finished ones included.';

class FlowError extends Error {}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function nextSessionId(): string {
  const year = new Date().getUTCFullYear();
  const prefix = `FS-${year}-`;
  const row = getDb()
    .prepare('SELECT session_id FROM flow_sessions WHERE session_id LIKE ? ORDER BY session_id DESC LIMIT 1')
    .get(`${prefix}%`) as { session_id: string } | undefined;
  const last = row ? Number(row.session_id.slice(prefix.length)) : 0;
  return `${prefix}${String(last + 1).padStart(5, '0')}`;
}

interface SessionRow {
  session_id: string;
  step: FlowStepName;
  state: FlowState;
}

function loadSession(sessionId: string): SessionRow {
  const row = getDb()
    .prepare('SELECT session_id, step, state_json FROM flow_sessions WHERE session_id = ?')
    .get(sessionId) as { session_id: string; step: FlowStepName; state_json: string } | undefined;
  if (!row) {
    throw new FlowError(
      `No flow session "${sessionId}". Call start_flow to begin, or use the direct tools ` +
        '(plan_module_content, read_ph_unit), which need no session.',
    );
  }
  return { session_id: row.session_id, step: row.step, state: JSON.parse(row.state_json) as FlowState };
}

function saveSession(sessionId: string, step: FlowStepName, state: FlowState): void {
  getDb()
    .prepare('UPDATE flow_sessions SET flow = ?, step = ?, state_json = ?, updated_at = ? WHERE session_id = ?')
    .run(state.flow ?? null, step, JSON.stringify(state), nowIso(), sessionId);
}

// ---------------------------------------------------------------------------
// Step builders
// ---------------------------------------------------------------------------

function base(sessionId: string, state: FlowState, step: FlowStepName, error?: string) {
  return {
    session_id: sessionId,
    ...(state.flow ? { flow: state.flow } : {}),
    step,
    done: false,
    selections: state,
    ...(error ? { error } : {}),
  };
}

/**
 * The menu.
 *
 * Three lines and nothing else. Everything the previous menu explained -- what
 * each option produces, how long it runs, which subjects are available -- is
 * answered by the step that follows, and putting it here made the first thing a
 * user saw a wall of text about choices they had not made yet.
 */
function chooseFlowStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  return {
    ...base(sessionId, state, 'choose_flow', error),
    prompt: GREETING,
    options: [
      { value: 'storyboard', label: '1. Generate storyboard' },
      { value: 'module_content', label: '2. Generate video script' },
      { value: 'ph_reading', label: '3. Read handbook content' },
    ],
    next_action:
      'Show exactly these three lines and wait. Do not describe them, do not add a fourth, and ' +
      'do not begin any work until the user picks one. ' +
      ALWAYS_AVAILABLE,
  };
}

/**
 * Which programme the storyboard is for.
 *
 * The three tracks are genuinely different documents -- different template,
 * different sources, different module routing -- so this is the first thing the
 * storyboard flow has to know, and it is the only flow that asks it. The content
 * flows do not: a subject carries its own track, and asking would cost a turn to
 * learn something already known.
 */
function chooseTrackStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  const tracks = listStoryboardTracks();
  return {
    ...base(sessionId, state, 'choose_track', error),
    prompt: 'Which course?',
    options: tracks.map((t, i) => ({ value: t.track, label: `${i + 1}. ${t.label}` })),
    next_action: `Show these ${tracks.length} lines and wait. ${ALWAYS_AVAILABLE}`,
  };
}

/**
 * Which course of that track.
 *
 * Listed from the course registry rather than the subject catalogue, because a
 * storyboard needs more than a handbook: four approved documents and a reviewed
 * crosswalk. A course short of either is shown and shown as unavailable with the
 * reason, rather than hidden -- a subject that silently vanishes from a list
 * reads as a bug, and the reason is the thing someone has to act on.
 */
function chooseStoryboardCourseStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  const track = state.track as CourseTrack;
  const courses = listStoryboardCourses(track);
  return {
    ...base(sessionId, state, 'choose_subject', error),
    prompt: `Which ${TRACK_LABELS[track]} subject?`,
    options: courses.map((c, i) => ({
      value: c.course_id,
      label: `${i + 1}. ${c.name}`,
      ...(c.selectable ? {} : { disabled: true, blocker: c.blocker! }),
    })),
    next_action:
      'Show these lines and wait. A line marked unavailable stays in the list, with its reason ' +
      'available if the user asks; do not drop it and do not lead with it. ' +
      ALWAYS_AVAILABLE,
  };
}

/**
 * One subject list for every flow.
 *
 * Course type used to be a separate question. It is a property of each subject, so
 * it is shown as a grouping label instead of costing the user a turn.
 */
function chooseSubjectStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  // The storyboard flow has already asked for a track and draws from the course
  // registry; the content flows draw from the handbook subject catalogue. The two
  // lists answer different questions about readiness and are never interchanged.
  if (state.flow === 'storyboard') return chooseStoryboardCourseStep(sessionId, state, error);

  const ordered = [...listSubjectStatuses()].sort(
    (a, b) => Number(b.selectable) - Number(a.selectable) || Number(b.ready) - Number(a.ready),
  );
  const verb = state.flow === 'ph_reading' ? 'read from' : 'build a video script for';
  return {
    ...base(sessionId, state, 'choose_subject', error),
    prompt: `Which subject do you want to ${verb}?`,
    options: ordered.map((s) => ({
      value: s.subject_id,
      label: `${s.code} - ${s.name}`,
      detail: TRACK_LABELS[s.track],
      ...(s.selectable ? {} : { disabled: true, blocker: s.blocker! }),
    })),
    next_action:
      'List the selectable subjects first and mark the rest unavailable rather than hiding them. ' +
      'Picking one that has never been indexed indexes it first, which takes a few seconds once ' +
      'and needs nothing from the user -- do not mention it or ask them to run anything. If the ' +
      'user names a topic instead of a subject, pass what they said straight through: it is ' +
      'resolved to the unit that holds it.',
  };
}

function chooseModuleStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  const outline = getPhOutline(state.course_id!);
  return {
    ...base(sessionId, state, 'choose_module', error),
    prompt:
      `All ${outline.module_count} modules in the ${outline.subject_code ?? outline.course_id} ` +
      'Participant Handbook. Which one?',
    options: outline.modules.map((m) => ({
      value: String(m.module_number),
      label: `Module ${m.module_number} - ${m.title}`,
      // The unit titles, because a handbook that prints no chapter headings leaves
      // the module titled "Module 3" and the list otherwise unreadable. Inventing a
      // title from the units would misdescribe the module; listing them does not.
      detail: `${m.unit_count} unit${m.unit_count === 1 ? '' : 's'}${
        m.has_units ? `: ${m.units.map((u) => u.title).join('; ')}` : ''
      }`,
      ...(m.has_units ? {} : { disabled: true, blocker: m.note! }),
    })),
    data: {
      module_count: outline.module_count,
      selectable_module_count: outline.selectable_module_count,
      unit_count: outline.unit_count,
    },
    next_action:
      'Write out every module in this order with its unit count and let the user reply with a ' +
      "number. This is the handbook's own table of contents, so showing a subset misrepresents " +
      'it. These are handbook chapter numbers; the Timing Allocation Document numbers modules ' +
      'differently and the two are never interchangeable.',
  };
}

function chooseUnitStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  const outline = getPhOutline(state.course_id!);
  const module = outline.modules.find((m) => m.module_number === state.module_number);
  if (!module) throw new FlowError(`Module ${state.module_number} is not in this handbook.`);
  return {
    ...base(sessionId, state, 'choose_unit', error),
    prompt: `All ${module.unit_count} units in Module ${module.module_number} - ${module.title}. Which unit?`,
    options: module.units.map((u) => ({
      value: u.unit_code,
      label: `Unit ${u.unit_code} - ${u.title}`,
      detail: `handbook pp. ${u.pdf_page_start}-${u.pdf_page_end}`,
    })),
    next_action: 'List every unit shown here, not a subset.',
  };
}

/** Reached only when a typed topic matched several units closely. */
function chooseCandidateStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  const candidates = state.candidates ?? [];
  return {
    ...base(sessionId, state, 'choose_candidate', error),
    prompt: 'That matches more than one unit. Which did you mean?',
    options: [
      ...candidates.map((c) => ({
        value: c.unit_code,
        label: c.label,
        detail: `${c.subject_id} handbook, module ${c.module_number}`,
      })),
      { value: 'browse', label: 'None of these - show me the list instead' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Terminal steps -- one per flow, and each flow has exactly one
// ---------------------------------------------------------------------------

/**
 * Terminal step of the module-content flow.
 *
 * The flow stops at the module because what follows is fixed: 3 minutes of video
 * in eighteen 10-second segments plus a 9-minute deck, covering every unit of the
 * module. There is nothing further to ask, so nothing further is asked.
 */
function moduleReadyStep(sessionId: string, state: FlowState): FlowStep {
  // Re-reading a finished session must not plan a second package.
  const packageState = state.package_id
    ? getModulePackage(state.package_id)
    : createModulePackage(
        buildModulePlan({ reading: readPhModule(state.course_id!, state.module_number!) }),
      );

  const next = { ...state, package_id: packageState.package_id };
  saveSession(sessionId, 'module_ready', next);

  const plan = packageState.plan;
  return {
    session_id: sessionId,
    flow: 'module_content',
    step: 'module_ready',
    prompt:
      `Building Module ${plan.module_number} - ${plan.module_title}: a 3-minute video in ` +
      `${plan.video.segment_count} ten-second segments plus a ${plan.slides.slide_count}-slide, ` +
      `9-minute deck, covering all ${plan.units.length} units.`,
    data: { package_id: packageState.package_id, base_version: packageState.version, plan },
    next_action:
      'Generate now, asking nothing further -- the duration and the units are settled. ' +
      'get_module_content_spec, get_module_source, set_module_story, submit_module_video (18 ' +
      'segments), submit_module_slides, validate_module_package, export_module_package. Attach ' +
      'the files export_module_package returns so the user can download the script, the ' +
      'subtitles and the deck. For a different module, say "restart" on this session.',
    done: true,
    selections: next,
  };
}

/** Terminal step of the reading flow. This branch has no generation step at all. */
function readingCompleteStep(sessionId: string, state: FlowState): FlowStep {
  const reading = readPhUnit(state.course_id!, state.unit_code!);
  saveSession(sessionId, 'reading_complete', state);
  return {
    session_id: sessionId,
    flow: 'ph_reading',
    step: 'reading_complete',
    prompt: `Unit ${reading.unit.unit_code} - ${reading.unit.title}, exactly as the handbook has it.`,
    data: {
      unit: reading.unit,
      text: reading.text,
      word_count: reading.word_count,
      fidelity_note: reading.fidelity_note,
      rendered: renderUnitReading(reading),
    },
    next_action:
      'Return this text to the user unchanged. Do not summarise, shorten, re-order, correct or ' +
      'add to it, and do not offer to. If the user then wants a video, that is a separate ' +
      'request: say "restart" on this session rather than reworking this text.',
    done: true,
    selections: state,
  };
}

/**
 * Terminal step of the storyboard flow -- all three tracks.
 *
 * The subject was the last question, so this step does not ask another: it
 * resolves the course, states what is about to be built, and hands the client the
 * loop. The three tracks reach it by different routes and differ in exactly one
 * respect once here -- where a module's sources come from -- so they share this
 * step rather than owning three copies of it that drift apart.
 *
 * For CDR the per-module document routing is attached, because the client would
 * otherwise have to discover it; for a qualification course the crosswalk does the
 * same job invisibly inside the task queue and there is nothing to attach.
 */
/**
 * Terminal step for a course whose storyboard is supplied rather than built.
 *
 * CDR is that case. Its storyboard is a finished, hand-authored document -- five
 * modules, a fifty-question bank, a glossary -- reviewed as a deliverable in its
 * own right, so the flow hands it over and stops. Generating a second, lesser
 * version of a document that already exists is not a service to anyone, and for
 * this track it was never even possible: there is no templates/cdr/, so a CDR
 * render throws before it writes anything.
 *
 * Kept separate from `storyboardReusedStep` although both end in "give the user
 * this file". That step's subject has an artifact behind it that the build loop can
 * still be pointed at; this one has no artifact at all, and saying so is what stops
 * a client trying to improve on the document by rebuilding it.
 */
function preparedStoryboardStep(
  sessionId: string,
  state: FlowState,
  prepared: PreparedStoryboard,
): FlowStep {
  saveSession(sessionId, 'storyboard_ready', state);

  return {
    session_id: sessionId,
    flow: 'storyboard',
    step: 'storyboard_ready',
    prompt: `The ${prepared.name} storyboard is ready: ${prepared.docx_path}`,
    data: {
      course_id: prepared.course_id,
      track: 'cdr',
      source: 'prepared',
      docx_path: prepared.docx_path,
      bytes: prepared.bytes,
      updated_at: prepared.updated_at,
    },
    next_action:
      'Give the user the file at data.docx_path and stop. This storyboard is supplied as a ' +
      'finished document, not generated: do NOT create a draft, do NOT run the build loop, do ' +
      'NOT render anything, and do not offer to rebuild or improve it. There is no artifact ' +
      'behind it to edit. If the user wants it changed, say that it is a reviewed document held ' +
      'at that path and that changing it is a change to the document itself. ' +
      'This flow session holds no storyboard state; say "restart" on it to return to the menu.',
    done: true,
    selections: state,
  };
}

/**
 * Whether to reuse the storyboard this subject already has.
 *
 * Asked only when there is something to reuse. Authoring a storyboard is the
 * expensive step of this server, and the previous flow spent it again on every
 * request for a subject that had already been done -- not because the work was
 * lost, but because nothing offered it back.
 *
 * Two answers: hand over the document that was already rendered, or write a new
 * one. Only a storyboard with a rendered document on disk is offered, so the
 * question is never asked about content nobody has produced a deliverable from.
 *
 * When the sources have moved since the saved storyboard was written, that is said
 * here rather than discovered later. A stored citation is a position in a document,
 * not a handle on a piece of text, so a re-ingested handbook can leave a perfectly
 * valid-looking storyboard citing the wrong paragraph -- see
 * storage/source-fingerprint.ts.
 */
function chooseStoryboardSourceStep(
  sessionId: string,
  state: FlowState,
  existing: readonly ReusableStoryboard[],
  error?: string,
): FlowStep {
  const status = storyboardCourseStatus(state.course_id!);
  saveSession(sessionId, 'choose_storyboard_source', state);

  const options = reuseOptions(existing);
  const listed = options.length - 1; // the last option is "generate"
  const stale = existing.slice(0, listed).some((e) => e.verdict.state === 'changed');

  return {
    ...base(sessionId, state, 'choose_storyboard_source', error),
    flow: 'storyboard',
    step: 'choose_storyboard_source',
    prompt:
      `${status.name} already has ${listed === 1 ? 'a storyboard' : `${listed} storyboards`}. ` +
      `Use one of them, or generate a new one?`,
    options: options.map((o) => ({
      value: o.value,
      label: o.label,
      detail: o.detail,
    })),
    data: {
      course_id: state.course_id!,
      existing: existing.slice(0, listed).map((e, i) => ({
        option: i + 1,
        rendered_at: e.rendered_at,
        rendered_label: renderedLabel(e.rendered_at),
        docx_path: e.docx_path,
        filename: e.filename,
        known_locally: e.known_locally,
        ...(e.artifact_id ? { artifact_id: e.artifact_id } : {}),
        ...(e.version !== undefined ? { version: e.version } : {}),
        ...(e.module_count !== undefined ? { module_count: e.module_count } : {}),
        ...(e.created_at ? { built_at: e.created_at } : {}),
        sources_state: e.verdict.state,
        ...(e.verdict.state === 'changed' ? { source_changes: e.verdict.changes } : {}),
        ...(e.verdict.state === 'unknown' ? { source_note: e.verdict.reason } : {}),
      })),
      ...(existing.length > listed ? { older_not_listed: existing.length - listed } : {}),
    },
    next_action:
      'Show these options as a numbered list, exactly as given, with each label and its ' +
      'detail, then wait. The labels carry the date and time each storyboard was rendered, ' +
      'which is the only thing telling two of them apart -- do not shorten them away. Do not ' +
      'recommend one beyond what the options themselves say, do not begin generating, and do not ' +
      'call any storyboard tool yet.' +
      (stale
        ? ' The source documents have changed since the saved storyboard was written, so its ' +
          'citations may point at different text than they were written against. Say so plainly ' +
          'if the user asks which to pick.'
        : ''),
    done: false,
    selections: state,
  };
}

/**
 * Terminal step for reusing the storyboard a subject already has.
 *
 * Kept apart from `storyboardReadyStep` because the instruction is the opposite of
 * that step's: there is nothing to write, and the one failure mode here is a client
 * that treats a reused storyboard as a starting point and rebuilds it anyway.
 *
 * The document handed over is the one that was rendered when the storyboard was
 * finished. It is not re-rendered here: rendering old state on request would turn
 * whatever content happens to be in the database into a fresh-looking deliverable,
 * which is not the same as the document anyone reviewed.
 */
function storyboardReusedStep(sessionId: string, state: FlowState): FlowStep {
  const courseId = state.course_id!;
  const status = storyboardCourseStatus(courseId);
  saveSession(sessionId, 'storyboard_ready', state);

  // The document the user picked, by path: a path identifies one document even when
  // its filename carries no artifact id, and several of a subject's storyboards can
  // be on offer at once.
  const chosen = state.reuse_docx_path!;
  const label = state.reuse_rendered_at ? ` rendered ${renderedLabel(state.reuse_rendered_at)}` : '';

  return {
    session_id: sessionId,
    flow: 'storyboard',
    step: 'storyboard_ready',
    prompt:
      `Using the saved ${status.name} storyboard` +
      `${state.reuse_artifact_id ? ` (${state.reuse_artifact_id})` : ''}${label}.`,
    data: {
      course_id: courseId,
      source: 'saved',
      docx_path: chosen,
      ...(state.reuse_artifact_id ? { artifact_id: state.reuse_artifact_id } : {}),
      ...(state.reuse_rendered_at ? { rendered_at: state.reuse_rendered_at } : {}),
    },
    next_action:
      'The storyboard already exists and is complete. Give the user the file at data.docx_path ' +
      'and stop. Do NOT create a draft, do NOT run the build loop, and do NOT re-render: the ' +
      'document is finished and any generation here would spend the cost this choice exists to ' +
      'avoid. If the user then wants it changed, submit the affected module through the build ' +
      'loop against this artifact_id rather than starting again.',
    done: true,
    selections: state,
  };
}

function storyboardReadyStep(sessionId: string, state: FlowState): FlowStep {
  const courseId = state.course_id!;
  const status = storyboardCourseStatus(courseId);
  const cdr = isCdrCourse(courseId);
  saveSession(sessionId, 'storyboard_ready', state);

  const routing = cdr
    ? cdrCourseStatus(courseId).documents.flatMap((d) =>
        d.used_by_modules.map((m) => ({ module: m, doc_key: d.doc_key, title: d.title })),
      )
    : undefined;

  return {
    session_id: sessionId,
    flow: 'storyboard',
    step: 'storyboard_ready',
    prompt: `Building the ${status.name} storyboard: ${status.module_count} modules.`,
    data: {
      course_id: courseId,
      track: status.track,
      module_count: status.module_count,
      ...(routing ? { routing } : {}),
    },
    next_action:
      'Build it now. Do not ask the user anything further, do not summarise the plan, and do not ' +
      'offer choices -- everything the storyboard needs has been settled. Four steps: ' +
      `(1) create_storyboard_draft with this course_id${
        state.declined_existing ? ' and regenerate: true' : ''
      }. It returns an artifact_id and an EMPTY ` +
      'skeleton; showing that skeleton to the user does not answer the request. ' +
      '(2) storyboard_next_module with that artifact_id. ' +
      '(3) LOOP: the result has status WRITE_THIS and one whole module -- write every slot it ' +
      'lists from the text in module.sources, cite chunk_ids taken from module.sources, and call ' +
      'storyboard_submit_module once with all of it. It commits and returns the next module. ' +
      'Repeat until status is READY_TO_RENDER. Every result carries next_call naming the exact ' +
      'tool and arguments, so there is nothing to plan. ' +
      '(4) validate_storyboard, then render_storyboard_docx, and give the user the .docx. ' +
      'A course runs to 100-130 tasks. That is expected and each one is small: do not stop ' +
      'between them to summarise, do not ask whether to continue, and do not render early. ' +
      'The template, fonts, colours and layout are applied by the renderer -- never specify ' +
      'them, and never build a document by any other route. ' +
      (cdr
        ? 'This course has no single handbook: each module draws on the reference documents its ' +
          'master file assigns it, listed in data.routing. The task loop applies that routing ' +
          'for you, so every chunk a task offers is already the right document -- do not search ' +
          'the other documents for a module and never cite one module\'s document in another. '
        : 'Sources come from this course\'s own QP, PH and FG, scoped per module by the reviewed ' +
          'crosswalk, which the task loop applies for you. ') +
      'This flow session holds no storyboard state; say "restart" on it to return to the menu.',
    done: true,
    selections: state,
  };
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export function startFlow(): FlowStep {
  const sessionId = nextSessionId();
  const ts = nowIso();
  getDb()
    .prepare(
      'INSERT INTO flow_sessions (session_id, flow, step, state_json, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)',
    )
    .run(sessionId, 'choose_flow', JSON.stringify({}), ts, ts);
  return chooseFlowStep(sessionId, {});
}

/** Re-renders the step a session is on, without advancing it. */
export function getFlow(sessionId: string): FlowStep {
  const session = loadSession(sessionId);
  return render(session.session_id, session.step, session.state);
}

function render(sessionId: string, step: FlowStepName, state: FlowState, error?: string): FlowStep {
  switch (step) {
    case 'choose_flow':
      return chooseFlowStep(sessionId, state, error);
    case 'choose_track':
      return chooseTrackStep(sessionId, state, error);
    case 'choose_subject':
      return chooseSubjectStep(sessionId, state, error);
    case 'choose_module':
      return chooseModuleStep(sessionId, state, error);
    case 'choose_unit':
      return chooseUnitStep(sessionId, state, error);
    case 'choose_candidate':
      return chooseCandidateStep(sessionId, state, error);
    case 'choose_storyboard_source': {
      const existing = listReusableStoryboards(state.course_id!, templateTrackFor(state.course_id!));
      return existing.length > 0
        ? chooseStoryboardSourceStep(sessionId, state, existing, error)
        : storyboardReadyStep(sessionId, state);
    }
    case 'storyboard_ready': {
      const supplied = state.course_id ? preparedStoryboard(state.course_id) : undefined;
      if (supplied) return preparedStoryboardStep(sessionId, state, supplied);
      return state.reuse_docx_path
        ? storyboardReusedStep(sessionId, state)
        : storyboardReadyStep(sessionId, state);
    }
    case 'module_ready':
      return moduleReadyStep(sessionId, state);
    case 'reading_complete':
      return readingCompleteStep(sessionId, state);
  }
}

function previousStep(step: FlowStepName, state: FlowState): FlowStepName {
  switch (step) {
    case 'choose_track':
      return 'choose_flow';
    case 'choose_subject':
      // Only the storyboard flow asks for a track, so only it has one to go back to.
      return state.flow === 'storyboard' ? 'choose_track' : 'choose_flow';
    case 'choose_module':
    case 'choose_candidate':
    case 'choose_storyboard_source':
      return 'choose_subject';
    case 'storyboard_ready':
      // "back" returns to whichever question was actually asked. A supplied
      // storyboard skipped the subject list entirely, so back from it is the
      // programme; otherwise it is the reuse choice when there was one, and the
      // subject when there was not.
      if (state.course_id !== undefined && isPreparedCourse(state.course_id)) return 'choose_track';
      return state.reuse_docx_path !== undefined ? 'choose_storyboard_source' : 'choose_subject';
    case 'choose_unit':
      return 'choose_module';
    case 'reading_complete':
      return 'choose_unit';
    case 'module_ready':
      // A typed topic reaches this step without ever showing the module list, so
      // "back" from it returns to the question that was actually asked.
      return state.module_number !== undefined ? 'choose_module' : 'choose_subject';
    default:
      return 'choose_flow';
  }
}


/** Clears the selections a step is about, so returning to it genuinely re-asks. */
function clearFrom(step: FlowStepName, state: FlowState): FlowState {
  const cleared: FlowState = { ...state };
  const drop = (...keys: (keyof FlowState)[]) => keys.forEach((k) => delete cleared[k]);

  // Going back past a package releases it: choosing again means a new plan rather
  // than the previous one silently re-shown.
  switch (step) {
    case 'choose_flow':
      return {};
    case 'choose_track':
      drop('track', 'subject_id', 'course_id', 'module_number', 'unit_code', 'candidates', 'package_id');
      return cleared;
    case 'choose_subject':
      // The track survives: going back from a subject re-asks the subject, not
      // the programme it belongs to.
      drop('subject_id', 'course_id', 'module_number', 'unit_code', 'candidates', 'package_id',
           'reuse_artifact_id', 'reuse_docx_path', 'reuse_rendered_at', 'declined_existing');
      if (state.flow !== 'storyboard') delete cleared.track;
      return cleared;
    case 'choose_storyboard_source':
      drop('reuse_artifact_id', 'reuse_docx_path', 'reuse_rendered_at', 'declined_existing');
      return cleared;
    case 'choose_module':
      drop('module_number', 'unit_code', 'candidates', 'package_id');
      return cleared;
    case 'choose_unit':
      drop('unit_code', 'package_id');
      return cleared;
    default:
      return cleared;
  }
}

/**
 * Where the branches part.
 *
 * The module-content flow stops at the module and begins generating; the reading
 * flow goes one level deeper, because "show me what this says" is a question about
 * a unit, not about a whole module.
 */
function moduleChosen(sessionId: string, state: FlowState): FlowStep {
  if (state.flow === 'ph_reading') {
    saveSession(sessionId, 'choose_unit', state);
    return chooseUnitStep(sessionId, state);
  }
  return moduleReadyStep(sessionId, state);
}

function unitChosen(sessionId: string, state: FlowState): FlowStep {
  saveSession(sessionId, 'reading_complete', state);
  return readingCompleteStep(sessionId, state);
}

function applyCandidate(state: FlowState, picked: Candidate): void {
  state.course_id = picked.course_id;
  state.subject_id = picked.subject_id;
  state.module_number = picked.module_number;
  state.unit_code = picked.unit_code;
  delete state.candidates;
}

/**
 * Tries an unrecognised answer as a topic name.
 *
 * This replaces asking the user whether they would like to type a topic or browse:
 * they can always do either, and a typed topic is simply an answer the step
 * understands. Returns undefined when nothing matched, so the caller re-asks its
 * own step with its own error rather than surfacing a search failure.
 */
function tryTopic(sessionId: string, state: FlowState, query: string): FlowStep | undefined {
  if (query.length < 4) return undefined;
  const found = findPhUnits(query, state.course_id ? { courseId: state.course_id } : {});
  if (found.candidates.length === 0) return undefined;

  const candidates: Candidate[] = found.candidates.map((c) => ({
    unit_code: c.unit.unit_code,
    subject_id: c.subject_id ?? c.course_id,
    course_id: c.course_id,
    module_number: c.unit.module_number,
    label: `${c.subject_code ?? c.course_id}: Unit ${c.unit.unit_code} - ${c.unit.title}`,
  }));

  if (!found.confident) {
    // Two units close together is exactly the case where guessing produces a
    // correct-looking script about the wrong topic, so the user decides.
    const next = { ...state, candidates };
    saveSession(sessionId, 'choose_candidate', next);
    return chooseCandidateStep(sessionId, next);
  }

  applyCandidate(state, candidates[0]!);
  return state.flow === 'ph_reading' ? unitChosen(sessionId, state) : moduleReadyStep(sessionId, state);
}

/**
 * Applies one answer and returns the next step.
 *
 * An answer that matches neither an option nor a topic re-renders the same step
 * with an `error` rather than advancing or guessing. Guessing here would mean
 * generating from a subject or unit the user did not pick, which is the one
 * mistake this flow exists to prevent.
 */
export async function advanceFlow(sessionId: string, rawChoice: string): Promise<FlowStep> {
  const session = loadSession(sessionId);
  const state: FlowState = { ...session.state };
  const choice = rawChoice.trim();
  const lowered = choice.toLowerCase();

  // Available from every step, finished ones included: a user who has just been
  // handed a script and wants something else says so here.
  if (['restart', 'start over', 'new', 'reset', 'menu'].includes(lowered)) {
    saveSession(sessionId, 'choose_flow', {});
    return chooseFlowStep(sessionId, {});
  }
  if (lowered === 'back') {
    const previous = previousStep(session.step, state);
    const cleared = clearFrom(previous, state);
    saveSession(sessionId, previous, cleared);
    return render(sessionId, previous, cleared);
  }

  switch (session.step) {
    case 'choose_flow': {
      const flow = FLOW_ALIASES[lowered.replace(/[\s-]+/g, '_').replace(/[.)]$/, '')];
      if (!flow) {
        return chooseFlowStep(
          sessionId,
          state,
          `"${choice}" is not one of the three options. Answer 1, 2 or 3.`,
        );
      }
      state.flow = flow;
      // Only the storyboard needs to know the programme first; the content flows
      // read it off whichever subject the user picks.
      const next: FlowStepName = flow === 'storyboard' ? 'choose_track' : 'choose_subject';
      saveSession(sessionId, next, state);
      return render(sessionId, next, state);
    }

    case 'choose_track': {
      const track = findTrack(choice);
      if (!track) {
        return chooseTrackStep(
          sessionId,
          state,
          `"${choice}" is not one of the options. Answer 1, 2 or 3.`,
        );
      }
      state.track = track;

      // A track whose storyboards are supplied as finished documents asks nothing
      // further when it holds exactly one: the subject question would have a
      // single answer, and answering it for the user is better than asking a
      // question with no alternative. CDR is that track today.
      if (track === 'cdr') {
        const prepared = listPreparedCdrStoryboards();
        if (prepared.length === 1) {
          state.subject_id = prepared[0]!.course_id;
          state.course_id = prepared[0]!.course_id;
          return preparedStoryboardStep(sessionId, state, prepared[0]!);
        }
      }

      saveSession(sessionId, 'choose_subject', state);
      return chooseStoryboardCourseStep(sessionId, state);
    }

    case 'choose_storyboard_source': {
      const courseId = state.course_id!;
      const existing = listReusableStoryboards(courseId, templateTrackFor(courseId));
      if (existing.length === 0) {
        // The documents vanished between the question and the answer. Building is
        // the only remaining answer, so it is taken rather than reported as the
        // user's problem.
        return storyboardReadyStep(sessionId, state);
      }

      const picked = matchReuseAnswer(choice, existing);
      if (!picked) {
        const count = reuseOptions(existing).length;
        return chooseStoryboardSourceStep(
          sessionId,
          state,
          existing,
          `"${choice}" is not one of the options. Answer with a number from 1 to ${count}, or ` +
            'with "generate".',
        );
      }

      if (picked.kind === 'generate') {
        delete state.reuse_artifact_id;
        delete state.reuse_docx_path;
        delete state.reuse_rendered_at;
        state.declined_existing = true;
        return storyboardReadyStep(sessionId, state);
      }

      state.reuse_docx_path = picked.storyboard.docx_path;
      state.reuse_rendered_at = picked.storyboard.rendered_at;
      if (picked.storyboard.artifact_id) state.reuse_artifact_id = picked.storyboard.artifact_id;
      else delete state.reuse_artifact_id;
      return storyboardReusedStep(sessionId, state);
    }

    case 'choose_subject': {
      if (state.flow === 'storyboard') {
        const track = state.track as CourseTrack;
        const course = findStoryboardCourse(track, choice);
        if (!course) {
          return chooseStoryboardCourseStep(
            sessionId,
            state,
            `"${choice}" is not one of the ${TRACK_LABELS[track]} subjects. Answer with its ` +
              'number or its name.',
          );
        }
        if (!course.selectable) {
          return chooseStoryboardCourseStep(
            sessionId,
            state,
            `${course.name} cannot be built yet. ${course.blocker}`,
          );
        }
        // Indexing is the server's job and takes a few seconds once. It happens
        // here rather than being handed back to the user as a chore.
        // A supplied storyboard is handed over whatever route reached it, so that
        // naming the subject directly behaves the same as picking it from a list.
        const supplied = preparedStoryboard(course.course_id);
        if (supplied) {
          state.subject_id = course.course_id;
          state.course_id = course.course_id;
          return preparedStoryboardStep(sessionId, state, supplied);
        }

        if (course.needs_index) await ingestCourse(course.course_id);
        state.subject_id = course.course_id;
        state.course_id = course.course_id;
        delete state.reuse_artifact_id;
        delete state.reuse_docx_path;
        delete state.reuse_rendered_at;
        delete state.declined_existing;

        // Every storyboard this subject already has, newest first. With none, there
        // is no question worth asking and generation simply starts.
        const existing = listReusableStoryboards(
          course.course_id,
          templateTrackFor(course.course_id),
        );
        if (existing.length > 0) return chooseStoryboardSourceStep(sessionId, state, existing);
        return storyboardReadyStep(sessionId, state);
      }

      const statuses = listSubjectStatuses();
      const wanted = lowered.replace(/[\s_]+/g, '-');
      const match = statuses.find(
        (s) => s.subject_id === wanted || s.code.toLowerCase() === lowered || s.name.toLowerCase() === lowered,
      );
      if (!match) {
        // Not a subject: the user may have named their topic instead.
        const jumped = tryTopic(sessionId, state, choice);
        if (jumped) return jumped;
        return chooseSubjectStep(
          sessionId,
          state,
          `"${choice}" is not one of the subjects, and no handbook unit matches it. Choose one of ` +
            `${statuses
              .filter((s) => s.ready)
              .map((s) => s.code)
              .join(', ')}.`,
        );
      }
      if (!match.selectable) {
        return chooseSubjectStep(sessionId, state, `${match.code} is not available yet. ${match.blocker}`);
      }
      if (match.needs_index) {
        // The handbook is on disk but has never been read. Indexing it is the
        // server's job, not a chore to hand back to the user, so it happens here
        // and the flow carries on to the module list as though it were ready.
        await ingestCourse(match.course_id);
      }
      state.track = match.track;
      state.subject_id = match.subject_id;
      state.course_id = match.course_id;

      // Both content flows continue to the module; the storyboard flow never
      // reaches here, having taken its own branch above.
      saveSession(sessionId, 'choose_module', state);
      return chooseModuleStep(sessionId, state);
    }

    case 'choose_module': {
      const outline = getPhOutline(state.course_id!);
      const number = Number(choice.replace(/^module\s*/i, '').trim());
      const module = Number.isInteger(number)
        ? outline.modules.find((m) => m.module_number === number)
        : undefined;
      if (!module) {
        const jumped = tryTopic(sessionId, state, choice);
        if (jumped) return jumped;
        return chooseModuleStep(
          sessionId,
          state,
          `"${choice}" is not a module in this handbook, and no unit matches it. Choose one of ` +
            `${outline.modules.map((m) => m.module_number).join(', ')}.`,
        );
      }
      if (!module.has_units) {
        return chooseModuleStep(
          sessionId,
          state,
          `Module ${module.module_number} (${module.title}) cannot be used. ${module.note}`,
        );
      }
      state.module_number = module.module_number;
      return moduleChosen(sessionId, state);
    }

    case 'choose_unit': {
      const outline = getPhOutline(state.course_id!);
      const module = outline.modules.find((m) => m.module_number === state.module_number)!;
      const code = choice.replace(/^unit\s*/i, '').trim();
      const unit =
        module.units.find((u) => u.unit_code === code) ??
        module.units.find((u) => u.title.toLowerCase() === lowered);
      if (!unit) {
        return chooseUnitStep(
          sessionId,
          state,
          `"${choice}" is not a unit in Module ${module.module_number}. Choose one of ` +
            `${module.units.map((u) => u.unit_code).join(', ')}.`,
        );
      }
      state.unit_code = unit.unit_code;
      return unitChosen(sessionId, state);
    }

    case 'choose_candidate': {
      if (/^(browse|none|other|list|show)/.test(lowered)) {
        delete state.candidates;
        saveSession(sessionId, 'choose_subject', state);
        return chooseSubjectStep(sessionId, state);
      }
      const candidates = state.candidates ?? [];
      const code = choice.replace(/^unit\s*/i, '').trim();
      const picked =
        candidates.find((c) => c.unit_code === code) ??
        candidates.find((c) => c.label.toLowerCase() === lowered);
      if (!picked) {
        return chooseCandidateStep(
          sessionId,
          state,
          `"${choice}" is not one of the candidates. Choose ` +
            `${candidates.map((c) => c.unit_code).join(', ')}, or "browse".`,
        );
      }
      applyCandidate(state, picked);
      return state.flow === 'ph_reading' ? unitChosen(sessionId, state) : moduleReadyStep(sessionId, state);
    }

    case 'storyboard_ready':
    case 'module_ready':
    case 'reading_complete':
      throw new FlowError(
        `This session has finished at step "${session.step}". Say "restart" to begin something ` +
          'new from the menu, "back" to change the last answer, or continue with the tools named ' +
          'in its next_action.',
      );
  }
}
