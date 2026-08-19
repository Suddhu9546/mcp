/**
 * Full end-to-end run for Biofuels Module 1, driven over the real MCP protocol.
 *
 * The content below was authored by the reasoning client (not by this server)
 * after reading the chunks retrieved via search_course_content. Every citation is
 * a chunk_id that retrieval actually returned. This is the target architecture in
 * miniature: the client thinks, the server supplies sources, validates and renders.
 */

import { McpClient } from './mcp-client.mjs';

const ref = (chunkId, pdfPage, printedPage, section) => ({
  document_type: chunkId.split(':')[1],
  pdf_page: pdfPage,
  printed_page: printedPage,
  section,
  chunk_id: chunkId,
});

const PH_11_TYPES = ref('biofuels:PH:p15:19', 15, 5, 'UNIT 1.1: Fundamentals of Biofuels and Biomass Energy');
const PH_11_GAS = ref('biofuels:PH:p17:22', 17, 7, 'UNIT 1.1: Fundamentals of Biofuels and Biomass Energy');
const PH_11_SYNGAS = ref('biofuels:PH:p17:23', 17, 7, 'UNIT 1.1: Fundamentals of Biofuels and Biomass Energy');
const PH_11_INTRO = ref('biofuels:PH:p13:13', 13, 3, 'UNIT 1.1: Fundamentals of Biofuels and Biomass Energy');
const PH_12_MODELS = ref('biofuels:PH:p28:43', 28, 18, 'UNIT 1.2: Entrepreneurship in the Biomass Energy Sector');
const PH_12_CONCEPT = ref('biofuels:PH:p22:32', 22, 12, 'UNIT 1.2: Entrepreneurship in the Biomass Energy Sector');
const FG_12_ACTIVITY = ref('biofuels:FG:p19:18', 19, 8, 'UNIT 1.2: Entrepreneurship in the Biomass Energy Sector');
const PH_13_INTRO = ref('biofuels:PH:p32:51', 32, 22, 'UNIT 1.3: Managing a Biomass-Based Enterprise');
const PH_13_CHALL = ref('biofuels:PH:p32:52', 32, 22, 'UNIT 1.3: Managing a Biomass-Based Enterprise');
const PH_13_COMPLY = ref('biofuels:PH:p35:59', 35, 25, 'UNIT 1.3: Managing a Biomass-Based Enterprise');
const FG_13_FACIL = ref('biofuels:FG:p20:19', 20, 9, 'UNIT 1.3: Managing a Biomass-Based Enterprise');
const PH_14_SURVEY = ref('biofuels:PH:p44:80', 44, 34, 'UNIT 1.4: Biomass Resource Management and Procurement');
const PH_14_PLAN = ref('biofuels:PH:p44:81', 44, 34, 'UNIT 1.4: Biomass Resource Management and Procurement');
const PH_14_FPO = ref('biofuels:PH:p46:84', 46, 36, 'UNIT 1.4: Biomass Resource Management and Procurement');
const PH_OUTCOMES = ref('biofuels:PH:p12:12', 12, 2, 'UNIT 1.4: Biomass Resource Management and Procurement');

const ACTIVITIES = {
  '1.1': 'Biofuel State Sorter',
  '1.2': 'Business Model versus Strategy Sorter',
  '1.3': 'MSME Risk Triage',
  '1.4': 'Field Survey Planner',
};

