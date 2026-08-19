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
import { getCourseDocumentStatus, ingestCourse } from '../documents/ingest.js';
import { cdrCourseStatus, isCdrCourse, listCdrCourseStatuses } from '../cdr/catalog.js';
import { getDb, nowIso } from '../storage/db.js';
import { buildModulePlan } from '../video/module-plan.js';
import { createModulePackage, getModulePackage } from '../video/module-store.js';
import { renderUnitReading } from '../video/render.js';

export type FlowKind = 'module_content' | 'ph_reading' | 'storyboard' | 'cdr_storyboard';

/** Menu answers, including the number the user is shown and the older flow name. */
const FLOW_ALIASES: Record<string, FlowKind> = {
  '1': 'module_content',
  module_content: 'module_content',
  video_transcript: 'module_content',
  video: 'module_content',
  '2': 'ph_reading',
  ph_reading: 'ph_reading',
  reading: 'ph_reading',
  read: 'ph_reading',
  '3': 'storyboard',
  storyboard: 'storyboard',
  '4': 'cdr_storyboard',
  cdr_storyboard: 'cdr_storyboard',
  cdr: 'cdr_storyboard',
};

export type FlowStepName =
  | 'choose_flow'
  | 'choose_subject'
  | 'choose_module'
  | 'choose_unit'
  | 'choose_candidate'
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

const GREETING = 'Here is what I can do with the SCGJ course documents.';

const ALWAYS_AVAILABLE =
  'Show the options as a numbered list and let the user reply with a number, a name, or the ' +
  'topic they want. "back" changes the previous answer; "restart" clears the session and ' +
  'returns to this menu from any step, finished ones included.';

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
 * Each option says what comes out of it, because the one thing a user cannot tell
 * from three verbs is which produces a file, which produces a script and which
 * returns the handbook's own words.
 */
function chooseFlowStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  return {
    ...base(sessionId, state, 'choose_flow', error),
    prompt: `${GREETING}\n\nWhich one do you want?`,
    options: [
      {
        value: 'module_content',
        label: '1. Video script + slide deck for a module',
        detail:
          'You pick a subject and a module. You get a 3-minute video script in 18 segments, its ' +
          'subtitles, and a 9-minute slide deck, as downloadable files. Covers every unit of the ' +
          'module, written from the handbook.',
      },
      {
        value: 'ph_reading',
        label: '2. Read a handbook unit word for word',
        detail:
          "You pick a subject, a module and a unit. You get the Participant Handbook's own text, " +
          'unchanged -- nothing summarised, rewritten or added.',
      },
      {
        value: 'storyboard',
        label: '3. Course storyboard + assessment blueprint',
        detail:
          'For a qualification course -- Biofuels, Solar PV. You pick a subject. You get the ' +
          'curriculum storyboard for the whole course as a .docx built to the SCGJ template, ' +
          'with the assessment question blueprint.',
      },
      {
        value: 'cdr_storyboard',
        label: '4. CDR storyboard + assessment blueprint',
        detail:
          'For a Carbon Dioxide Removal course -- CDR Biochar. Same template, same rules, same ' +
          '.docx. The difference is the sources: each module is built from its own reference ' +
          'document, as the course\'s master file directs, rather than from one handbook.',
      },
    ],
    next_action:
      'Show these three to the user and wait for their pick. Ask nothing else first and start no ' +
      'work until one is chosen. ' +
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
  // The CDR flow and the qualification flows draw from different catalogues, so
  // a CDR course is never offered as though it were a handbook subject and vice
  // versa. That separation is the point of having them as separate menu items.
  if (state.flow === 'cdr_storyboard') return chooseCdrCourseStep(sessionId, state, error);

  const ordered = [...listSubjectStatuses()].sort(
    (a, b) => Number(b.selectable) - Number(a.selectable) || Number(b.ready) - Number(a.ready),
  );
  const verb =
    state.flow === 'ph_reading'
      ? 'read from'
      : state.flow === 'storyboard'
        ? 'build a storyboard for'
        : 'build module content for';
  return {
    ...base(sessionId, state, 'choose_subject', error),
    prompt: `Which subject do you want to ${verb}?`,
    options: ordered.map((s) => ({
      value: s.subject_id,
      label: `${s.code} - ${s.name}`,
      detail: `${TRACK_LABELS[s.track]}. ${
        s.ready
          ? `Handbook indexed (${s.ph_chunk_count} sections).`
          : s.needs_index
            ? 'Handbook supplied; it is indexed automatically the first time you pick it.'
            : 'No handbook supplied yet.'
      }`,
      ...(s.selectable ? {} : { disabled: true, blocker: s.blocker! }),
    })),
    next_action:
      'List the selectable subjects first and mark the rest unavailable rather than hiding them. ' +
      'A subject marked "indexed automatically" is a normal choice -- offer it without ' +
      'qualification and without asking the user to run anything; picking it indexes the ' +
      'handbook first, which takes a few seconds once. If the user names a topic instead of a ' +
      'subject, pass what they said straight through: it is resolved to the unit that holds it.',
  };
}

