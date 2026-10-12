/* HCPS Academy — Sample Lessons A and B, rebuilt as DATA (A2D Stage 2).
   The approved A0 mockups (boards 2A and 2B, reviewed 10 Oct 2026) re-expressed in the exact block format that the
   database accepts (M3 academy_author_check_blocks — test/academy-lesson.pg.test.js stores both samples through the real
   M3 operations to prove it). Used ONLY by the staff preview in the Command Center (academy-admin-api preview_sample):
   nothing here is a course record, a product fact or a question in the database, and nothing here is ever saved.

   Content rules kept from the mockups: Golden's facts as read from Golden sources on 10 Oct 2026, each with its source and
   date; details Golden has not confirmed carry the amber "awaiting" flag; health or benefit wording appears only as
   Golden's attributed words; NO Golden photography (every picture is a labelled placeholder until Angelo approves the
   specific files); discontinued models appear only as replacement guidance.

   The answer keys and explanations below never leave the server: the preview receives questions without them, and
   academy-admin-api preview_check grades one practice answer at a time. */
const G = 'golden-technologies';
const D = '2026-10-10';
const u = (n) => `5a3e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAT = 'Golden catalog LIT-BR-LC Rev. F 0526';
const SITE = 'https://goldentech.com/';

function fact(model, field, value, extra) {
  return Object.assign({ manufacturer_slug: G, model_code: model, field, value, unit: null, field_class: 'display', status: 'verified',
    source_url: SITE, source_label: CAT, verified_on: D, note: null, valid_to: null }, extra || {});
}
const awaiting = (note) => ({ status: 'awaiting_manufacturer', note });

/* ----------------------------- Sample Lesson A ----------------------------- */
const A_FACTS = [
  fact('PR401', 'name', 'Cambridge'), fact('PR510', 'name', 'Cloud Classic'), fact('PR511', 'name', 'Cloud+'), fact('PR519', 'name', 'Cloud Supreme with Twilight'),
  fact('PR401', 'comfort_zones', 1), fact('PR510', 'comfort_zones', 2), fact('PR511', 'comfort_zones', 4), fact('PR519', 'comfort_zones', 5),
  fact('PR401', 'positioning_system', 'One-zone lift chair'), fact('PR510', 'positioning_system', 'MaxiComfort two-zone'),
  fact('PR511', 'positioning_system', 'MaxiComfort four-zone'), fact('PR519', 'positioning_system', 'Twilight five-zone'),
  fact('PR401', 'adds', 'Lift and recline, lower body'), fact('PR510', 'adds', 'Backrest moves independently of the seat'),
  fact('PR511', 'adds', 'Power headrest and power lumbar'), fact('PR519', 'adds', 'Twilight tilt of the whole seat'),
  fact('PR401', 'hand_control', 'Two-button'), fact('PR510', 'hand_control', 'AutoDrive'), fact('PR511', 'hand_control', 'AutoDrive'), fact('PR519', 'hand_control', 'AutoDrive'),
  fact('PR401', 'presets', 'None'), fact('PR510', 'presets', 'ZG, Home, TV, Sleep'), fact('PR511', 'presets', 'ZG, Home, TV, Sleep'), fact('PR519', 'presets', 'ZG+, Home, TV, Rejuv'),
  fact('PR517', 'comfort_zones', '4 or 5 (page lists both)', awaiting('The spec table says four zones but the feature list names five.')),
  fact('PR104', 'hand_control', null, Object.assign(awaiting('Its hand control is not named on its page or sell sheet.'), { source_label: `${CAT} and the PR104 page` })),
];
const A_QUESTIONS = [
  { id: u(101), use: 'practice', status: 'active', kind: 'single', prompt: 'Which Comfort Zone is Golden’s patented Twilight tilt?',
    choices: [{ id: 'a', text: 'Zone 2' }, { id: 'b', text: 'Zone 4' }, { id: 'c', text: 'Zone 5' }, { id: 'd', text: 'Zone 3' }],
    answer_key: 'c', explanation: 'Zone 5 is the Twilight tilt. Only five-zone chairs have it.', objective_tags: ['comfort-zones'] },
  { id: u(102), use: 'practice', status: 'active', kind: 'single', prompt: 'A customer’s AutoDrive control has a Rejuv button. How many zones does the chair have?',
    choices: [{ id: 'a', text: 'Two' }, { id: 'b', text: 'Four' }, { id: 'c', text: 'Five' }, { id: 'd', text: 'One' }],
    answer_key: 'c', explanation: 'Golden puts Rejuv on five-zone controls only. Two- and four-zone controls have Sleep instead.', objective_tags: ['autodrive-presets'] },
  { id: u(103), use: 'practice', status: 'active', kind: 'single', prompt: 'Golden confirms how Comfort Zones relate to motors. How many motors does a four-zone chair have?',
    choices: [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }, { id: 'c', text: 'Four' }, { id: 'd', text: 'Five' }],
    answer_key: 'c', explanation: 'Each zone has its own motor, so a four-zone chair has four motors and a five-zone Twilight chair has five.', objective_tags: ['comfort-zones'] },
  { id: u(104), use: 'practice', status: 'active', kind: 'single', prompt: 'Which of these current models is a one-zone chair with a two-button control?',
    choices: [{ id: 'a', text: 'PR511 Cloud+' }, { id: 'b', text: 'PR118 Elara' }, { id: 'c', text: 'PR510 Cloud Classic' }, { id: 'd', text: 'PR750 EZ Sleeper Slim' }],
    answer_key: 'b', explanation: 'The PR118 Elara is one of three one-zone chairs, with the PR531 Comforter and PR401 Cambridge.', objective_tags: ['current-lineup'] },
];
const A_BLOCKS = [
  { kind: 'objectives', items: [
    'Explain what each of Golden’s five Comfort Zones adjusts.',
    'Tell apart one-zone, MaxiComfort two- and four-zone, and five-zone Twilight chairs, and name a current model for each.',
    'Match the AutoDrive preset positions to the chairs that have them.',
    'Recommend a positioning system from what a customer tells you.'] },
  { kind: 'text', heading: 'What a Comfort Zone is', body:
    'Each Comfort Zone is an independently controlled seating region with its own motor: Golden confirms a one-zone chair has one motor, a two-zone chair two, a four-zone chair four and a five-zone chair five.\n\n' +
    'Every Golden lift chair has Zone 1, each step up adds zones, and the zone count is the quickest way to explain how two chairs differ.\n\n' +
    '- **MaxiComfort** is Golden’s patented positioning. Zone 1 is the four-way motion of the seat. With Zone 2, the backrest moves independently while the seat box moves with it.\n' +
    '- **Twilight** adds Zone 5, a tilting motion of the whole seat. Every five-zone chair in the current lineup has Twilight.' },
  { kind: 'quote', text: 'a patented five-motor system', manufacturer_slug: G, source_label: 'Golden FAQ, describing Twilight', source_url: SITE, source_date: D },
  { kind: 'image', placeholder: 'Approved by Golden; HCPS-hosted file to be added', alt: 'Golden Comfort Zones diagram showing the five zones on a lift chair', caption: 'Golden Comfort Zones diagram' },
  { kind: 'explorer', style: 'cards', title: 'The five Comfort Zones', items: [
    { title: 'Zone 1 · Lower body', body: 'Golden describes Zone 1 as the patented four-way motion of the seat: the seat box and footrest move to support the lower body. Every Golden lift chair has this zone.' },
    { title: 'Zone 2 · Upper body', body: 'Zone 2 is the backrest moving independently, combined with the motion seat box. Two-zone and higher chairs have it.' },
    { title: 'Zone 3 · Headrest', body: 'Zone 3 is the upward motion of the adjustable headrest, supporting the head, neck and shoulders. Four- and five-zone chairs have it.' },
    { title: 'Zone 4 · Lumbar', body: 'Zone 4 is adjustable lumbar support for the lower back. Four- and five-zone chairs have it.' },
    { title: 'Zone 5 · Twilight tilt', body: 'Zone 5 is the tilting motion of Golden’s patented Twilight technology. Only five-zone chairs have it.' }] },
  { kind: 'explorer', style: 'tabs', title: 'Which system, which chairs', items: [
    { title: '1-Zone', body: 'One motor. Two-button up and down control. Current chairs: PR531 Comforter, PR401 Cambridge, PR118 Elara.' },
    { title: '2-Zone MaxiComfort', body: 'Two motors. AutoDrive, two-zone layout. Current chairs: PR510 Cloud Classic, PR535 Comforter with MaxiComfort, PR766 Relaxer, PR104 Halo (its control is awaiting Golden confirmation).' },
    { title: '4-Zone MaxiComfort', body: 'Four motors. AutoDrive, four-zone layout. Current chairs: PR511 Cloud+, PR517 Cloud Medium/Large (zone count awaiting Golden), PR750 EZ Sleeper Slim, PR442 Rhea, PR446 Dione, PR448 Titan.' },
    { title: '5-Zone Twilight', body: 'Five motors. AutoDrive, five-zone layout. Current chairs: PR519 Cloud Supreme, PR527 Cloud Elite, PR525 Cloud+ Luxe, PR761 EZ Sleeper, PR764 EZ Sleeper Slim, PR447 Rhea, PR449 Titan, each with Twilight.' }] },
  { kind: 'fact', manufacturer_slug: G, model_code: 'PR517', field: 'comfort_zones', label: 'Comfort Zones on the PR517 Cloud Medium/Large' },
  { kind: 'explorer', style: 'tabs', title: 'AutoDrive preset positions', items: [
    { title: 'ZG', body: 'Zero Gravity. Golden describes it as a supportive, weightless-feeling position for relaxing or napping. On all three AutoDrive layouts (two-, four- and five-zone).' },
    { title: 'HOME', body: 'Returns the chair to a seated position (Golden’s AutoDrive page calls it Sit). The back arrows can then bring the back further forward, for example for eating. On all three layouts.' },
    { title: 'TV', body: 'Raises the seat box and footrest with the back fully upright. On all three layouts.' },
    { title: 'Rejuv', body: 'Golden describes it as elevating the legs without lowering the head below the heart. On the five-zone AutoDrive layout only.' },
    { title: 'Sleep', body: 'A flat, mattress-like position. On the two- and four-zone AutoDrive layouts only.' }] },
  { kind: 'fact', manufacturer_slug: G, model_code: 'PR104', field: 'hand_control', label: 'Hand control on the PR104 Halo' },
  { kind: 'video', placeholder: 'Golden’s AutoDrive hand control video: linked from Golden, not copied (link to be added after approval)', caption: 'Golden’s official videos are linked, not copied.' },
  { kind: 'comparison', title: 'How the technologies compare', manufacturer_slug: G, models: ['PR401', 'PR510', 'PR511', 'PR519'], fields: [
    { field: 'comfort_zones', label: 'Zones' }, { field: 'positioning_system', label: 'System' }, { field: 'adds', label: 'What it adds' },
    { field: 'hand_control', label: 'Hand control' }, { field: 'presets', label: 'Presets' }] },
  { kind: 'callout', tone: 'tip', body: 'Demo top-down: seat the customer in a Twilight chair first, then let what they tell you choose the system.' },
  { kind: 'scenario', prompt: 'Mrs. Alvarez reads in her recliner every evening and naps in it on weekends. She says her current chair “doesn’t hold my head up when I lean back” and she would “love to put her feet up higher”. Her budget is flexible. Following the top-down method, you have already shown her a Twilight chair. Which system do you recommend she compares it with?', choices: [
    { id: 'a', text: 'A one-zone lift chair such as the PR401 Cambridge', feedback: 'Not the best fit. One zone has no headrest support, which is her main complaint.', best: false },
    { id: 'b', text: 'A two-zone MaxiComfort chair such as the PR510 Cloud Classic', feedback: 'Closer, because the backrest moves on its own, but two zones still have no power headrest.', best: false },
    { id: 'c', text: 'A four-zone MaxiComfort chair such as the PR511 Cloud+', feedback: 'Good choice. Zones 3 and 4 give her the power headrest and lumbar she is asking for. Let her try both: if the Twilight tilt is what she enjoys, the five-zone chair is the upgrade; if not, four zones meet her needs.', best: true }] },
  { kind: 'check', question_ids: A_QUESTIONS.map(q => q.id) },
  { kind: 'takeaways', items: [
    'Zones build up, one motor each: 1 lower body, 2 upper body, 3 headrest, 4 lumbar, 5 Twilight tilt.',
    'The current lineup has three one-zone, four two-zone, six four-zone and seven five-zone Twilight chairs.',
    'Rejuv is on five-zone controls; Sleep is on two- and four-zone controls.',
    'Demo top-down: start with Twilight, then let the customer’s needs choose the system.'] },
];

/* ----------------------------- Sample Lesson B ----------------------------- */
const P = { PR519: 'https://goldentech.com/product/lift-recliners/cloud-supreme-with-twilight/', PR527: 'https://goldentech.com/product/lift-recliners/cloud-elite-with-twilight-nirvana/',
            PR525: 'https://goldentech.com/product/lift-recliners/cloud-plu-twilight/', PR511: 'https://goldentech.com/product/lift-recliners/cloud-plus/' };
const page = (m) => ({ source_url: P[m], source_label: `Golden product page, ${m}` });
const SELL511 = { source_url: P.PR511, source_label: 'PR511 sell sheet (Rev. A 021025)' };
const ROWS_B = {
  name: ['Cloud Supreme with Twilight', 'Cloud Elite with Twilight & Nirvana', 'Cloud+ Luxe with Twilight', 'Cloud+'],
  positioning: ['5-Zone Twilight', '5-Zone Twilight', '5-Zone Twilight', '4-Zone MaxiComfort'],
  twilight_tilt: [true, true, true, false],
  zg_plus: [true, true, ['Not listed', 'Not on its product page.'], 'Not listed'],
  power_headrest: ['Standard', 'Standard', ['Not listed', 'Not on its product page.'], 'Standard'],
  power_lumbar: ['Standard', 'Standard', 'Standard', 'Standard'],
  sizes: ['Small/Medium, Medium/Large', 'Small/Medium, Medium/Large', 'Small, Medium, Large', 'Small, Medium, Large, Medium/Wide'],
  seat_dimensions: ['23" × 19" × 19.5"', '23.5" × 20.5" × 19.5"', '23" × 19" × 20"', 'Width: S/M 23", L 25", MXW 29"'],
  weight_capacity: ['400 lb', '400 lb', '400 lb', 'S/M/L 400 lb; Medium/Wide 600 lb'],
  battery_backup: [['Yes', 'Battery backup type is not stated.'], 'Lithium-ion', 'Lithium-ion', 'Lithium-ion'],
  heat_vibrating_massage: ['Optional', 'Optional', 'Optional', 'Not offered'],
  nirvana_air_massage: ['Not offered', ['In the name', 'Nirvana is in the name but the page lists it as an option.'], 'Optional, with HeatWave', 'Optional, with HeatWave'],
  standard_fabrics: ['Tucker: Calypso, Camel, Hazelnut, Shiraz, Sterling', 'Ashton: Ink, Sand, Slate, Spa, Stone', 'Tucker: Calypso, Camel, Hazelnut, Shiraz, Sterling', 'Tucker: Calypso, Camel, Hazelnut, Shiraz, Sterling'],
};
const B_MODELS = ['PR519', 'PR527', 'PR525', 'PR511'];
const B_FACTS = [];
for (const [field, vals] of Object.entries(ROWS_B)) {
  vals.forEach((v, i) => {
    const m = B_MODELS[i];
    const src = (m === 'PR511' && (field === 'weight_capacity' || field === 'seat_dimensions' || field === 'sizes')) ? SELL511 : page(m);
    if (Array.isArray(v)) B_FACTS.push(fact(m, field, v[0], Object.assign({}, src, awaiting(v[1]))));
    else B_FACTS.push(fact(m, field, v, src));
  });
}
B_FACTS.push(fact('PR511', 'weight_capacity_medium_wide', 600, Object.assign({ unit: 'lb' }, SELL511)));
const B_QUESTIONS = [
  { id: u(201), use: 'practice', status: 'active', kind: 'single', prompt: 'Which of the four featured Clouds is four-zone MaxiComfort rather than Twilight?',
    choices: [{ id: 'a', text: 'PR519' }, { id: 'b', text: 'PR527' }, { id: 'c', text: 'PR525' }, { id: 'd', text: 'PR511' }],
    answer_key: 'd', explanation: 'The PR511 Cloud+ is four-zone MaxiComfort. The other three are five-zone Twilight chairs.', objective_tags: ['cloud-family'] },
  { id: u(202), use: 'practice', status: 'active', kind: 'single', prompt: 'Which Cloud is shown in Ashton fabrics as standard?',
    choices: [{ id: 'a', text: 'PR511 Cloud+' }, { id: 'b', text: 'PR527 Cloud Elite' }, { id: 'c', text: 'PR519 Cloud Supreme' }, { id: 'd', text: 'PR525 Cloud+ Luxe' }],
    answer_key: 'b', explanation: 'The PR527 is shown in Ashton (Ink, Sand, Slate, Spa, Stone). The others are shown in Tucker.', objective_tags: ['cloud-family'] },
  { id: u(203), use: 'practice', status: 'active', kind: 'single', prompt: 'What does Golden’s sell sheet give for the PR511 Medium/Wide?',
    choices: [{ id: 'a', text: '400 lb, 25" seat' }, { id: 'b', text: '500 lb, 27" seat' }, { id: 'c', text: '600 lb, 29" seat' }, { id: 'd', text: '600 lb, 27" seat' }],
    answer_key: 'c', explanation: 'The PR511 sell sheet (Rev. A 021025) lists Medium/Wide at 600 lb with a 29" seat. Capacity depends on the model, not just the size code.', objective_tags: ['fit-and-capacity'] },
];
const B_BLOCKS = [
  { kind: 'objectives', items: [
    'Name the four featured Cloud models and what separates them.',
    'State each model’s sizes, and which Cloud has a 600 lb size.',
    'Match a customer’s needs to the right Cloud and explain why.',
    'Demonstrate the family top-down, from Twilight to MaxiComfort.'] },
  { kind: 'text', heading: 'One family, two positioning systems', body:
    'Golden’s Cloud family shares one look and splits by positioning. Three Clouds are five-zone Twilight chairs: the **PR519 Cloud Supreme**, the **PR527 Cloud Elite** and the **PR525 Cloud+ Luxe**.\n\n' +
    'The **PR511 Cloud+** is a four-zone MaxiComfort chair with a power headrest and lumbar but no Twilight tilt, and it is the only one of the four with a wide, 600 lb size.\n\n' +
    'If a customer asks about the older PR515 Cloud with Twilight: Golden has discontinued it and names the PR519 Cloud Supreme as its replacement.' },
  { kind: 'image', placeholder: 'Golden photo approved; HCPS-hosted file to be added', alt: 'The four featured Golden Cloud lift chairs shown side by side', caption: 'The Cloud family' },
  { kind: 'explorer', style: 'cards', title: 'The four featured Clouds', items: [
    { title: 'PR519 Cloud Supreme with Twilight', body: 'Five-zone Twilight with ZG+, power headrest and lumbar, in two hybrid sizes. Heat and vibrating massage and HeatWave are optional. A strong first chair for a top-down demo.' },
    { title: 'PR527 Cloud Elite with Twilight & Nirvana', body: 'Five-zone Twilight with the widest seat of the three Twilight Clouds (23.5"), Ashton fabrics, a lithium-ion battery and Nirvana air massage.' },
    { title: 'PR525 Cloud+ Luxe with Twilight', body: 'Five-zone Twilight in three single sizes (Small, Medium, Large), with Nirvana with HeatWave as an option.' },
    { title: 'PR511 Cloud+', body: 'Four-zone MaxiComfort with power headrest and lumbar and no Twilight tilt. Four sizes, including a Medium/Wide rated 600 lb with a 29" seat on Golden’s sell sheet.' }] },
  { kind: 'comparison', title: 'Side by side', manufacturer_slug: G, models: B_MODELS, fields: [
    { field: 'positioning', label: 'Positioning' }, { field: 'twilight_tilt', label: 'Twilight tilt' }, { field: 'zg_plus', label: 'ZG+' },
    { field: 'power_headrest', label: 'Power headrest' }, { field: 'power_lumbar', label: 'Power lumbar' }, { field: 'sizes', label: 'Sizes' },
    { field: 'seat_dimensions', label: 'Seat W × D × H' }, { field: 'weight_capacity', label: 'Weight capacity' }, { field: 'battery_backup', label: 'Battery backup' },
    { field: 'heat_vibrating_massage', label: 'Heat and vibrating massage' }, { field: 'nirvana_air_massage', label: 'Nirvana air massage' }, { field: 'standard_fabrics', label: 'Standard fabrics' }] },
  { kind: 'text', heading: 'Sizes and fit', body:
    '- **PR519 and PR527** come in two hybrid sizes: Small/Medium and Medium/Large.\n' +
    '- **PR525** comes in Small, Medium and Large.\n' +
    '- **PR511** comes in Small, Medium, Large and Medium/Wide. Golden’s sell sheet gives seat widths of 23" (Small and Medium), 25" (Large) and 29" (Medium/Wide).' },
  { kind: 'fact', manufacturer_slug: G, model_code: 'PR511', field: 'weight_capacity_medium_wide', label: 'PR511 Medium/Wide weight capacity' },
  { kind: 'callout', tone: 'ask_manufacturer', body: 'Per-size seat dimensions and capacities for the PR519, PR527 and PR525 are awaiting Golden: their pages publish one set of figures.' },
  { kind: 'steps', title: 'Fit the customer: the three checks', items: [
    'Head and neck supported by the backrest.', 'A hand’s gap at the hips.', 'Feet flat on the floor.'], source_label: 'HCPS fitting method (Module 7)' },
  { kind: 'explorer', style: 'tabs', title: 'Cloud finder: what the customer tells you', items: [
    { title: 'Loves the tilt', body: 'Start with the PR519 Cloud Supreme with Twilight: five zones, ZG+ and Twilight without paying for massage they don’t want. If they want Nirvana air massage, show the PR527 or PR525.' },
    { title: 'Needs a wider seat', body: 'Of these four, only the PR511 has a Medium/Wide size: 29" seat and 600 lb per Golden’s sell sheet. It is four-zone MaxiComfort, so there is no Twilight tilt. None of the Twilight Clouds publishes a capacity above 400 lb; ask Golden before promising one.' },
    { title: 'Not sure about the tilt', body: 'Demo top-down: let them feel the Twilight tilt first (PR527 or PR519), then the four-zone PR511. Their reaction to the tilt decides the family branch.' },
    { title: 'Doesn’t want the tilt', body: 'The PR511 Cloud+: four-zone MaxiComfort with power headrest and lumbar, in four sizes. If they want heat and vibrating massage, the PR511 does not offer it.' }] },
  { kind: 'callout', tone: 'caution', body: 'Stay with Golden’s words. Describe features, not health outcomes. If a customer asks about a condition, ask about their comfort and needs, and suggest they speak with their clinician.' },
  { kind: 'document', placeholder: 'Golden document: link to be added after approval', title: 'PR511 Cloud+ sell sheet (Rev. A 021025)' },
  { kind: 'scenario', prompt: 'Mr. Okafor is a big man who needs a wider seat than your Medium floor model. He liked the power headrest on the Cloud Supreme but says the tilt “isn’t for me”. Which Cloud do you configure?', choices: [
    { id: 'a', text: 'PR519 Cloud Supreme, Medium/Large', feedback: 'He has ruled out the tilt, and the Medium/Large doesn’t solve the wider seat he needs.', best: false },
    { id: 'b', text: 'PR511 Cloud+, Medium/Wide', feedback: 'Right. The Medium/Wide gives a 29" seat and 600 lb capacity per Golden’s sell sheet, keeps the power headrest and lumbar he liked, and drops the tilt. Still run the three fitting checks.', best: true },
    { id: 'c', text: 'PR525 Cloud+ Luxe, Large', feedback: 'It is a Twilight chair, and Golden publishes 400 lb for it. Not the match for what he told you.', best: false }] },
  { kind: 'check', question_ids: B_QUESTIONS.map(q => q.id) },
  { kind: 'takeaways', items: [
    'PR519, PR527 and PR525 are five-zone Twilight chairs. The PR511 is four-zone MaxiComfort.',
    'The PR511 Medium/Wide is the 600 lb Cloud of the four, with a 29" seat.',
    'The PR527 stands out for its Ashton fabrics and Nirvana. The PR525 offers three single sizes.',
    'Demo top-down, then let fit, tilt preference and massage choice decide.'] },
];

/* The course outline both samples sit in (the approved 11-module Golden outline). */
const OUTLINE_TITLES = ['Welcome', 'Golden Technologies today', 'Lift chairs vs power recliners', 'Comfort Zones and positioning', 'AutoDrive and hand controls',
  'The current lineup', 'Fitting, sizing and capacity', 'Fabrics, options, upgrades', 'The consultation', 'Questions and service basics', 'Closing with confidence'];
function outline(currentModule, currentLesson) {
  return OUTLINE_TITLES.map((t, i) => ({ position: i + 1, title: t,
    lessons: i + 1 === currentModule ? [{ id: currentLesson.id, position: 1, title: currentLesson.title }] : [] }));
}

const COURSE = { title: 'Golden Lift Chair Sales Certification', manufacturer_slug: G, issuer: 'hcps' };
const SAMPLES = {
  A: { key: 'A', label: 'Sample Lesson A — Comfort Zones and positioning', module: { position: 4, title: 'Comfort Zones and positioning' },
       lesson: { id: u(1), position: 1, title: 'Golden Comfort Zones and positioning technologies', est_minutes: 15, blocks: A_BLOCKS },
       facts: A_FACTS, questions: A_QUESTIONS },
  B: { key: 'B', label: 'Sample Lesson B — The Golden Cloud family', module: { position: 6, title: 'The current lineup' },
       lesson: { id: u(2), position: 1, title: 'The Golden Cloud family: choosing the right Cloud', est_minutes: 15, blocks: B_BLOCKS },
       facts: B_FACTS, questions: B_QUESTIONS },
};
for (const s of Object.values(SAMPLES)) { s.course = COURSE; s.outline = outline(s.module.position, s.lesson); }

module.exports = { SAMPLES, MANUFACTURERS: { [G]: 'Golden' } };