const PART_A = [
  {
    unit: '1.1',
    activity_name: ACTIVITIES['1.1'],
    interactive_description:
      'Learners classify biofuels by physical state into solid, liquid and gaseous, then trace ' +
      'each to its conversion route. Solid biofuels include wood and charcoal, where charcoal is ' +
      'derived from wood through a slow pyrolysis process. Selecting biogas reveals anaerobic ' +
      'digestion of organic waste including animal manure, food waste and sewage sludge, ' +
      'generating a mixture of methane and carbon dioxide that can be processed into biomethane ' +
      'for injection into natural gas grids. Selecting syngas reveals biomass gasification into ' +
      'hydrogen, carbon monoxide and carbon dioxide, and biohydrogen produced through ' +
      'fermentation or gasification for use in fuel cells.',
    correlation: 'SGJ/N4102 / PC1, PC2, PC8',
    performance_criteria: ['PC1', 'PC2', 'PC8'],
    sources: [PH_11_TYPES, PH_11_GAS, PH_11_SYNGAS, PH_11_INTRO],
  },
  {
    unit: '1.2',
    activity_name: ACTIVITIES['1.2'],
    interactive_description:
      'Learners separate business models from business strategies in the biomass industry. A ' +
      'business model explains how a company creates, delivers and captures value, defining the ' +
      'structure of the business, revenue sources and cost management, while a business strategy ' +
      'describes how a company competes in the market, differentiates itself and achieves ' +
      'long-term success. Learners sort the Biomass-to-Energy, Biofuel Production, Biomass Waste ' +
      'Management and Pellet and Briquette Manufacturing models against the cost leadership, ' +
      'differentiation, niche market, innovation and sustainability strategies, then match each ' +
      'entrepreneurial barrier to a mitigation: high initial investment costs, raw material ' +
      'availability affected by seasonal changes, regulatory hurdles, market competition with ' +
      'solar and wind, and technology barriers requiring skilled labour.',
    correlation: 'SGJ/N4102 / PC3, PC4, PC6',
    performance_criteria: ['PC3', 'PC4', 'PC6'],
    sources: [PH_12_MODELS, PH_12_CONCEPT, FG_12_ACTIVITY],
  },
  {
    unit: '1.3',
    activity_name: ACTIVITIES['1.3'],
    interactive_description:
      'Learners triage the management challenges of an emerging biomass MSME across the four ' +
      'areas the handbook defines: financial management covering funding sources, cost ' +
      'management and financial planning for business sustainability; human resource management ' +
      'focusing on recruiting, training and retaining a skilled workforce in the bioenergy ' +
      'sector; product and service development emphasising innovation and market-driven ' +
      'improvements; and operational management including efficient production processes, supply ' +
      'chain coordination and regulatory compliance. The compliance branch requires learners to ' +
      'obtain necessary permits for biomass processing and emissions, comply with waste disposal ' +
      'regulations and adopt environmentally sustainable practices, showing that non-compliance ' +
      'can lead to fines, legal actions and reputational damage.',
    correlation: 'SGJ/N4102 / PC5',
    performance_criteria: ['PC5'],
    sources: [PH_13_INTRO, PH_13_CHALL, PH_13_COMPLY],
  },
  {
    unit: '1.4',
    activity_name: ACTIVITIES['1.4'],
    interactive_description:
      'Learners build an agricultural residue field survey. They define the geographical area to ' +
      'be covered, identify key stakeholders including farmers, aggregators, FPO representatives ' +
      'and local agricultural officers, and assemble a structured questionnaire covering types of ' +
      'residues generated such as straw, husks and shells, quantity produced per season, current ' +
      'utilisation, storage practices and challenges, willingness to sell residues and expected ' +
      'price. Learners then compile findings, categorise residues by crop type, season, quantity ' +
      'and utilisation, and create a residue availability map of hotspots using GPS data. The ' +
      'exercise surfaces the supply chain challenges: high transportation costs due to the bulky ' +
      'nature of agro-residues, lack of awareness among farmers about the economic potential of ' +
      'crop residues, storage issues that lead to spoilage and degradation, and limited ' +
      'infrastructure and technology for converting agro-residue waste into valuable products.',
    correlation: 'SGJ/N4102 / PC7, PC9, PC10, PC11',
    performance_criteria: ['PC7', 'PC9', 'PC10', 'PC11'],
    sources: [PH_14_SURVEY, PH_14_PLAN, PH_14_FPO],
  },
];

