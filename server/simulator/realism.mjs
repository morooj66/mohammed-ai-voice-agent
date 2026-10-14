// Offline realism review of a recorded transcript (cues from ConversationRecorder).
// It does not judge audio; it flags phrasing the approved style guide rules out.
const BANNED = [
  'يرجى التزام الهدوء', 'أتفهم مشاعرك', 'أعتذر عن التجربة', 'سأقوم بإرشادك', 'هل أنت في موقع آمن', 'ابتعد عنه واطلب المساعدة',
  'سلامتك يا أخي', 'لا تشيل همها', 'ما لها داعي', 'لقد تعرضت', 'أشعر بالتوتر', 'أحتاج إلى إرشادات', 'مو عارف',
];
const MSA = ['لقد ', 'سوف ', 'سأقوم', 'يرجى', 'حاليًا', 'حاليا', 'هل أنت', 'أتفهم', 'يا أخي'];
const SYMPATHY = ['سلامتك', 'الحمد لله على السلامة', 'الحمد لله إنك بخير', 'آسف على', 'أتفهم'];
// Extra comforting phrases counted only for a crying caller (Khalid's evaluation is unchanged).
const DISTRESS_SYMPATHY = ['لا تخاف', 'أنا معك', 'خذ نفس'];
// One sympathy expression per call is allowed (approved style); two or more is flagged.
const count = (text, needle) => text.split(needle).length - 1;
// Khalid only: non-Najdi forms, assistant-like compliance, and claiming actions done mid-call.
const CUSTOMER_FLAGS = [
  ['non_najdi', /(^|[\s،.!؟])و?(شنو|بيقول|بيطلب|بيقولون|هل)([\s،.!؟]|$)/g],
  ['assistant_like', /(^|[\s،.!؟])و?(حاضر)([\s،.!؟]|$)/g],
  ['claims_action_done', /(^|[\s،.!؟])و?(صوّ?رت|شغّ?لت|بلّ?غت|اتصلت)([\s،.!؟]|$)/g],
];
const CUSTOMER_DIALECT_FLAGS = [
  ['السيارة الثانية معصبة', /(?:بس\s+|و\s+)?السيارة\s+الثانية\s+معص(?:ّب|ب|ّبة|بة)/],
  ['داير يتكلم معي', /داير(?:ة)?\s+يتكلم\s+معي/],
  ['لم أسأله', /لم\s+أسأله/],
  ['ما معي الورقات', /ما\s+معي\s+الورقات/],
  ['ما أدفع حاجة', /ما\s+أدفع\s+حاجة/],
];
const normalizeQuestion = s => s.replace(/[\u064b-\u065f\u0670ـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/\s+/g, ' ').trim();

// profile: 'najdi' (Khalid, default: unchanged rules) or 'non_native' (Raj: Najdi dialect rules do not apply to the
// caller; instead flag over-mixing with English and over-long lines; a human still reviews respectfulness).
// sympathyAllowance: comforting expressions allowed from Mohammed (Khalid: 1, unchanged; a crying caller: up to 3).
export function reviewTranscript(cues, { opening = '', profile = 'najdi', sympathyAllowance = 1 } = {}) {
  const najdi = profile === 'najdi';
  const issues = [];
  const agent = cues.filter((c) => c.speaker === 'agent'), customer = cues.filter((c) => c.speaker === 'customer');
  for (const c of cues) {
    // Egyptian possessive «بتاع…» (both speakers). Natural Saudi: «حق / حقت / حقتك».
    if (najdi || c.speaker === 'agent') for (const m of c.text.matchAll(/(^|[\s،.!؟])و?(بتاع(?:ة|ت|تك|تي|تها|ته|ك|ي|ه|ها|هم|كم)?)(?=[\s،.!؟]|$)/g)) issues.push({ id: c.id, rule: 'dialect_drift', detail: `${m[2]} (${c.speaker}) → حق / حقت / حقتك` });
    for (const b of BANNED) if (c.text.includes(b)) issues.push({ id: c.id, rule: 'banned_phrase', detail: b });
    for (const m of MSA) if (c.text.includes(m)) issues.push({ id: c.id, rule: 'formal_or_msa', detail: m.trim() });
  }
  if (najdi) for (const c of customer) for (const [rule, re] of CUSTOMER_FLAGS) for (const m of c.text.matchAll(re)) issues.push({ id: c.id, rule, detail: m[2] });
  if (!najdi) for (const c of customer) {
    const latin = (c.text.match(/[A-Za-z]+/g) || []).length;
    if (latin > 1) issues.push({ id: c.id, rule: 'english_heavy', detail: `${latin} English words (max 1)` });
    if (c.text.split(/\s+/).filter(Boolean).length > 30) issues.push({ id: c.id, rule: 'long_customer_line', detail: 'over 30 words' });
    if (/(^|[\s،.!؟])لا أحد/.test(c.text)) issues.push({ id: c.id, rule: 'persona_style', detail: 'لا أحد → مافي أحد' });
    for (const [rule, re] of CUSTOMER_FLAGS) if (rule === 'claims_action_done') for (const m of c.text.matchAll(re)) issues.push({ id: c.id, rule, detail: m[2] });
  }
  if (najdi) for (const c of customer) for (const [detail, re] of CUSTOMER_DIALECT_FLAGS) {
    const checked = detail === 'السيارة الثانية معصبة'
      ? c.text.replace(/الرجال\s+اللي\s+في\s+السيارة\s+الثانية\s+معص(?:ّب|ب)/, '')
      : c.text;
    if (re.test(checked)) issues.push({ id: c.id, rule: 'dialect_drift', detail });
  }
  const seenQuestions = new Set();
  for (const c of agent) {
    for (const q of c.text.split(/[؟?]/).slice(0, -1).map(normalizeQuestion).filter(Boolean)) {
      if (seenQuestions.has(q)) issues.push({ id: c.id, rule: 'repeated_question', detail: q });
      seenQuestions.add(q);
    }
  }
  const opens = customer.slice(1).map((c) => c.text.split(/\s+/).slice(0, 2).join(' '));
  for (const o of new Set(opens)) if (opens.filter((x) => x === o).length > 1) issues.push({ rule: 'repeated_opening', detail: o });
  const sympathyList = najdi ? SYMPATHY : [...SYMPATHY, ...DISTRESS_SYMPATHY];
  const sympathy = agent.reduce((n, c) => n + sympathyList.reduce((k, s) => k + count(c.text, s), 0), 0);
  if (sympathy > sympathyAllowance) issues.push({ rule: 'repeated_sympathy', detail: `${sympathy} sympathy expressions from Mohammed (allowed ${sympathyAllowance})` });
  const wallah = customer.reduce((n, c) => n + count(c.text, 'والله'), 0) - count(opening, 'والله');
  if (najdi && wallah > 1) issues.push({ rule: 'overused_wallah', detail: `${wallah} after the opening` });
  // Mohammed echoing Khalid: a long shared word run with the previous customer line.
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].speaker !== 'agent' || cues[i - 1].speaker !== 'customer') continue;
    const prev = cues[i - 1].text.split(/\s+/), words = cues[i].text.split(/\s+/);
    for (let k = 0; k + 4 <= words.length; k++) {
      const run = words.slice(k, k + 4).join(' ');
      if (prev.join(' ').includes(run)) { issues.push({ id: cues[i].id, rule: 'echoes_customer', detail: run }); break; }
    }
  }
  // Mohammed phrasing: «ما مشكلة» sounds unnatural (prefer «ما عليك» / «ولا يهمك»; «مو مشكلة» is fine);
  // «أبشر» more than twice per call sounds repetitive.
  for (const c of agent) if (/(^|[\s،.!؟])ما مشكلة/.test(c.text)) issues.push({ id: c.id, rule: 'unnatural_phrase', detail: 'ما مشكلة → ما عليك / ولا يهمك' });
  const abshir = agent.reduce((n, c) => n + count(c.text, 'أبشر'), 0);
  if (abshir > 2) issues.push({ rule: 'overused_abshir', detail: `${abshir} × أبشر (max 2)` });
  // Mohammed quality checks (heuristics; a human still reviews the transcript):
  // long turns, Najm/199033 before any insurance question, phone numbers read as hundreds,
  // and predictions about what Najm/Traffic/insurers will ask for or accept (not in the KB).
  let askedInsurance = false;
  for (const c of agent) {
    const words = c.text.split(/\s+/).filter(Boolean).length;
    if (words > 30 || (c.end - c.start) > 12) issues.push({ id: c.id, rule: 'long_agent_turn', detail: `${words} words, ${Number((c.end - c.start).toFixed(1))}s` });
    if (!askedInsurance && /نجم|تسعة تسعة، صفر ثلاثة ثلاثة|199033/.test(c.text)) issues.push({ id: c.id, rule: 'najm_before_insurance_check', detail: 'Najm step before asking about insurance' });
    // Only a QUESTION sentence about insurance counts (the greeting «المساعد لشركة التأمين.» does not).
    if (c.text.split(/(?<=[.!؟?])/).some((s) => /[؟?]\s*$/.test(s) && /تأمين|ساري/.test(s))) askedInsurance = true;
    if (/(مية|مائة|مئة|ألف)\s+و?\s*(تسعة|واحد|اثنين|ثلاثة|أربعة|خمسة|ستة|سبعة|ثمانية|صفر)/.test(c.text)) issues.push({ id: c.id, rule: 'number_not_digit_words', detail: 'phone number read as hundreds/thousands' });
    const m = c.text.match(/(بيطلبون|يطلبون|بيقبلون|يقبلون|ما يحتاجون|تقدر تجيبها بعدين|عادي ما معك)[^.،؟!]*/);
    if (m) issues.push({ id: c.id, rule: 'unsupported_prediction', detail: m[0].slice(0, 40) });
  }
  const gaps = [];
  for (let i = 1; i < cues.length; i++) gaps.push(Number((cues[i].start - cues[i - 1].end).toFixed(2)));
  const longGaps = gaps.map((g, i) => ({ after: cues[i].id, gap: g })).filter((g) => g.gap > 2.5);
  for (const g of longGaps) issues.push({ id: g.after, rule: 'long_pause', detail: `${g.gap}s` });
  return { issues, gaps, maxGap: gaps.length ? Math.max(...gaps) : 0 };
}