/**
 * The CDR course list.
 *
 * Readiness here means every reference document the master file names is present
 * and indexed. A course missing three of its nine documents is shown, and shown
 * as unavailable with the filenames it is waiting for -- the same rule the
 * qualification subjects follow, applied to a longer document list.
 */
function chooseCdrCourseStep(sessionId: string, state: FlowState, error?: string): FlowStep {
  const courses = listCdrCourseStatuses();
  return {
    ...base(sessionId, state, 'choose_subject', error),
    prompt: 'Which CDR course do you want to build a storyboard for?',
    options: courses.map((c) => ({
      value: c.course_id,
      label: c.name,
      detail:
        `${c.module_count} modules, ${c.total_hours} hours, ${c.document_count} reference ` +
        `documents. ${
          c.ready
            ? 'All documents indexed.'
            : `${c.missing.length} document(s) not supplied yet.`
        }`,
      ...(c.ready ? {} : { disabled: true, blocker: c.blocker! }),
    })),
    next_action:
      'List the CDR courses and let the user pick. A course that is not ready names the exact ' +
      'files it is waiting for; report those filenames rather than paraphrasing them, because ' +
      'they are what the user must place on disk.',
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
 * Terminal step of the CDR storyboard flow.
 *
 * It hands over exactly as the qualification flow does, and to the same tools:
 * the difference between the two courses is which documents each module draws
 * from, and that is settled by the master file before generation starts. So the
 * client is told the routing rather than asked to work it out, and then told to
 * run the same loop.
 */
function cdrReadyStep(sessionId: string, state: FlowState): FlowStep {
  const status = cdrCourseStatus(state.course_id!);
  saveSession(sessionId, 'storyboard_ready', state);
  return {
    session_id: sessionId,
    flow: 'cdr_storyboard',
    step: 'storyboard_ready',
    prompt:
      `Building the ${status.name} storyboard: ${status.module_count} modules, ` +
      `${status.total_hours} hours, from ${status.document_count} reference documents.`,
    data: {
      course_id: status.course_id,
      module_count: status.module_count,
      total_hours: status.total_hours,
      documents: status.documents,
      routing: status.documents.flatMap((d) =>
        d.used_by_modules.map((m) => ({ module: m, doc_key: d.doc_key, title: d.title })),
      ),
    },
    next_action:
      'Build it now, with the same tools and the same rules as any other storyboard -- the ' +
      'template, the formatting and the citation requirements are identical. ' +
      '(1) create_storyboard_draft with this course_id. ' +
      '(2) storyboard_next_task with the artifact_id it returns. ' +
      '(3) LOOP: write the fields in task.fields from the text in task.sources, cite chunk_ids ' +
      'from task.sources, and call storyboard_submit_task; repeat until status is ' +
      'READY_TO_RENDER. ' +
      '(4) validate_storyboard, then render_storyboard_docx, and give the user the .docx. ' +
      'What differs from a qualification course is only where the sources come from: each ' +
      'module draws from the reference document(s) the master file assigns it, shown in ' +
      'data.routing above. The task loop applies that routing for you, so every chunk a task ' +
      'offers is already the right document -- do not search across the other documents and do ' +
      'not cite one module\'s document in another module. Do not stop between tasks to ' +
      'summarise or ask whether to continue.',
    done: true,
    selections: state,
  };
}

/**
 * Terminal step of the storyboard flow.
 *
 * The storyboard runs on its own tool set and its own module numbering, so this
 * step hands over rather than continuing. It carries the resolved course_id and
 * the document status, which is what the first storyboard tools would otherwise
 * have to be called to discover.
 */
function storyboardReadyStep(sessionId: string, state: FlowState): FlowStep {
  const documents = getCourseDocumentStatus(state.course_id!);
  saveSession(sessionId, 'storyboard_ready', state);
  return {
    session_id: sessionId,
    flow: 'storyboard',
    step: 'storyboard_ready',
    prompt: `Building the storyboard for ${state.subject_id}.`,
    data: { course_id: state.course_id, documents },
    next_action:
      'Build the storyboard now. Three calls set it up and then one loop does the rest, so there ' +
      'is nothing to plan and nothing to ask the user: ' +
      '(1) create_storyboard_draft with this course_id. ' +
      '(2) storyboard_next_task with the artifact_id it returns. ' +
      '(3) LOOP: the result has status WRITE_THIS and a task -- write the fields in task.fields ' +
      'using the handbook text in task.sources, cite chunk_ids from task.sources, and call ' +
      'storyboard_submit_task. It returns the next task. Repeat until status is READY_TO_RENDER. ' +
      'Each result also carries next_call naming the exact tool and arguments to use, so follow ' +
      'that if in doubt. ' +
      '(4) validate_storyboard, then render_storyboard_docx, and give the user the .docx. ' +
      'Do not stop between tasks to summarise or to ask whether to continue, and do not render ' +
      'early. A course is 100-130 tasks; that is normal and each one is small. ' +
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
    case 'choose_subject':
      return chooseSubjectStep(sessionId, state, error);
    case 'choose_module':
      return chooseModuleStep(sessionId, state, error);
    case 'choose_unit':
      return chooseUnitStep(sessionId, state, error);
    case 'choose_candidate':
      return chooseCandidateStep(sessionId, state, error);
    case 'storyboard_ready':
      return state.flow === 'cdr_storyboard'
        ? cdrReadyStep(sessionId, state)
        : storyboardReadyStep(sessionId, state);
    case 'module_ready':
      return moduleReadyStep(sessionId, state);
    case 'reading_complete':
      return readingCompleteStep(sessionId, state);
  }
}

function previousStep(step: FlowStepName, state: FlowState): FlowStepName {
  switch (step) {
    case 'choose_subject':
      return 'choose_flow';
    case 'choose_module':
    case 'choose_candidate':
    case 'storyboard_ready':
      return 'choose_subject';
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
    case 'choose_subject':
      drop('track', 'subject_id', 'course_id', 'module_number', 'unit_code', 'candidates', 'package_id');
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
          `"${choice}" is not one of the three options. Answer 1, 2 or 3, or ` +
            'module_content / ph_reading / storyboard.',
        );
      }
      state.flow = flow;
      saveSession(sessionId, 'choose_subject', state);
      return chooseSubjectStep(sessionId, state);
    }

    case 'choose_subject': {
      if (state.flow === 'cdr_storyboard') {
        const courses = listCdrCourseStatuses();
        const wantedCourse = lowered.replace(/[\s_]+/g, '-');
        const course =
          courses.find((c) => c.course_id === wantedCourse) ??
          courses.find((c) => c.name.toLowerCase() === lowered);
        if (!course) {
          return chooseCdrCourseStep(
            sessionId,
            state,
            `"${choice}" is not one of the CDR courses. Choose ` +
              `${courses.map((c) => c.course_id).join(', ')}.`,
          );
        }
        if (!course.ready) {
          // Present-but-unindexed is the server's job; genuinely absent files are
          // the user's, so only the latter blocks.
          const absent = course.missing.filter((d) => !d.present);
          if (absent.length > 0) {
            return chooseCdrCourseStep(sessionId, state, `${course.name} is not ready. ${course.blocker}`);
          }
          await ingestCourse(course.course_id);
        }
        state.subject_id = course.course_id;
        state.course_id = course.course_id;
        return cdrReadyStep(sessionId, state);
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

      // The storyboard covers a whole course, so the subject is the last question
      // it has. The content flows carry on to the module.
      if (state.flow === 'storyboard') return storyboardReadyStep(sessionId, state);
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