const LMS_ROWS = [
  {
    unit_range: '1.1',
    activity_type: ACTIVITIES['1.1'],
    recommended_standard: 'xAPI',
    tracking: 'xAPI Verbs: classified, identified / Data: biofuel state assigned; conversion route traced.',
    completion_criteria:
      'All solid, liquid and gaseous biofuels correctly classified, and the anaerobic digestion ' +
      'and gasification routes traced to biogas and syngas.',
    sources: [PH_11_TYPES, PH_11_GAS],
  },
  {
    unit_range: '1.2',
    activity_type: ACTIVITIES['1.2'],
    recommended_standard: 'SCORM 2004',
    tracking: 'SCORM: cmi.interactions / Data: model versus strategy sort; barrier to mitigation matches.',
    completion_criteria:
      'All four business models separated from the five business strategies, and each ' +
      'entrepreneurial barrier matched to a mitigation.',
    sources: [PH_12_MODELS, FG_12_ACTIVITY],
  },
  {
    unit_range: '1.3',
    activity_type: ACTIVITIES['1.3'],
    recommended_standard: 'SCORM 1.2',
    tracking: 'SCORM: cmi.success_status / Data: challenge allocated to financial, HR, product or operations.',
    completion_criteria:
      'Challenges allocated across financial management, human resource management, product and ' +
      'service development and operational management, with the permits and waste disposal ' +
      'compliance steps selected.',
    sources: [PH_13_CHALL, PH_13_COMPLY],
  },
  {
    unit_range: '1.4',
    activity_type: ACTIVITIES['1.4'],
    recommended_standard: 'xAPI',
    tracking: 'xAPI Verbs: planned, surveyed / Data: stakeholders identified; questionnaire assembled; residue map built.',
    completion_criteria:
      'Survey plan defines the geographical area and stakeholders, the questionnaire covers ' +
      'residue type, seasonal quantity, utilisation, storage and price, and a residue ' +
      'availability map is produced.',
    sources: [PH_14_SURVEY, PH_14_PLAN, PH_14_FPO],
  },
];

const PART_B = [
  {
    index: 0,
    visual:
      'Wide establishing shots of agricultural residue in the field, then a cut to the Host beside ' +
      'a stack of straw bales.',
    gfx: 'Bio-Energy Micro Entrepreneur · Module 1 · Entrepreneurship and Basics of Biomass Energy',
    audio:
      'Host (On-Camera): "The world is experiencing a rapid shift towards cleaner and more ' +
      'sustainable energy sources to combat climate change, reduce dependence on fossil fuels, ' +
      'and ensure energy security. Biofuels and biomass energy are derived from organic materials ' +
      'such as crops, agricultural residues, forestry waste, and even municipal solid waste."',
    sources: [PH_11_INTRO],
  },
  {
    index: 1,
    visual: 'Animated build separating biofuels into solid, liquid and gaseous columns, filling each in turn.',
    gfx: 'Solid · Liquid · Gaseous',
    audio:
      'Expert 1 (V.O.): "Solid biofuels are organic materials used directly for energy generation ' +
      'without significant chemical processing. Wood has been a primary energy source for heating, ' +
      'cooking and power generation, while charcoal is derived from wood through a slow pyrolysis ' +
      'process, offering a more energy-dense and cleaner-burning option."',
    sources: [PH_11_TYPES],
  },
  {
    index: 2,
    visual: 'Cutaway animation of an anaerobic digester, then a gasifier producing syngas.',
    audio:
      'Expert 1 (V.O.): "Biogas is produced through the anaerobic digestion of organic waste, ' +
      'including animal manure, food waste and sewage sludge. Microorganisms break down these ' +
      'materials in the absence of oxygen, generating a mixture of methane and carbon dioxide. ' +
      'Syngas is produced through biomass gasification, converting solid biomass into hydrogen, ' +
      'carbon monoxide and carbon dioxide."',
    sources: [PH_11_GAS, PH_11_SYNGAS],
  },
  {
    index: 3,
    visual: 'Split screen contrasting a business model canvas with a competitive strategy board.',
    gfx: 'Business Model: creates, delivers, captures value · Business Strategy: competes, differentiates',
    audio:
      'Narrator (V.O.): "A business model explains how a company creates, delivers and captures ' +
      'value, defining the structure of the business, revenue sources and cost management. A ' +
      'business strategy describes how a company competes in the market, differentiates itself ' +
      'and achieves long-term success."',
    sources: [PH_12_MODELS],
  },
  {
    index: 4,
    visual:
      'Footage of a farmer interview and an FPO aggregation yard, then fade to the SCGJ logo.',
    gfx: 'Module 1 Complete. Proceed to Interactive Activities.',
    audio:
      'Host (On-Camera): "Your feedstock decides your business. Engage with farmers, aggregators ' +
      'and Farmer Producer Organizations to collect firsthand information on residue production, ' +
      'utilization and market potential, and evaluate the logistics and feasibility of residue ' +
      'collection. Watch for high transportation costs due to the bulky nature of agro-residues, ' +
      'and storage issues that lead to spoilage and degradation."',
    sources: [PH_14_SURVEY],
  },
];

const SLIDES = [
  {
    index: 0,
    title: 'Title Slide',
    visual_cues: 'SCGJ branding. Image of agricultural residue alongside a biomass pellet sample.',
    instructor_script:
      'Welcome to the first live session of the Bio-Energy Micro Entrepreneur qualification. In ' +
      'the eLMS you explored biofuels as a renewable energy source and the entrepreneurial ' +
      'process. Today we apply that to the decisions you will actually make about feedstock, ' +
      'business model and management.',
    sources: [PH_11_INTRO],
  },
  {
    index: 1,
    title: 'Session Agenda (15 Minutes)',
    visual_cues: 'Interactive Poll (0-3 mins), Breakout Challenge (3-11 mins), Debrief and Q&A (11-15 mins).',
    instructor_script:
      'We have fifteen minutes. A short poll on conversion technology, then a collaborative ' +
      'challenge on the entrepreneurial process taken from your facilitator activity, and finally ' +
      'a debrief on procurement.',
    sources: [FG_12_ACTIVITY],
  },
  {
    index: 2,
    title: 'Quick Recap - Biofuels by Physical State',
    visual_cues:
      'Three columns: Solid (wood, charcoal), Liquid (bioethanol, biodiesel), Gaseous (biogas, syngas, biohydrogen).',
    instructor_script:
      'Remember the framework from the handbook. Biofuels are classified by physical state into ' +
      'solid, liquid and gaseous. Solid biofuels are used directly for energy generation without ' +
      'significant chemical processing. Gaseous biofuels are obtained through microbial digestion ' +
      'or thermal processes that convert organic matter into combustible gases, useful for ' +
      'heating, electricity generation and as a substitute for natural gas.',
    sources: [PH_11_TYPES, PH_11_GAS],
  },
  {
    index: 3,
    title: 'Interactive Poll - "Which Route Produces Biogas?" (3 Minutes)',
    visual_cues:
      'Poll Question: Which process produces biogas from animal manure, food waste and sewage sludge? (Correct: Anaerobic digestion)',
    instructor_script:
      'Drop your answers in the chat. The correct answer is anaerobic digestion. Microorganisms ' +
      'break down organic materials in the absence of oxygen, generating a mixture of methane and ' +
      'carbon dioxide. Note that biogas can be further processed into biomethane, a purified form ' +
      'suitable for injection into natural gas grids, which changes who your customer can be.',
    sources: [PH_11_GAS],
  },
  {
    index: 4,
    title: 'Breakout Room - The Entrepreneurial Process (8 Minutes)',
    visual_cues:
      'Each group takes one step of the entrepreneurial process and presents how they would approach it when starting a biomass business.',
    instructor_script:
      'I am opening the breakout rooms. Form groups of four, and each group takes one step in the ' +
      'entrepreneurial process. Present how you would approach that step if you were starting a ' +
      'biomass business. You have five minutes for the activity, then nominate a spokesperson.',
    sources: [FG_12_ACTIVITY],
  },
  {
    index: 5,
    title: 'Debrief - Management Challenges and Compliance',
    visual_cues:
      'Four management areas: financial, human resources, product and service development, operations. Compliance: permits, waste disposal, sustainable practices.',
    instructor_script:
      'Good work. Two things to carry forward. First, managing an emerging biomass MSME means ' +
      'working across financial management, human resource management, product and service ' +
      'development and operational management at the same time. Second, operations includes ' +
      'regulatory compliance: obtain necessary permits for biomass processing and emissions, ' +
      'comply with waste disposal regulations and adopt environmentally sustainable practices, ' +
      'because non-compliance can lead to fines, legal actions and reputational damage.',
    sources: [PH_13_CHALL, PH_13_COMPLY],
  },
  {
    index: 6,
    title: 'Q&A and Session Wrap-Up (4 Minutes)',
    visual_cues: 'Q&A slide with next steps and the field survey assignment.',
    instructor_script:
      'Thank you for your contributions. Before the next session, complete the Biofuel State ' +
      'Sorter and the Field Survey Planner in the eLMS. Prepare a structured questionnaire ' +
      'covering the types of residues generated, quantity produced per season, current ' +
      'utilisation, storage practices and willingness to sell, so you arrive with a survey plan ' +
      'you can actually run in your own district.',
    sources: [PH_14_PLAN],
  },
];

// ---------------------------------------------------------------------------

// Question bank + weightage constants, appended into e2e-module1.mjs by patch.py.

const QUESTIONS = [
  {
    stem: 'By which process is charcoal derived from wood?',
    options: { a: 'Anaerobic digestion', b: 'Slow pyrolysis', c: 'Transesterification', d: 'Steam reforming' },
    correct_option: 'b',
    explanation:
      'Charcoal is derived from wood through a slow pyrolysis process, offering a more energy-dense and cleaner-burning option than wood itself.',
    sources: [PH_11_TYPES],
  },
  {
    stem: 'Biogas is produced through the anaerobic digestion of which organic wastes?',
    options: {
      a: 'Animal manure, food waste and sewage sludge',
      b: 'Crushed limestone and gypsum',
      c: 'Refined crude oil fractions',
      d: 'Imported compressed natural gas',
    },
    correct_option: 'a',
    explanation:
      'Biogas is produced through the anaerobic digestion of organic waste, including animal manure, food waste and sewage sludge, where microorganisms break the material down in the absence of oxygen.',
    sources: [PH_11_GAS],
  },
  {
    stem: 'Anaerobic digestion of organic waste generates a mixture of which two gases?',
    options: {
      a: 'Hydrogen and nitrogen',
      b: 'Methane and carbon dioxide',
      c: 'Oxygen and sulphur dioxide',
      d: 'Propane and butane',
    },
    correct_option: 'b',
    explanation:
      'Microorganisms break down organic materials in the absence of oxygen, generating a mixture of methane and carbon dioxide.',
    sources: [PH_11_GAS],
  },
  {
    stem: 'What is purified biogas called when it is suitable for injection into natural gas grids?',
    options: { a: 'Syngas', b: 'Biohydrogen', c: 'Biomethane', d: 'Producer gas' },
    correct_option: 'c',
    explanation:
      'Biogas can be further processed into biomethane, a purified form suitable for injection into natural gas grids.',
    sources: [PH_11_GAS],
  },
  {
    stem: 'Biomass gasification converts solid biomass into a mixture of which gases?',
    options: {
      a: 'Hydrogen, carbon monoxide and carbon dioxide',
      b: 'Methane, ethane and propane',
      c: 'Nitrogen, argon and helium',
      d: 'Ammonia, hydrogen sulphide and steam',
    },
    correct_option: 'a',
    explanation:
      'Syngas is produced through biomass gasification, a process that converts solid biomass into a mixture of hydrogen, carbon monoxide and carbon dioxide.',
    sources: [PH_11_SYNGAS],
  },
  {
    stem: 'Biohydrogen has the potential to be used in which application?',
    options: {
      a: 'Diesel engines without modification',
      b: 'Fuel cells',
      c: 'Open-hearth furnaces',
      d: 'Photovoltaic modules',
    },
    correct_option: 'b',
    explanation:
      'Biohydrogen is a clean fuel produced through biomass fermentation or gasification, and has the potential to be used in fuel cells, offering a sustainable and zero-emission alternative to conventional hydrogen production.',
    sources: [PH_11_SYNGAS],
  },
  {
    stem: 'What does a business model explain?',
    options: {
      a: 'How a company creates, delivers and captures value',
      b: 'How a company competes in the market and differentiates itself',
      c: 'How a company files its annual tax returns',
      d: 'How a company schedules its maintenance shutdowns',
    },
    correct_option: 'a',
    explanation:
      'A business model explains how a company creates, delivers and captures value, defining the structure of the business, revenue sources and cost management. Competing in the market and differentiating is the role of a business strategy.',
    sources: [PH_12_MODELS],
  },
  {
    stem: 'Which of the following is listed as a challenge facing new biomass energy entrepreneurs?',
    options: {
      a: 'A statutory ceiling on the number of biomass plants per district',
      b: 'A prohibition on selling biomass pellets to industry',
      c: 'High initial investment costs for plants and processing units',
      d: 'A ban on importing biomass processing equipment',
    },
    correct_option: 'c',
    explanation:
      'Setting up biomass plants and processing units requires significant capital, so high initial investment costs are listed among the challenges, alongside raw material availability, regulatory hurdles, market competition and technology barriers.',
    sources: [PH_12_MODELS],
  },
  {
    stem: 'Management challenges in an emerging biomass MSME fall into which four areas?',
    options: {
      a: 'Financial, human resource, product and service development, and operations',
      b: 'Advertising, packaging, warehousing and retail',
      c: 'Surveying, drilling, refining and distribution',
      d: 'Research, patenting, licensing and franchising',
    },
    correct_option: 'a',
    explanation:
      'Entrepreneurs must overcome hurdles in financial management, human resource management, product and service development, and operations to ensure business success.',
    sources: [PH_13_CHALL],
  },
  {
    stem: 'What can non-compliance with permits and waste disposal regulations lead to?',
    options: {
      a: 'An automatic extension of the operating licence',
      b: 'Fines, legal actions and reputational damage',
      c: 'A reduction in the applicable rate of income tax',
      d: 'Mandatory transfer of the plant to a state agency',
    },
    correct_option: 'b',
    explanation:
      'A biomass enterprise must obtain necessary permits for biomass processing and emissions, comply with waste disposal regulations and adopt environmentally sustainable practices. Non-compliance can lead to fines, legal actions and reputational damage.',
    sources: [PH_13_COMPLY],
  },
].map((q) => ({ ...q, module_number: 1 }));

const WEIGHTAGE_COMPULSORY = [
  { nos_code: 'SGJ/N4102', nos_title: 'Introduce to Entrepreneurship and describes the basics of biomass energy', theory_marks: 23, practical_marks: 27, project_marks: 0, viva_marks: 0, total_marks: 50, weightage: 14 },
  { nos_code: 'SGJ/N4103', nos_title: 'Manage financial budget and developing business plans', theory_marks: 60, practical_marks: 40, project_marks: 0, viva_marks: 0, total_marks: 100, weightage: 28 },
  { nos_code: 'SGJ/N4104', nos_title: 'Utilize government schemes and perform financial management of the business', theory_marks: 35, practical_marks: 15, project_marks: 0, viva_marks: 0, total_marks: 50, weightage: 14 },
  { nos_code: 'SGJ/N4050', nos_title: 'Maintain Personal Health and Safety in Bioenergy manufacturing facility', theory_marks: 25, practical_marks: 25, project_marks: 0, viva_marks: 0, total_marks: 50, weightage: 14 },
  { nos_code: 'DGT/VSQ/N0102', nos_title: 'Employability Skills (60 Hours)', theory_marks: 20, practical_marks: 30, project_marks: 0, viva_marks: 0, total_marks: 50, weightage: 14 },
  { nos_code: 'Total', nos_title: '', theory_marks: 163, practical_marks: 137, project_marks: 0, viva_marks: 0, total_marks: 300, weightage: 84, is_total: true },
];

const WEIGHTAGE_ELECTIVES = {
  'Elective 1: Biomass Pellet Manufacturing': [
    { nos_code: 'SGJ/N4105', nos_title: 'Ensure Manufacturing of Biomass pellet', theory_marks: 25, practical_marks: 25, project_marks: 0, viva_marks: 0, total_marks: 50, weightage: 16 },
    { nos_code: 'Total', nos_title: '', theory_marks: 25, practical_marks: 25, project_marks: 0, viva_marks: 0, total_marks: 50, weightage: 16, is_total: true },
  ],
  'Elective 2: Ensure installation and operation of small biogas plant': [
    { nos_code: 'SGJ/N4106', nos_title: 'Ensure installation and operation of small biogas plant', theory_marks: 60, practical_marks: 40, project_marks: 0, viva_marks: 0, total_marks: 100, weightage: 16 },
    { nos_code: 'Total', nos_title: '', theory_marks: 60, practical_marks: 40, project_marks: 0, viva_marks: 0, total_marks: 100, weightage: 16, is_total: true },
  ],
};

const client = await McpClient.start('C:/cvc-mcp');
const log = (label, value) => console.log(`${label.padEnd(42)} ${value}`);
const step = (n, t) => console.log(`\n${'-'.repeat(72)}\n${n}. ${t}\n${'-'.repeat(72)}`);

console.log(`\nServer: ${client.serverInfo?.name} v${client.serverInfo?.version}`);
const tools = await client.listTools();
log('tools advertised', tools.length);

step(1, 'Preconditions');
const courses = await client.call('list_courses');
const bio = courses.courses.find((c) => c.course_id === 'biofuels');
for (const d of bio.documents) log(`  ${d.document_type} present/indexed`, `${d.present}/${d.indexed} (${d.chunk_count} chunks)`);

const timingCheck = await client.call('validate_timing_allocation', { course_id: 'biofuels' });
log('timing arithmetic exact', `${timingCheck.course_total_ok && timingCheck.all_modules_ok} (${timingCheck.computed_total_minutes} min)`);

step(2, 'Create draft for module 1 only');
const draft = await client.call('create_storyboard_draft', {
  course_id: 'biofuels',
  modules: [1],
  note: 'End-to-end authored run, module 1',
});
if (draft.__isError) throw new Error(`draft failed: ${draft.message}`);
const artifactId = draft.artifact_id;
log('artifact', `${artifactId} v${draft.version}`);
log('module 1 duration / chapter / NOS', `${draft.modules[0].duration_minutes} min / ch.${draft.modules[0].source_chapter} / ${draft.modules[0].nos_code}`);

const state = await client.call('get_storyboard', { artifact_id: artifactId, module_number: 1 });
const rowsByUnit = new Map(state.module.part_a.rows.map((r) => [r.unit_code, r]));
const partBRows = state.module.part_b.rows;
const slideIds = state.module.part_c.slides;

step(3, 'Submit authored content (client-generated, source-cited)');
const submit = await client.call('set_storyboard_content', {
  artifact_id: artifactId,
  base_version: state.version,
  module_number: 1,
  module_description:
    'This module introduces biofuels as a renewable energy source and the entrepreneurship ' +
    'required to build a bio-energy venture. It covers the definition of biofuels and their role ' +
    'in sustainable energy production, the difference between solid, liquid and gaseous biofuels, ' +
    'the concept of entrepreneurship and the steps of the entrepreneurial process from idea ' +
    'generation to investment harvesting, the distinction between a business model and a strategy, ' +
    'the management challenges facing MSMEs and startups, the significance of agro-residue waste ' +
    'as a resource, biomass energy conversion technologies, biomass procurement systems and their ' +
    'challenges, and how to conduct field surveys with farmers, aggregators and FPOs to assess ' +
    'agricultural residue availability.',
  module_description_sources: [PH_OUTCOMES, PH_11_INTRO, PH_12_CONCEPT],
  part_c_subtitle: 'Biofuel Fundamentals, the Entrepreneurial Process and Residue Procurement',
  part_a_rows: PART_A.map((r) => ({
    row_id: rowsByUnit.get(r.unit).row_id,
    activity_name: r.activity_name,
    interactive_description: r.interactive_description,
    correlation: r.correlation,
    performance_criteria: r.performance_criteria,
    sources: r.sources,
  })),
  lms_rows: LMS_ROWS,
  part_b_rows: PART_B.map((r) => ({
    row_id: partBRows[r.index].row_id,
    visual: r.visual,
    ...(r.gfx ? { gfx: r.gfx } : {}),
    audio: r.audio,
    sources: r.sources,
  })),
  slides: SLIDES.map((s) => ({
    slide_id: slideIds[s.index].slide_id,
    title: s.title,
    visual_cues: s.visual_cues,
    instructor_script: s.instructor_script,
    sources: s.sources,
  })),
  note: 'Module 1 authored from PH ch.1, FG ch.1 and QP SGJ/N4102',
});
if (submit.__isError) {
  console.log('SUBMIT FAILED:', JSON.stringify(submit, null, 2));
  await client.stop();
  process.exit(1);
}
log('committed version', submit.version);
log('changes applied', submit.changes_applied);

step(4, 'Validate');
const report = await client.call('validate_storyboard', { artifact_id: artifactId });
log('overall passed', report.passed);
log('errors / warnings', `${report.summary.errors} / ${report.summary.warnings}`);
log('content level passed', report.levels.content.passed);
log('timing level passed', report.levels.timing.passed);
log('structure level passed', report.levels.structure.passed);
for (const f of [...report.levels.content.findings, ...report.levels.timing.findings, ...report.levels.structure.findings]) {
  console.log(`   [${f.severity}] ${f.code} @ ${f.path}`);
  console.log(`        ${f.message.slice(0, 150)}`);
}

step('4b', 'Submit assessment blueprint + 10-question bank');
const afterContent = await client.call('get_storyboard', { artifact_id: artifactId });
const assess = await client.call('set_assessment_content', {
  artifact_id: artifactId,
  base_version: afterContent.version,
  questions: QUESTIONS,
  minimum_aggregate_pass_pct: 70,
  weightage_compulsory: WEIGHTAGE_COMPULSORY,
  weightage_electives: WEIGHTAGE_ELECTIVES,
  remarks: 'Total 30 hours (1,800 minutes) across 8 modules, per the Duration Breakdown.',
  note: 'Module 1 question bank',
});
if (assess.__isError) {
  console.log('ASSESSMENT FAILED:', JSON.stringify(assess, null, 2));
} else {
  log('version', assess.version);
  log('total questions', assess.total_questions);
  log('per module', JSON.stringify(assess.per_module));
  log('expected per module', assess.expected_per_module);
}

const report2 = await client.call('validate_storyboard', { artifact_id: artifactId });
log('validation after assessment', 'passed=' + report2.passed + ' errors=' + report2.summary.errors + ' warnings=' + report2.summary.warnings);
for (const f of report2.levels.content.findings) console.log('   [' + f.severity + '] ' + f.code + ' @ ' + f.path);

step(5, 'Render DOCX');
const render = await client.call('render_storyboard_docx', { artifact_id: artifactId });
if (render.__isError) {
  console.log('RENDER REFUSED:', render.message);
} else {
  log('docx', render.docx_path);
  log('size', `${(render.bytes / 1024).toFixed(1)} KB`);
  log('validation passed at render', render.validation_passed);
}

step(6, 'Incremental edit: change one slide only');
const before = await client.call('get_storyboard', { artifact_id: artifactId, module_number: 1 });
const untouchedBefore = JSON.stringify(before.module.part_a.rows);
const edit = await client.call('set_storyboard_content', {
  artifact_id: artifactId,
  base_version: before.version,
  module_number: 1,
  slides: [
    {
      slide_id: slideIds[3].slide_id,
      instructor_script:
        'Cast your votes now. The correct answer is anaerobic digestion, where microorganisms ' +
        'break down animal manure, food waste and sewage sludge in the absence of oxygen to ' +
        'generate a mixture of methane and carbon dioxide.',
      sources: [PH_11_GAS],
    },
  ],
  note: 'Simplified the poll debrief for beginners',
});
log('new version', edit.version);
const after = await client.call('get_storyboard', { artifact_id: artifactId, module_number: 1 });
log('part A untouched by slide edit', JSON.stringify(after.module.part_a.rows) === untouchedBefore);
log('slide 4 changed', after.module.part_c.slides[3].instructor_script !== before.module.part_c.slides[3].instructor_script);

step(7, 'History and rollback');
const history = await client.call('get_storyboard_history', { artifact_id: artifactId });
log('versions', history.versions.map((v) => v.version).join(', '));
log('change log entries', history.changes.length);
const rb = await client.call('rollback_storyboard', { artifact_id: artifactId, to_version: 2, reason: 'e2e check' });
log('rollback created version', rb.new_version);
const afterRb = await client.call('get_storyboard', { artifact_id: artifactId, module_number: 1 });
log('slide 4 restored to v2 text', afterRb.module.part_c.slides[3].instructor_script === before.module.part_c.slides[3].instructor_script);
const histAfter = await client.call('get_storyboard_history', { artifact_id: artifactId });
log('history preserved (no versions lost)', histAfter.versions.length === history.versions.length + 1);

step(8, 'Guard rails');
const badTiming = await client.call('modify_storyboard_timing', {
  artifact_id: artifactId,
  base_version: histAfter.artifact.current_version,
  module_number: 1,
  requested_minutes: 240,
});
log('conflicting timing refused', badTiming.__isError === true);
const crossCourse = await client.call('search_course_content', { course_id: 'solar-pv', query: 'anything' });
log('cross-course search refused', crossCourse.__isError === true);

const finalRender = await client.call('render_storyboard_docx', { artifact_id: artifactId });
log('final docx', finalRender.docx_path ?? finalRender.message);

console.log(`\nstdout protocol violations: ${client.stdoutViolations.length}`);
await client.stop();
